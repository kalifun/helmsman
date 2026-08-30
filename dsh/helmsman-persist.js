// [helmsman] 持久化插件：SQLite 元数据（v1 storage.ts 搬迁）+ 启动投影重建（v1 recovery.ts 搬迁）。
// 职责：
//   1. 持有 Storage（better-sqlite3）：项目/卡/执行快照/设置/KB/指标/审批/Profile/策略 落盘
//   2. 启动时从 JSONL 会话日志重放（recoverStore）重建投影 → 注入 helmsmanBoard
//   3. 提供服务 helmsmanStorage：给 helmsman-api/kb/approval 等插件读写持久化
// DB 路径：HELMSMAN_DB env 或 dsh/.helmsman.db（引擎进程内）。
import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { Storage } from './helmsman-storage.js'
import {
  newProjection,
  newTaskState,
  ensureProject,
  ensureCard,
  registerSession,
  foldSession,
} from './helmsman-projection.js'

export const name = 'helmsman-persist'
export const inject = ['sessions', 'helmsmanBoard']

export function apply(ctx) {
  const dbPath = process.env.HELMSMAN_DB ?? resolve(process.cwd(), '.helmsman.db')
  const sessionsRoot = process.env.HELMSMAN_SESSIONS_ROOT ?? resolve(process.cwd(), '.sessions')
  const storage = new Storage(dbPath)
  const board = ctx.get('helmsmanBoard')
  console.log(`[helmsman-persist] SQLite 就绪：${dbPath}`)

  // ---------- 启动重建投影（v1 recovery.ts 语义） ----------
  const proj = newProjection()

  // 从 SQLite 加载项目 → 建投影
  for (const p of storage.loadProjects()) {
    ensureProject(proj, p.id, p.name, p.path)
  }
  // 从 SQLite 加载卡 → 建卡
  for (const c of storage.loadAllCards()) {
    ensureCard(proj, c.project_id, {
      id: c.id,
      title: c.title,
      description: c.description,
      kind: c.kind,
      milestone: c.milestone,
      criteria: c.criteria,
      deps: c.deps ?? [],
      budget: c.budget ?? null,
      created_at: c.created_at,
    })
  }
  // 执行 → session→卡 映射（重启恢复的权威映射）
  const cardOfSession = new Map()
  for (const e of storage.loadAllExecutions()) {
    const card = storage.getCard(e.card_id)
    cardOfSession.set(e.id, {
      projectId: card?.project_id ?? 'default',
      meta: { id: e.card_id, title: '', description: '', kind: 'task', milestone: null, criteria: null, deps: [], created_at: e.created_at },
      executionCreatedAt: e.created_at,
    })
  }

  // 重放 JSONL 会话日志重建投影（中断的 Running → Failed 等语义与 v1 一致）
  let restored = 0
  try {
    const result = recoverStore(sessionsRoot, proj, null, cardOfSession)
    restored = result.restored
  } catch (e) {
    console.warn(`[helmsman-persist] 启动重放失败（忽略，继续）:`, e?.message ?? e)
  }

  // 简单会话恢复（对齐 v1 index.ts 275-290）：chat_sessions 标记的会话
  // 从隐式卡挪到项目 chats（独立会话不进看板），并修正投影映射。
  for (const pid of Object.keys(proj.projects)) {
    const p0 = proj.projects[pid]
    for (const sid of storage.listChats(pid)) {
      const cardId = proj.sessionCard[sid]
      const t = cardId ? p0.cards[cardId]?.executions[sid] : p0.chats[sid]
      if (!t) continue
      if (cardId) {
        const card = p0.cards[cardId]
        if (card) {
          delete card.executions[sid]
          card.exec_order = card.exec_order.filter((x) => x !== sid)
          // chat 会话的隐式卡（execs 空 = 仅承载此会话）无条件清掉
          if (card.exec_order.length === 0) delete p0.cards[cardId]
        }
        p0.chats[sid] = t
        proj.sessionCard[sid] = ''
      }
    }
  }

  // 把恢复的投影合并进 board（含 fold 好的执行状态，不丢 Done/Running 等）
  for (const [id, p] of Object.entries(proj.projects)) {
    board.ensureProject(id, p.name, p.path)
    for (const [cid, c] of Object.entries(p.cards)) {
      board.ensureCard(id, {
        id: cid, title: c.title, description: c.description, kind: c.kind,
        milestone: c.milestone, criteria: c.criteria, deps: c.deps ?? [],
        budget: c.budget ?? null, created_at: c.created_at,
      })
    }
  }
  for (const [sid, pid] of Object.entries(proj.sessionProject)) {
    board.registerSession(sid, pid, proj.sessionCard[sid] ?? '')
  }
  // 复制折叠好的 TaskState 状态（board 的 registerSession 只建空壳，这里覆盖为恢复值）
  const boardProj = board.projection
  for (const [sid, pid] of Object.entries(proj.sessionProject)) {
    const cardId = proj.sessionCard[sid]
    const srcProj = proj.projects[pid]
    if (!srcProj) continue
    let srcTask
    if (cardId) srcTask = srcProj.cards[cardId]?.executions?.[sid]
    else srcTask = srcProj.chats?.[sid]
    if (!srcTask) continue
    const dstProj = boardProj.projects[pid]
    if (!dstProj) continue
    let dstTask
    if (cardId) {
      const dstCard = dstProj.cards[cardId]
      if (!dstCard) continue
      dstTask = dstCard.executions[sid] ?? (dstCard.executions[sid] = dstCard.executions[sid] || board.registerSession(sid, pid, cardId), dstCard.executions[sid])
    } else {
      dstTask = dstProj.chats[sid] ?? (dstProj.chats[sid] = newTaskState(sid))
    }
    if (dstTask) Object.assign(dstTask, srcTask)
  }
  console.log(`[helmsman-persist] 投影重建完成：${Object.keys(proj.projects).length} 项目，${restored} 会话重放`)

  // 提供服务：给 helmsman-api/kb/approval 等插件读写持久化
  ctx.provide('helmsmanStorage', {
    get storage() { return storage },
  })

  // 注意：新会话的元数据落盘由各业务插件负责（api 建项目/卡时 upsert，board fold 后 upsert 执行快照）
  console.log('[helmsman-persist] 持久化服务已提供：helmsmanStorage')
}

// ---------- v1 recovery.ts 的 recoverStore 迁移（TS→JS） ----------

/** 重放 .sessions/ 重建投影。返回恢复会话数。 */
function recoverStore(root, proj, defaultProject, cardOfSession) {
  const eventsBySid = new Map()
  const regs = []
  const implicitCards = new Map()
  let restored = 0

  for (const file of walk(root)) {
    const { headerCwd, headerId, headerCreated, events } = readLog(file)
    const sessionId = headerId ?? basename(dirname(file))
    if (!sessionId || events.length === 0) continue

    const cwd = (headerCwd ?? '').replace(/\/+$/, '')
    const rcHint = cardOfSession.get(sessionId)
    let projectId
    if (rcHint) {
      projectId = rcHint.projectId
    } else {
      projectId = projectIdForSessionCwd(cwd, sessionId, Object.values(proj.projects).map((p) => ({ id: p.id, path: p.path })), defaultProject)
    }
    const repoCwd = repoRootFromCwd(cwd)
    const name = basename(repoCwd) || projectId
    if (!proj.projects[projectId]) {
      ensureProject(proj, projectId, name, repoCwd || cwd)
    }

    let cardId
    let createdAt
    const rc = cardOfSession.get(sessionId)
    if (rc) {
      cardId = rc.meta.id
      createdAt = rc.executionCreatedAt
    } else {
      cardId = sessionId
      implicitCards.set(cardId, projectId)
      createdAt = headerCreated ?? 0
    }
    regs.push({ sid: sessionId, projectId, cardId, createdAt })
    eventsBySid.set(sessionId, events)
    restored += 1
  }

  // 有执行记录但本次无日志的会话：卡仍进看板，执行以 Pending 占位。
  for (const [sid, rc] of cardOfSession) {
    if (!eventsBySid.has(sid)) {
      regs.push({ sid, projectId: rc.projectId, cardId: rc.meta.id, createdAt: rc.executionCreatedAt })
    }
  }

  // 按（卡, 创建时间）排序 → 注册顺序 = 执行代次顺序（确定性）。
  regs.sort((a, b) => (a.cardId === b.cardId ? a.createdAt - b.createdAt : a.cardId < b.cardId ? -1 : 1))
  for (const r of regs) {
    const rc = cardOfSession.get(r.sid)
    if (rc) {
      ensureCard(proj, rc.projectId, rc.meta)
      registerSession(proj, r.sid, rc.projectId, rc.meta.id)
    } else {
      ensureCard(proj, r.projectId, {
        id: r.cardId, title: '', description: '', kind: 'task',
        milestone: null, criteria: null, deps: [], created_at: r.createdAt,
      })
      registerSession(proj, r.sid, r.projectId, r.cardId)
    }
  }

  // 折叠事件（foldSession 已对齐官方：文本只从 assistant/message 提取，
  // chunk/text-chunks 为中间态不累积，实时与重放同一路径）。
  for (const [sid, events] of eventsBySid) {
    for (const ev of events) foldSession(proj, sid, ev)
    const cardId = proj.sessionCard[sid]
    const pid = proj.sessionProject[sid]
    const card = pid ? proj.projects[pid]?.cards[cardId] : undefined
    const t = card?.executions[sid]
    if (t) {
      t.recovered = true
      if (implicitCards.has(cardId) && !card.title) {
        card.title = t.title ?? sid
      }
      // 中断检测：恢复后仍 Running → 上次进程被中断；标记 Failed
      if (t.status === 'Running') {
        const lastEvent = events[events.length - 1]
        const lastTime = lastEvent && typeof lastEvent.time === 'number'
          ? lastEvent.time
          : typeof lastEvent?.time0 === 'number' ? lastEvent.time0 : Date.now()
        t.status = 'Failed'
        t.finished_at = lastTime
      }
    }
  }

  return { restored, offsets: new Map() }
}

/** 会话 cwd → 项目 id（隔离区收回到仓库根，再匹配已有项目 / 种子项目）。 */
function projectIdForSessionCwd(cwd, sessionId, known, defaultProject) {
  const root = repoRootFromCwd(cwd)
  if (defaultProject && root && root === defaultProject[1].replace(/\/+$/, '')) return defaultProject[0]
  let best = null
  for (const p of known) {
    const pp = repoRootFromCwd(p.path).replace(/\/+$/, '')
    if (!pp) continue
    if (root === pp || root.startsWith(`${pp}/`)) {
      if (!best || pp.length > best.pathLen) best = { id: p.id, pathLen: pp.length }
    }
  }
  if (best) return best.id
  if (!cwd || isTaskWorktreePath(cwd)) return sessionId
  return basename(root) || sessionId
}

/** 读一个 session.jsonl：header + 事件列表。 */
function readLog(file) {
  const events = []
  let headerCwd, headerId, headerCreated
  let first = true
  try {
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, 4 << 20))
      const n = readSync(fd, buf, 0, buf.length, 0)
      const text = buf.subarray(0, n).toString('utf8')
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
          const v = JSON.parse(line)
          if (first) {
            first = false
            headerCwd = typeof v.cwd === 'string' ? v.cwd : undefined
            headerId = typeof v.id === 'string' ? v.id : undefined
            headerCreated = typeof v.createdAt === 'number' ? v.createdAt : undefined
            continue
          }
          if (v.seq === undefined && v.seq0 === undefined) continue
          events.push(v)
        } catch { /* 坏行跳过 */ }
      }
    } finally { closeSync(fd) }
  } catch { /* 文件不可读 → 空 */ }
  return { headerCwd, headerId, headerCreated, events }
}

function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch { continue }
    for (const e of entries) {
      const p = resolve(d, e.name)
      if (e.isDir) stack.push(p)
      else if (e.name === 'session.jsonl') out.push(p)
    }
  }
  return out
}

/** 从 worktree 路径收回到 git 仓库根。 */
function repoRootFromCwd(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return cwd
  }
}

/** worktree 路径识别（.helmsman/worktrees/ 下）。 */
function isTaskWorktreePath(p) {
  return typeof p === 'string' && p.includes('.helmsman') && p.includes('worktrees')
}

export default { name, inject, apply }
