/**
 * 启动恢复：从 .sessions/ 重放会话日志，重建投影 —— 照 crates/taskgraph/src/recovery.rs 翻译。
 * 复用 foldTask（纯函数、可回放）。header 行含 cwd/id/createdAt，用于恢复项目关联。
 * M2.3：有执行记录（SQLite）→ 挂对应卡；旧会话 → 隐式建卡（卡 id = 会话 id，1 卡 1 执行）。
 * 返回各文件已读字节偏移，供 tailer 接续。
 */
import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import {
  type Projection,
  ensureProject,
  ensureCard,
  registerSession,
  foldSession,
  type CardMeta,
} from './projection.ts'

export interface RecoveredCard {
  projectId: string
  meta: CardMeta
  executionCreatedAt: number
}

interface PendingReg {
  sid: string
  projectId: string
  cardId: string
  createdAt: number
}

/**
 * 重放 .sessions/ 重建投影。
 * defaultProject: (id, cwd) —— 会话 cwd 匹配时归入该项目（种子项目）。
 * cardOfSession: session_id → 卡归属（重启恢复的权威映射，来自 executions 表）。
 * 返回 (恢复会话数, 各文件字节偏移)。
 */
export function recoverStore(
  root: string,
  proj: Projection,
  defaultProject: [string, string] | null,
  cardOfSession: Map<string, RecoveredCard>,
): { restored: number; offsets: Map<string, number> } {
  const offsets = new Map<string, number>()
  const eventsBySid = new Map<string, Array<Record<string, unknown>>>()
  const regs: PendingReg[] = []
  const implicitCards = new Map<string, string>() // card_id → project_id
  let restored = 0

  for (const file of walk(root)) {
    const { headerCwd, headerId, headerCreated, events, bytes } = readLog(file)
    const sessionId = headerId ?? basename(dirname(file))
    if (!sessionId || events.length === 0) continue

    const cwd = (headerCwd ?? '').replace(/\/+$/, '')
    let projectId: string
    if (defaultProject && cwd && cwd === defaultProject[1].replace(/\/+$/, '')) {
      projectId = defaultProject[0]
    } else if (!cwd) {
      projectId = sessionId
    } else {
      projectId = basename(cwd) || cwd
    }
    const name = basename(cwd) || projectId
    ensureProject(proj, projectId, name, cwd)

    let cardId: string
    let createdAt: number
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
    offsets.set(file, bytes)
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
        id: r.cardId,
        title: '',
        description: '',
        kind: 'task',
        milestone: null,
        criteria: null,
        created_at: r.createdAt,
      })
      registerSession(proj, r.sid, r.projectId, r.cardId)
    }
  }

  // 折叠事件。
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
      // 中断检测：恢复后仍 Running 但日志没有 turn/end → 上次进程被中断（不是正常终态）。
      // 语义：中断的 Running 任务不能永远挂起；标记 Failed + finished_at=最后事件时间。
      if (t.status === 'Running') {
        const lastEvent = events[events.length - 1]
        const lastTime = lastEvent && typeof lastEvent.time === 'number'
          ? (lastEvent.time as number)
          : typeof lastEvent?.time0 === 'number' ? (lastEvent.time0 as number) : Date.now()
        t.status = 'Failed'
        t.finished_at = lastTime
      }
    }
  }

  return { restored, offsets }
}

/** 读一个 session.jsonl：header + 事件列表 + 总字节数。 */
function readLog(file: string): {
  headerCwd?: string
  headerId?: string
  headerCreated?: number
  events: Array<Record<string, unknown>>
  bytes: number
} {
  const events: Array<Record<string, unknown>> = []
  let headerCwd: string | undefined
  let headerId: string | undefined
  let headerCreated: number | undefined
  let first = true
  let bytes = 0
  try {
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, 4 << 20))
      const n = readSync(fd, buf, 0, buf.length, 0)
      const text = buf.subarray(0, n).toString('utf8')
      bytes = n
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
          const v = JSON.parse(line) as Record<string, unknown>
          if (first) {
            first = false
            headerCwd = typeof v.cwd === 'string' ? v.cwd : undefined
            headerId = typeof v.id === 'string' ? v.id : undefined
            headerCreated = typeof v.createdAt === 'number' ? v.createdAt : undefined
            continue
          }
          if (v.seq === undefined && v.seq0 === undefined) continue
          events.push(v)
        } catch {
          // 坏行跳过
        }
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    // 文件不可读 → 空
  }
  return { headerCwd, headerId, headerCreated, events, bytes }
}

function walk(dir: string): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()!
    let entries: Array<{ name: string; isDir: boolean }>
    try {
      entries = readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch {
      continue
    }
    for (const e of entries) {
      const p = resolve(d, e.name)
      if (e.isDir) stack.push(p)
      else if (e.name === 'session.jsonl') out.push(p)
    }
  }
  return out
}
