/**
 * Helmsman TS 产品服务（M3 正片等价物）——照 crates/service/src/main.rs 翻译。
 * 常驻进程：spawn dsh（一次）→ ACP 控制 → JSONL 观察（tailer → 投影 + WS 广播）
 * → HTTP/WS（projects/cards/tasks/fs/events）→ 前端 web/ 直接对接。
 * 接口 = Rust 版终版契约（web/src/api/client.ts 是第一个消费者）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readdirSync, renameSync, rmSync, mkdirSync, openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { startEngine } from './engine.ts'
import { Storage, parseIdArray, policySuggestion } from './storage.ts'
import {
  newProjection,
  ensureProject,
  ensureCard,
  registerSession,
  finishSession,
  removeProject,
  foldTask,
  detectPlanCompletion,
  extractPlanText,
  detectMarker,
  extractMarkerText,
  CALIBRATE_DONE_MARKER,
  CHECKPOINT_DONE_MARKER,
  validateDeps,
  depsMet,
  unmetDeps,
  hasRealExecution,
  type CardMeta,
  type CardState,
  type Project,
  type TaskState,
} from './projection.ts'
import { startTailer } from './observe/tail.ts'
import { recoverStore } from './recovery.ts'
import { retrieveHybrid, deriveQueries, makeNote, findDuplicateSediment, findDuplicateClusters, scoreNoteDebt, debtDemoteWeight, detectCitedEntries, withStableTag } from './kb.ts'
import { assembleBrief, renderBriefPrompt, selectStableNotes, extractConclusion, type Brief } from './assembly.ts'
import { distillWithAgent } from './distill.ts'
import { compareReport } from './experiment.ts'
import { runAcceptance } from './verify.ts'
import type { VerifyResult } from './verify.ts'
import { buildAcceptanceEvidence, acceptanceReason } from './evidence.ts'
import { prepareTaskWorktree, mergeTaskWorktree, discardTaskWorktree, executionCwd, isTaskWorktreePath } from './worktree.ts'
import { priceOf, estCostFrom } from './pricing.ts'

const PORT = Number(process.env.HELMSMAN_PORT ?? 3081)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..') // server-ts/src/.. = repo 根
const SESSIONS_ROOT = process.env.HELMSMAN_SESSIONS_ROOT ?? join(REPO, 'dsh/.sessions')
const ARCHIVE_ROOT = join(dirname(SESSIONS_ROOT), '.sessions-archive')
const DB_PATH = process.env.HELMSMAN_DB ?? join(REPO, 'helmsman.db')
const WORKSPACE = process.cwd()

let CARD_SEQ = 0
const genCardId = (): string => `card-${Date.now()}-${CARD_SEQ++}`
const nowMs = (): number => Date.now()

// ---------- 会话目录匹配（照 main.rs） ----------

const sessionDirKey = (cwd: string): string => `--${cwd.replace(/\/+$/, '').replace(/\//g, '-')}--`

function sessionCwd(dir: string): string | undefined {
  try {
    const line = readFirstLine(join(dir, 'session.jsonl'))
    if (!line) return undefined
    const v = JSON.parse(line) as { cwd?: string }
    return typeof v.cwd === 'string' ? v.cwd.replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

function readFirstLine(file: string): string | undefined {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(65536)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const s = buf.subarray(0, n).toString('utf8')
    const i = s.indexOf('\n')
    return i >= 0 ? s.slice(0, i).trim() : s.trim()
  } finally {
    closeSync(fd)
  }
}

function findSessionDirs(root: string, cwd: string): string[] {
  const norm = cwd.replace(/\/+$/, '')
  const key = sessionDirKey(norm)
  const out: string[] = []
  let entries: Array<{ name: string; isDir: boolean }> = []
  try {
    entries = readdirSync(root, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDir) continue
    const p = join(root, e.name)
    const c = sessionCwd(p)
    if (c === norm) {
      out.push(p)
      continue
    }
    if (e.name.startsWith(key)) out.push(p)
  }
  return out
}

function archiveSessionDirs(cwd: string): number {
  try {
    mkdirSync(ARCHIVE_ROOT, { recursive: true })
  } catch {
    return 0
  }
  let n = 0
  for (const d of findSessionDirs(SESSIONS_ROOT, cwd)) {
    try {
      renameSync(d, join(ARCHIVE_ROOT, basename(d)))
      n += 1
    } catch {
      /* ignore */
    }
  }
  return n
}

function purgeSessionDirs(cwd: string): number {
  let n = 0
  for (const d of findSessionDirs(SESSIONS_ROOT, cwd)) {
    try {
      rmSync(d, { recursive: true, force: true })
      n += 1
    } catch {
      /* ignore */
    }
  }
  return n
}

function restoreSessionDirs(cwd: string): number {
  let n = 0
  for (const d of findSessionDirs(ARCHIVE_ROOT, cwd)) {
    try {
      renameSync(d, join(SESSIONS_ROOT, basename(d)))
      n += 1
    } catch {
      /* ignore */
    }
  }
  return n
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  const engine = await startEngine({ sessionsRoot: SESSIONS_ROOT, workspace: WORKSPACE })
  const storage = new Storage(DB_PATH)
  const proj = newProjection()
  const cardOfSession = new Map<string, { projectId: string; meta: CardMeta; executionCreatedAt: number }>()

  // 隔离区 cwd 曾被当成独立项目；启动时清掉，避免侧栏出现 card-… 假项目。
  for (const m of storage.loadProjects()) {
    if (isTaskWorktreePath(m.path)) storage.purgeProject(m.id)
  }

  // 启动：灌持久化项目元数据
  for (const m of storage.loadProjects()) ensureProject(proj, m.id, m.name, m.path)

  // 种子项目（当前工作区）：仅首次自动注册；用户 purge/归档后不再自动回来。
  const seedHelmsman = !storage.projectExists('helmsman') && !storage.isDeleted('helmsman')
  if (seedHelmsman) {
    ensureProject(proj, 'helmsman', 'helmsman', WORKSPACE)
    storage.upsertProject('helmsman', 'helmsman', WORKSPACE, '{}')
  }

  // 恢复：从 SQLite 构建 session → 卡映射
  for (const card of storage.loadAllCards()) {
    for (const ex of storage.loadExecutions(card.id)) {
      cardOfSession.set(ex.id, {
        projectId: card.project_id,
        meta: {
          id: card.id,
          title: card.title,
          description: card.description,
          kind: card.kind,
          milestone: card.milestone,
          criteria: card.criteria,
          deps: card.deps ?? [],
          created_at: card.created_at,
        },
        executionCreatedAt: ex.created_at,
      })
    }
  }

  const { restored, offsets } = recoverStore(SESSIONS_ROOT, proj, seedHelmsman ? ['helmsman', WORKSPACE] : null, cardOfSession)
  // 恢复的卡/执行写快照（重放即权威投影；隐式卡借此落库）
  for (const [pid, p] of Object.entries(proj.projects)) {
    if (isTaskWorktreePath(p.path)) continue
    // 兜底：恢复出的项目若不在 SQLite（旧日志 cwd 项目），先注册（FK 依赖）
    if (!storage.projectExists(pid)) storage.upsertProject(pid, p.name, p.path, '{}')
    for (const [cardId, c] of Object.entries(p.cards)) {
      storage.upsertCard({
        id: cardId,
        project_id: pid,
        title: c.title,
        description: c.description,
        kind: c.kind,
        milestone: c.milestone,
        criteria: c.criteria ?? null,
        budget: c.budget ?? null,
        deps: c.deps ?? [],
        created_at: c.created_at,
      })
      for (const [sid, t] of Object.entries(c.executions)) {
        if (storage.getExecutionBySession(sid)) continue
        storage.upsertExecution({
          id: sid,
          card_id: cardId,
          status: t.status,
          preset_json: '{}',
          deps_json: JSON.stringify(c.deps ?? []),
          forked_from: null,
          started_at: t.started_at ?? null,
          finished_at: t.finished_at ?? null,
          created_at: c.created_at,
        })
      }
    }
  }
  console.log(`[recover] restored ${restored} sessions from logs`)

  // 依赖契约回灌：storage 已有执行的 deps_json 快照 → 投影 TaskState.deps（日志 fold 不含 deps）
  for (const card of storage.loadAllCards()) {
    const pc = proj.projects[card.project_id]?.cards[card.id]
    if (!pc) continue
    if (card.deps?.length && !(pc.deps?.length)) pc.deps = card.deps
    if (card.criteria && !pc.criteria) pc.criteria = card.criteria
    if (card.budget != null && pc.budget == null) pc.budget = card.budget
    for (const ex of storage.loadExecutions(card.id)) {
      const t = pc.executions[ex.id]
      if (t && ex.deps_json && ex.deps_json !== '[]' && !t.deps?.length) t.deps = parseIdArray(ex.deps_json)
      if (t && ex.worktree_path && ex.worktree_branch) t.worktree = { path: ex.worktree_path, branch: ex.worktree_branch }
    }
  }

  // 简单会话恢复（A 组）：chat_sessions 标记的 session → 从隐式卡挪到项目 chats（独立会话不进看板）
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
          // 隐式卡（无标题无执行）清掉
          if (card.title === '' && card.exec_order.length === 0) delete p0.cards[cardId]
        }
        p0.chats[sid] = t
        proj.sessionCard[sid] = ''
      }
    }
  }

  // M4：恢复出的 Failed/Cancelled 且无待批复的执行，若残留 worktree → 丢弃（崩溃中断不再泄漏分支/目录）
  for (const [pid, p] of Object.entries(proj.projects)) {
    if (isTaskWorktreePath(p.path)) continue
    for (const card of Object.values(p.cards)) {
      for (const [sid, t] of Object.entries(card.executions)) {
        if ((t.status === 'Failed' || t.status === 'Cancelled') && !t.waiting && t.worktree) {
          discardTaskWorktree(p.path, t.worktree)
          t.worktree = null
          storage.setExecutionWorktree(sid, null, null)
        }
      }
    }
  }

  // 既有项目补种子 Profile（老库无 profiles 表数据时）
  for (const pid of Object.keys(proj.projects)) storage.seedProfiles(pid)

  // 观察通道：tailer → fold + WS 广播（wsClients/broadcast 在 HTTP/WS 节定义）
  startTailer(SESSIONS_ROOT, offsets, (te) => {
    // fold 到投影（按 session 路由：卡执行 / 简单会话）
    const cardId = proj.sessionCard[te.sessionId]
    const pid = proj.sessionProject[te.sessionId]
    if (!pid) return
    const proj0 = proj.projects[pid]
    if (!proj0) return
    const t = cardId ? proj0.cards[cardId]?.executions[te.sessionId] : proj0.chats[te.sessionId]
    if (t) {
      const before = t.status
      foldTask(t, te.event)
      broadcast(te.event)
      // 调度门自动推进：刚完成 → 解锁的下游（无执行代次且 deps 全 Done）自动启动（并行分支，幂等）
      if (before !== 'Done' && t.status === 'Done') {
        void kickStartDownstream(pid)
      }
      // P1.5 预算门：后续轮结束（turn/end）检查——首轮由 startExecution .then 在 plan/goal/calibrate
      // 检测之后兜底（避免 cost 抢先 plan 审批，破坏"先看计划"流程）
      if (te.event.type === 'turn/end' && cardId && t.waiting === null && t.turns > 1) {
        checkBudget(pid, cardId, te.sessionId, nowMs())
      }
    }
  })

  // O5 超时挂起：pending 批复超时（默认 30 分钟，可配 HELMSMAN_APPROVAL_TIMEOUT_MS）→ 自动挂起（任务变 ⏸ 挂起，非失败）
  const APPROVAL_TIMEOUT_MS = Number(process.env.HELMSMAN_APPROVAL_TIMEOUT_MS ?? 30 * 60 * 1000)
  setInterval(() => {
    const now = Date.now()
    for (const pid of Object.keys(proj.projects)) {
      for (const a of storage.listPendingApprovals(pid)) {
        if (now - a.created_at < APPROVAL_TIMEOUT_MS) continue
        if (storage.suspendApproval(a.id)) {
          const t = resolveAnyTask(a.execution_id)
          if (t && t.waiting) t.waiting.payload.suspended_at = now
          console.warn(`[approval] #${a.id} suspended (${a.kind}) after ${APPROVAL_TIMEOUT_MS}ms`)
        }
      }
    }
  }, 60 * 1000).unref()

  // ---------- HTTP/WS ----------
  const server = createServer((req, res) => {
    void handle(req, res)
  })

  // 最小 WebSocket 服务端：握手 + 文本帧发送（服务端 → 客户端单向，够事件广播用）。
  // wsClients: ws 存 socket（帧直写 socket，绕过 http 层）；sse 存 res。
  const wsClients = new Map<import('node:net').Socket | import('node:http').ServerResponse, 'ws' | 'sse'>()
  const broadcast = (ev: Record<string, unknown>): void => {
    const text = JSON.stringify(ev)
    for (const [target, kind] of wsClients) {
      try {
        if (kind === 'ws') (target as import('node:net').Socket).write(wsTextFrame(text))
        else (target as import('node:http').ServerResponse).write(`data: ${text}\n\n`)
      } catch {
        wsClients.delete(target)
      }
    }
  }

  const acp = engine.acp

  /** Done 后规则提炼入库。交付档挂验收时推迟到人批准，避免未验收就污染 KB。 */
  async function persistAgentNote(projectId: string, cardId: string, title: string, t: TaskState): Promise<void> {
    const conclusion = extractConclusion({
      taskTitle: title,
      comments: t.comments.map((cm) => ({ who: cm.who, text: cm.text })),
      activities: t.activities,
      turns: t.turns,
      status: t.status,
    })
    if (!conclusion) return
    // 重复沉淀检测（知识演化）：语义上已有同结论 → 跳过，防知识库膨胀/装配噪声
    const dup = await findDuplicateSediment(storage.listNotes(projectId), conclusion)
    if (dup) {
      console.log(`[kb] 跳过重复沉淀「${conclusion.title}」≈「${dup.note.title}」(${dup.sim.toFixed(2)})`)
      return
    }
    // 沉淀提炼 Agent（mnemon 借鉴）：独立 ACP 会话（distill 预设，无工具）生成高质量条目；
    // 失败/超时 → 回落规则版。主对话零污染。
    const distilled = await distillOrFallback(projectId, title, t, conclusion)
    storage.upsertNote(makeNote({
      projectId,
      title: distilled.title,
      content: distilled.content,
      tags: ['auto'],
      keywords: distilled.keywords,
      summary: distilled.summary,
      sourceKind: 'task',
      sourceRef: cardId,
      trust: 'agent-generated',
    }))
    // 知识演化：库内历史重复簇收编（主条保留 + 重复条失效并链接主条）
    const merged = await mergeDuplicateClusters(projectId)
    if (merged > 0) console.log(`[kb] 合并重复 ${merged} 条（项目 ${projectId}）`)
  }

  /** 活动流最后一个 Text 活动的文本（提炼输入，有界 2000 字符）。 */
  function lastAgentText(t: TaskState): string {
    for (let i = t.activities.length - 1; i >= 0; i--) {
      const a = t.activities[i]
      if ('Text' in a && a.Text?.text) return a.Text.text.slice(0, 2000)
    }
    return ''
  }

  /** 提炼 Agent 优先、规则版兜底：独立会话生成知识条目（失败/跳过 → 规则结论）。 */
  async function distillOrFallback(
    projectId: string,
    title: string,
    t: TaskState,
    rule: { title: string; content: string[]; keywords: string[]; summary: string },
  ): Promise<{ title: string; content: string[]; keywords: string[]; summary: string }> {
    try {
      const notes = storage.listNotes(projectId)
      const related = await retrieveHybrid(notes, deriveQueries(title), title, { limit: 3 })
      const distilled = await distillWithAgent(acp, SESSIONS_ROOT, {
        cwd: WORKSPACE,
        title,
        tail: lastAgentText(t),
        related: related.map((h) => ({ title: h.note.title, summary: h.note.summary || h.note.content[0] || '' })),
      })
      if (distilled) {
        console.log(`[distill] 提炼成功「${distilled.title}」（任务 ${title.slice(0, 24)}）`)
        return distilled
      }
    } catch (e) {
      console.error('[distill] 提炼异常（回落规则版）:', e instanceof Error ? e.message : e)
    }
    return rule
  }

  /**
   * 知识演化：扫描项目内有效笔记的重复簇，收编历史遗留重复。
   * 每簇：主条（信任高/新/内容全）links 追加被合并条 id；重复条 invalidate（invalidated_by = 主条 id，可追溯）。
   * embedding 不可用 → 0（不合并，零破坏）。
   */
  async function mergeDuplicateClusters(projectId: string): Promise<number> {
    const notes = storage.listNotes(projectId).filter((n) => n.validUntil === null)
    const clusters = await findDuplicateClusters(notes)
    let merged = 0
    for (const c of clusters) {
      storage.upsertNote({ ...c.keep, links: [...new Set([...(c.keep.links ?? []), ...c.dupes.map((d) => d.id)])] })
      for (const d of c.dupes) {
        storage.invalidateNote(d.id, c.keep.id, Date.now())
        console.log(`[kb] 合并重复：「${d.title.slice(0, 32)}」→ 并入「${c.keep.title.slice(0, 32)}」`)
        merged++
      }
    }
    return merged
  }

  /** 计划/目标批复后继续跑完：隔离区在二次 Done 时才合入（startExecution 的 then 已返回）。 */
  async function settleWorktreeOnDone(projectId: string, cardId: string, sid: string, at: number): Promise<void> {
    const p = proj.projects[projectId]
    const c = p?.cards[cardId]
    const t = c?.executions[sid]
    if (!p || !c || !t?.worktree || t.waiting) return
    if (t.status === 'Cancelled') {
      discardTaskWorktree(p.path, t.worktree)
      t.worktree = null
      storage.setExecutionWorktree(sid, null, null)
      return
    }
    if (t.status !== 'Done') return
    // L1：plan 模式拒绝后 agent 修订计划（【计划完毕】标记）→ 重新挂计划审批，不自动合入/验收
    if (t.preset?.mode === 'plan' && detectPlanCompletion(t)) {
      const planText = extractPlanText(t)
      t.waiting = { kind: 'plan', reason: '计划模式：agent 已修订计划，请再次审阅（批准后才合入）', payload: { mode: 'plan', plan: planText } }
      t.status = 'Running'
      storage.upsertExecution({
        id: sid, card_id: cardId, status: 'Running',
        preset_json: t.preset ? JSON.stringify(t.preset) : '{}', deps_json: '[]',
        forked_from: null, started_at: t.started_at ?? null, finished_at: null, created_at: at,
      })
      storage.insertApproval({
        id: 0, project_id: projectId, execution_id: sid, kind: 'plan',
        payload: { mode: 'plan', plan: planText },
        reason: '计划模式：agent 已修订计划，请审阅',
        outcome: null, comment: null, created_at: at, decided_at: null, suspended_at: null,
      })
      return
    }
    const hang = t.preset?.setting === 'delivery' && t.preset?.approval !== 'yolo'
    const runCwd = executionCwd(p.path, t.worktree)
    let verifyResult: VerifyResult | null = null
    if (c.criteria) {
      verifyResult = await runAcceptance(runCwd, c.criteria)
    }
    if (hang) {
      const evidence = buildAcceptanceEvidence({
        cwd: runCwd,
        criteria: c.criteria,
        verify: verifyResult,
        worktree: t.worktree,
      })
      const reason = acceptanceReason(evidence)
      const payload = evidence as unknown as Record<string, unknown>
      t.waiting = { kind: 'acceptance', reason, payload }
      storage.insertApproval({
        id: 0, project_id: projectId, execution_id: sid, kind: 'acceptance',
        payload, reason, outcome: null, comment: null, created_at: at, decided_at: null, suspended_at: null,
      })
      return
    }
    const mr = mergeTaskWorktree({ repo: p.path, worktree: t.worktree, message: `helmsman: ${c.title}` })
    if (mr.ok) {
      t.worktree = null
      storage.setExecutionWorktree(sid, null, null)
      return
    }
    const reason = mr.error ?? '合入主工作区失败'
    const evidence = buildAcceptanceEvidence({
      cwd: runCwd, criteria: c.criteria, verify: verifyResult, worktree: t.worktree,
    })
    const payload = { ...evidence, merge: mr } as unknown as Record<string, unknown>
    t.waiting = { kind: 'acceptance', reason, payload }
    storage.insertApproval({
      id: 0, project_id: projectId, execution_id: sid, kind: 'acceptance',
      payload, reason, outcome: null, comment: null, created_at: at, decided_at: null, suspended_at: null,
    })
  }

  // 执行启动共路：session_new → 注册到卡 → 快照 Pending → 后台跑
  // brief=true 装配知识库简报；false = 裸跑（对照实验 B 组）；presetId 按 dsh preset 组装；presetSnapshot 落快照
  async function startExecution(
    projectId: string,
    cardId: string,
    forkedFrom: string | null,
    opts: { brief?: boolean; groupTag?: string; criteria?: string | null; presetId?: string | null; presetSnapshot?: string | null } = {},
  ): Promise<string> {
    const p = proj.projects[projectId]
    const c = p?.cards[cardId]
    if (!p || !c) throw new HttpError(404, `card '${cardId}' not found`)
    // 依赖门（§2.1 调度门，非展示）：依赖全部完成（最新执行 Done）才允许启动；未完成 → 409 等上游
    const unmet = unmetDeps(c, p.cards)
    if (unmet.length) {
      const names = unmet.map((d) => p.cards[d]?.title ?? d).join('、')
      throw new HttpError(409, `依赖未完成（等上游）：${names}`)
    }
    const wtKey = `${cardId}-${Date.now().toString(36)}-${WT_SEQ++}`
    const wt = prepareTaskWorktree(p.path, cardId, wtKey)
    let sid: string
    try {
      sid = await acp.sessionNew(wt?.path ?? p.path, opts.presetId ?? undefined)
    } catch (e) {
      if (wt) discardTaskWorktree(p.path, wt)
      throw e
    }
    registerSession(proj, sid, projectId, cardId)
    // M5：隔离区不可用 → 执行可见标记（前端提示"共享目录运行"），不静默
    const t0 = proj.projects[projectId]?.cards[cardId]?.executions[sid]
    if (t0 && !wt) t0.isolated = true
    // 依赖契约快照：继承卡 deps（目标契约 taskgraph；图 DAG 边 = 最新执行此字段）
    if (t0) t0.deps = c.deps ?? []
    if (t0 && wt) t0.worktree = wt
    // 预设快照进投影（§2.6：执行契约，随任务生命周期延续，前端可见）
    if (opts.presetSnapshot) {
      try {
        const snap = JSON.parse(opts.presetSnapshot) as { id: string; name: string; mode: string; setting: string; approval: string; sandbox: string }
        const t = proj.projects[projectId]?.cards[cardId]?.executions[sid]
        if (t) t.preset = snap
      } catch { /* 忽略坏快照 */ }
    }
    const created = nowMs()
    storage.upsertExecution({
      id: sid,
      card_id: cardId,
      status: 'Pending',
      preset_json: opts.presetSnapshot ?? '{}',
      deps_json: JSON.stringify(c.deps ?? []),
      forked_from: forkedFrom,
      started_at: null,
      finished_at: null,
      created_at: created,
    })
    if (wt) storage.setExecutionWorktree(sid, wt.path, wt.branch)
    // 简报装配（M4 §4）：任务定义 + 知识库命中 → 首条 prompt；裸跑则只有任务定义
    // 稳定块只收用户钉的 `stable` 标签，不按信任级自动塞旧笔记。
    let brief: Brief = { taskTitle: c.title, taskDescription: c.description, kbHits: [] }
    let stableNotes: Array<{ title: string; content: string[] }> = []
    if (opts.brief !== false) {
      const notes = storage.listNotes(projectId)
      stableNotes = selectStableNotes(notes)
      const history = storage.listMetrics(projectId)
      const demote: Record<string, number> = {}
      for (const n of notes) {
        const w = debtDemoteWeight(scoreNoteDebt(n.id, history).status)
        if (w !== 1) demote[n.id] = w
      }
      brief = await assembleBrief({
        taskTitle: c.title,
        taskDescription: c.description,
        notes,
        demote,
      })
    }
    const prompt = opts.brief === false
      ? `${c.title}\n\n${c.description}`.trim()
      : renderBriefPrompt(brief, stableNotes)
    // 阶段 2：三轴驱动行为（§2.5）—— 解析 preset 快照
    let presetMode: 'normal' | 'plan' | 'goal' = 'normal'
    let presetSetting: 'light' | 'balanced' | 'delivery' = 'balanced'
    let presetApproval: 'ask' | 'auto' | 'yolo' = 'ask'
    if (opts.presetSnapshot) {
      try {
        const snap = JSON.parse(opts.presetSnapshot) as { mode?: string; setting?: string; approval?: string }
        if (snap.mode === 'plan' || snap.mode === 'goal') presetMode = snap.mode
        if (snap.setting === 'light' || snap.setting === 'delivery') presetSetting = snap.setting
        if (snap.approval === 'auto' || snap.approval === 'yolo') presetApproval = snap.approval
      } catch { /* 快照解析失败按默认 */ }
    }
    // plan 模式：注入"先产计划"指令（计划 = 提交物，批复后才执行，§2.1）
    let finalPrompt = prompt
    if (presetMode === 'plan') {
      finalPrompt = `${prompt}\n\n【协作方式：计划模式】请先产出一份计划（步骤/涉及文件/风险），
用一行 "【计划完毕】" 结尾。产出计划后停下等待批复，不要开始执行。`
    }
    // 目标模式（D1.8）：任务合约 + 周期性检查点 —— 无验收标准也能跑，阶段小结等用户主观确认方向
    if (presetMode === 'goal') {
      finalPrompt = `${prompt}\n\n【协作方式：目标模式】
- 任务合约：Context（目标）如上；Request（交付物）→ 请先明确你理解的交付物；Output（输出形式）→ 代码/文件；Constraints（约束）→ 遵守沙箱与项目约定；Pause（暂停点）→ 每个可验收的阶段结束时暂停。
- 每完成一个可独立验收的阶段，输出一段进度小结（做了什么/验证了什么/下一步），
  用一行 "${CHECKPOINT_DONE_MARKER}" 结尾，然后停下等方向确认（继续/调整/停止）。`
    }
    finalPrompt = `${finalPrompt}\n\n只改任务要求的文件。不要安装依赖、不要跑全量测试，除非任务或验收命令写了。`
    const groupTag = opts.groupTag
    void acp
      .sessionPrompt(sid, finalPrompt)
      .then(async (stopReason) => {
        await waitTailer() // G6：ACP resolve 与 JSONL 落盘竞态——等 tailer fold 完最后的 text-chunks 再检测
        const at = nowMs()
        finishSession(proj, sid, stopReason, at)
        const t = proj.projects[proj.sessionProject[sid]]?.cards[proj.sessionCard[sid]]?.executions[sid]
        if (t) {
          storage.upsertExecution({
            id: sid,
            card_id: cardId,
            status: t.status,
            preset_json: opts.presetSnapshot ?? '{}',
            deps_json: '[]',
            forked_from: forkedFrom,
            started_at: t.started_at ?? null,
            finished_at: t.finished_at ?? null,
            created_at: created,
          })
          // 阶段 2 · plan 模式：检测 agent 是否产出计划（【计划完毕】标记）→ 挂 Waiting{plan} 等批复
          if (presetMode === 'plan' && t.status === 'Done' && t.waiting === null && detectPlanCompletion(t)) {
              const planText = extractPlanText(t)
              t.waiting = {
                kind: 'plan',
                reason: `计划模式：agent 已产出计划（见计划内容），请审阅后批准执行或要求修改`,
                payload: { mode: 'plan', plan: planText },
              }
              // 计划等待不是终态——重置为 Running（等待批复中），批准后继续执行
              t.status = 'Running'
              storage.upsertExecution({
                id: sid,
                card_id: cardId,
                status: 'Running',
                preset_json: opts.presetSnapshot ?? '{}',
                deps_json: '[]',
                forked_from: forkedFrom,
                started_at: t.started_at ?? null,
                finished_at: null,
                created_at: created,
              })
              storage.insertApproval({
                id: 0,
                project_id: projectId,
                execution_id: sid,
                kind: 'plan',
                payload: { mode: 'plan', plan: planText },
                reason: '计划模式：agent 已产出计划，请审阅',
                outcome: null,
                comment: null,
                created_at: at,
                decided_at: null,
                suspended_at: null,
              })
              // 计划已产出 → 跳过知识沉淀与验收（执行尚未发生）
              return
            }
          // 目标模式检查点（D1.8）：agent 阶段小结（【阶段完毕】标记）→ 挂 Waiting{checkpoint} 等方向确认
          // 审批姿态：yolo 跳过检查点（尽量连续执行）；ask/auto 卡住等主观确认
          if (
            presetMode === 'goal' && t.status === 'Done' && t.waiting === null &&
            presetApproval !== 'yolo' && detectMarker(t, CHECKPOINT_DONE_MARKER)
          ) {
            const summary = extractMarkerText(t, CHECKPOINT_DONE_MARKER)
            t.waiting = {
              kind: 'checkpoint',
              reason: `目标模式：agent 完成一个阶段（${t.turns} 轮），请确认方向（继续/调整/停止）`,
              payload: { mode: 'goal', summary },
            }
            t.status = 'Running' // 等待批复中，非终态
            storage.upsertExecution({
              id: sid,
              card_id: cardId,
              status: 'Running',
              preset_json: opts.presetSnapshot ?? '{}',
              deps_json: '[]',
              forked_from: forkedFrom,
              started_at: t.started_at ?? null,
              finished_at: null,
              created_at: created,
            })
            storage.insertApproval({
              id: 0,
              project_id: projectId,
              execution_id: sid,
              kind: 'checkpoint',
              payload: { mode: 'goal', summary },
              reason: '目标模式：阶段小结，请确认方向',
              outcome: null,
              comment: null,
              created_at: at,
              decided_at: null,
              suspended_at: null,
            })
            return
          }
          // S1 修复：任何 waiting（含 tailer 已挂的 cost/checkpoint）→ 本趟终止，等批复；
          // 否则 finishTask 的 Done 会让下面的验收/沉淀/merge 绕过批复直接执行
          if (t.waiting) return
          // P1.5 预算门：超支挂起（opt-in；已挂 plan/goal/calibrate 等待的不重复挂）
          if (checkBudget(projectId, cardId, sid, at)) return
          // 验收门（§3.3）：任务 Done 且有验收标准 → 独立执行验收（不信任 agent 自评）
          let verified: boolean | undefined
          let verifyResult: VerifyResult | null = null
          const runCwd = executionCwd(p.path, t.worktree)
          if (t.status === 'Done' && opts.criteria) {
            verifyResult = await runAcceptance(runCwd, opts.criteria)
            verified = verifyResult.verified ?? undefined
            if (verifyResult.error) console.error(`[verify] ${sid}: ${verifyResult.error}`)
          }
          // 交付档便宜验收：Done 一律挂 Waiting{acceptance}（yolo 除外），卡片上带 git 快照 + 命令结果。
          // 有标准也挂 —— 人看证据再一键过，不因命令绿了就静默 merge。
          const hangAcceptance = presetSetting === 'delivery' && t.status === 'Done' && t.waiting === null && presetApproval !== 'yolo'
          // 知识沉淀（M4 §3.3）：裸跑不沉淀；交付档等人批准后再入库
          if (opts.brief !== false && !hangAcceptance) {
            await persistAgentNote(projectId, cardId, c.title, t)
          }
          if (hangAcceptance) {
            const evidence = buildAcceptanceEvidence({
              cwd: runCwd,
              criteria: opts.criteria ?? null,
              verify: verifyResult,
              worktree: t.worktree ?? null,
            })
            const reason = acceptanceReason(evidence)
            const payload = evidence as unknown as Record<string, unknown>
            t.waiting = { kind: 'acceptance', reason, payload }
            storage.insertApproval({
              id: 0,
              project_id: projectId,
              execution_id: sid,
              kind: 'acceptance',
              payload,
              reason,
              outcome: null,
              comment: null,
              created_at: at,
              decided_at: null,
              suspended_at: null,
            })
          }
          // 非交付档 / yolo：Done 后自动合入主工作区。冲突则挂验收，让人处理。
          if (!hangAcceptance && t.status === 'Done' && t.worktree) {
            const mr = mergeTaskWorktree({ repo: p.path, worktree: t.worktree, message: `helmsman: ${c.title}` })
            if (mr.ok) {
              t.worktree = null
              storage.setExecutionWorktree(sid, null, null)
            } else {
              const reason = mr.error ?? '合入主工作区失败'
              const evidence = buildAcceptanceEvidence({
                cwd: runCwd,
                criteria: opts.criteria ?? null,
                verify: verifyResult,
                worktree: t.worktree,
              })
              const payload = { ...evidence, merge: mr } as unknown as Record<string, unknown>
              t.waiting = { kind: 'acceptance', reason, payload }
              storage.insertApproval({
                id: 0,
                project_id: projectId,
                execution_id: sid,
                kind: 'acceptance',
                payload,
                reason,
                outcome: null,
                comment: null,
                created_at: at,
                decided_at: null,
                suspended_at: null,
              })
            }
          } else if (t.status === 'Cancelled' && t.worktree) {
            discardTaskWorktree(p.path, t.worktree)
            t.worktree = null
            storage.setExecutionWorktree(sid, null, null)
          }
          // 度量闭环（M4 §5.2）：简报命中清单 + 回合数 + 成本 + 验收 + 实验组落库
          const u = t.usage
          const cost = estCostFrom(u, priceOf(t.model))
          const cacheHit = u.inputTokens + u.cacheReadTokens > 0
            ? u.cacheReadTokens / (u.inputTokens + u.cacheReadTokens)
            : 0
          storage.insertMetric({
            project_id: projectId,
            task_id: sid,
            brief_snapshot: brief.kbHits.map((h) => ({ id: h.id, title: h.title, score: h.score })),
            outcome: t.status,
            cited_entries: detectCitedEntries(
              brief.kbHits.map((h) => ({
                id: h.id,
                title: h.title,
                keywords: storage.getNote(h.id)?.keywords ?? [],
              })),
              [
                ...t.tool_calls.map((c) => c.args),
                ...t.activities.flatMap((a) => ('Text' in a && a.Text?.text ? [a.Text.text] : [])),
              ].join('\n'),
            ),
            turns: t.turns,
            steps: t.steps,
            group_tag: groupTag,
            verified,
            cost: Math.round(cost * 10000) / 10000,
            cache_hit: Math.round(cacheHit * 10000) / 10000,
            in_tokens: u.inputTokens,
            cache_tokens: u.cacheReadTokens,
            out_tokens: u.outputTokens,
            reason_tokens: u.reasoningTokens,
            created_at: at,
          })
        }
      })
      .catch((err) => {
        finishSession(proj, sid, 'error', nowMs())
        console.error(`[task] ${sid} failed:`, err)
      })
    return sid
  }

  /** 调度门自动推进：扫描项目内"已解锁未执行"的卡（无正常执行代次且 deps 全 Done），自动启动。并行分支。 */
  function kickStartDownstream(projectId: string): void {
    const p = proj.projects[projectId]
    if (!p) return
    for (const card of Object.values(p.cards)) {
      if (hasRealExecution(card)) continue // 校准会话不算正常执行（D1.7：批准后仍需启动）
      if (!depsMet(card, p.cards)) continue
      void startExecution(projectId, card.id, null).catch((e) => {
        console.warn(`[sched] auto-start ${card.id} failed: ${e instanceof Error ? e.message : e}`)
      })
    }
  }

  /** 按会话 id 解析任意任务（卡执行或简单会话；挂起定时器用） */
  function resolveAnyTask(sessionId: string): TaskState | undefined {
    const pid = proj.sessionProject[sessionId]
    const cardId = proj.sessionCard[sessionId]
    const p = pid ? proj.projects[pid] : undefined
    if (!p) return undefined
    return cardId ? p.cards[cardId]?.executions[sessionId] : p.chats[sessionId]
  }

  /** 简单会话解析（A 组）：sessionProject 有、sessionCard 空 → 项目 chats 里的 TaskState */
  function resolveChatTask(sessionId: string): TaskState | undefined {
    const pid = proj.sessionProject[sessionId]
    if (!pid || proj.sessionCard[sessionId]) return undefined
    return proj.projects[pid]?.chats[sessionId]
  }

  /** 会话最后一条 Text（列表展示用；无 Text 返回 null） */
  function extractLastText(t: TaskState): string | null {
    for (let i = t.activities.length - 1; i >= 0; i--) {
      const a = t.activities[i]
      if ('Text' in a && a.Text?.text) return a.Text.text.slice(0, 200)
    }
    return null
  }

  /** Waiting{cost}（P1.5 opt-in 预算门）：卡 budget 超支 → 挂起等批复（批准=接受成本完成 / 拒绝=停止）。
   *  每轮结束检查；返回是否已挂起。 */
  function checkBudget(projectId: string, cardId: string, sid: string, at: number): boolean {
    const p = proj.projects[projectId]
    const card = p?.cards[cardId]
    const t = card?.executions[sid]
    if (!p || !card || !t || !card.budget) return false
    if (t.waiting) return false
    const cost = estCostFrom(t.usage, priceOf(t.model))
    if (cost <= card.budget) return false
    t.waiting = { kind: 'cost', reason: `执行成本 ¥${cost.toFixed(3)} 超预算 ¥${card.budget}（opt-in 预算门）`, payload: { budget: card.budget, cost } }
    t.status = 'Running' // 等待批复（批准=接受成本完成 / 拒绝=停止）
    storage.upsertExecution({
      id: sid, card_id: cardId, status: 'Running',
      preset_json: t.preset ? JSON.stringify(t.preset) : '{}', deps_json: JSON.stringify(card.deps ?? []),
      forked_from: null, started_at: t.started_at ?? null, finished_at: null, created_at: at,
    })
    storage.insertApproval({
      id: 0, project_id: projectId, execution_id: sid, kind: 'cost',
      payload: { budget: card.budget, cost },
      reason: '执行成本超预算，请批复（批准=接受成本完成 / 拒绝=停止）',
      outcome: null, comment: null, created_at: at, decided_at: null, suspended_at: null,
    })
    return true
  }

  /** D1.7 需求校准：开校准会话 → agent 探索需求并提案验收标准（可判定断言）→ Waiting{calibrate} 等批复。
   *  批准 → 写回 criteria + 自动启动正常执行；拒绝 → 评论送达（可再校准）。 */
  async function startCalibration(projectId: string, cardId: string): Promise<string> {
    const p = proj.projects[projectId]
    const c = p?.cards[cardId]
    if (!p || !c) throw new HttpError(404, `card '${cardId}' not found`)
    const sid = await acp.sessionNew(p.path, undefined)
    registerSession(proj, sid, projectId, cardId)
    const t0 = proj.projects[projectId]?.cards[cardId]?.executions[sid]
    if (t0) { t0.deps = c.deps ?? []; t0.calib = true } // 校准会话标记（不算正常执行代次）
    const created = nowMs()
    storage.upsertExecution({
      id: sid,
      card_id: cardId,
      status: 'Pending',
      preset_json: '{}',
      deps_json: JSON.stringify(c.deps ?? []),
      forked_from: null,
      started_at: null,
      finished_at: null,
      created_at: created,
    })
    const prompt = `【需求校准】目标卡：「${c.title}」
需求描述：${c.description || '（未填写）'}

请围绕上述需求探索（读代码/文档，必要时提问澄清），然后产出验收标准提案：
1. 验收标准必须是**可判定断言**（命令式验证如 node -e 断言，或精确可检查的描述），不是空话；
2. 覆盖关键行为、边界、交付物；
3. 最后用一行 "${CALIBRATE_DONE_MARKER}" 结尾，之后停下等待确认，不要开始执行。`
    void acp.sessionPrompt(sid, prompt).then(async (stopReason) => {
      await waitTailer() // G6：同上（校准提案检测前等 tailer 追上）
      const at = nowMs()
      finishSession(proj, sid, stopReason, at)
      const t = proj.projects[projectId]?.cards[cardId]?.executions[sid]
      if (!t) return
      if (t.status === 'Done' && t.waiting === null && detectMarker(t, CALIBRATE_DONE_MARKER)) {
        const proposal = extractMarkerText(t, CALIBRATE_DONE_MARKER)
        t.waiting = { kind: 'calibrate', reason: '需求校准：agent 已提案验收标准，请确认（批准 → 写回卡的验收标准并开始执行）', payload: { criteria_proposal: proposal } }
        t.status = 'Running' // 等待批复中，非终态
        storage.upsertExecution({
          id: sid, card_id: cardId, status: 'Running',
          preset_json: '{}', deps_json: JSON.stringify(c.deps ?? []),
          forked_from: null, started_at: t.started_at ?? null, finished_at: null, created_at: created,
        })
        storage.insertApproval({
          id: 0,
          project_id: projectId,
          execution_id: sid,
          kind: 'calibrate',
          payload: { criteria_proposal: proposal },
          reason: '需求校准：验收标准提案',
          outcome: null,
          comment: null,
          created_at: at,
          decided_at: null,
          suspended_at: null,
        })
        return
      }
      // 未产出提案（agent 未按格式）→ 落终态，用户可再点校准
      storage.upsertExecution({
        id: sid, card_id: cardId, status: t.status,
        preset_json: '{}', deps_json: JSON.stringify(c.deps ?? []),
        forked_from: null, started_at: t.started_at ?? null, finished_at: t.finished_at ?? null, created_at: created,
      })
    })
    return sid
  }

  /** 目标模式循环（D1.8）：批复后继续执行 → 检测阶段小结（【阶段完毕】）→ 再挂 checkpoint / 全部完成收尾。
   *  steer：批复意见（批准 = 继续；拒绝 = 带修改意见调整方向）。 */
  async function runGoalLoop(projectId: string, cardId: string, sid: string, steer?: string): Promise<void> {
    const p = proj.projects[projectId]
    const c = p?.cards[cardId]
    if (!p || !c) return
    const prompt = steer
      ? `${steer}\n\n继续执行，完成当前阶段后用一行 "${CHECKPOINT_DONE_MARKER}" 结尾汇报。`
      : `继续执行，完成当前阶段后用一行 "${CHECKPOINT_DONE_MARKER}" 结尾汇报。`
    const stopReason = await acp.sessionPrompt(sid, prompt).catch((e) => {
      console.error(`[goal] loop ${sid}:`, e)
      return 'error'
    })
    await waitTailer() // G6：同上（目标模式循环检测前等 tailer 追上）
    const at = nowMs()
    finishSession(proj, sid, stopReason, at)
    const t = proj.projects[projectId]?.cards[cardId]?.executions[sid]
    if (!t) return
    if (t.status === 'Done' && t.waiting === null && detectMarker(t, CHECKPOINT_DONE_MARKER)) {
      const summary = extractMarkerText(t, CHECKPOINT_DONE_MARKER)
      t.waiting = { kind: 'checkpoint', reason: `目标模式：agent 完成一个阶段（${t.turns} 轮），请确认方向（继续/调整/停止）`, payload: { mode: 'goal', summary } }
      t.status = 'Running'
      storage.upsertExecution({
        id: sid, card_id: cardId, status: 'Running',
        preset_json: '{}', deps_json: '[]',
        forked_from: null, started_at: t.started_at ?? null, finished_at: null, created_at: at,
      })
      storage.insertApproval({
        id: 0, project_id: projectId, execution_id: sid, kind: 'checkpoint',
        payload: { mode: 'goal', summary }, reason: '目标模式：阶段小结，请确认方向',
        outcome: null, comment: null, created_at: at, decided_at: null, suspended_at: null,
      })
      return
    }
    // P1.5 预算门（目标模式多轮同样受控）
    if (checkBudget(projectId, cardId, sid, at)) return
    // 未产出检查点 → 全部阶段完成：落终态 + 结论沉淀（agent-generated）
    storage.upsertExecution({
      id: sid, card_id: cardId, status: t.status,
      preset_json: '{}', deps_json: '[]',
      forked_from: null, started_at: t.started_at ?? null, finished_at: t.finished_at ?? null, created_at: at,
    })
    const conclusion = extractConclusion({
      taskTitle: c.title,
      comments: t.comments.map((cm) => ({ who: cm.who, text: cm.text })),
      activities: t.activities,
      turns: t.turns,
      status: t.status,
    })
    if (conclusion) {
      const dup = await findDuplicateSediment(storage.listNotes(projectId), conclusion)
      if (!dup) {
        const distilled = await distillOrFallback(projectId, c.title, t, conclusion)
        const note = makeNote({
          projectId,
          title: distilled.title,
          content: distilled.content,
          tags: ['auto'],
          keywords: distilled.keywords,
          summary: distilled.summary,
          sourceKind: 'task',
          sourceRef: cardId,
          trust: 'agent-generated',
        })
        storage.upsertNote(note)
      } else {
        console.log(`[kb] 跳过重复沉淀「${conclusion.title}」≈「${dup.note.title}」(${dup.sim.toFixed(2)})`)
      }
    }
    await settleWorktreeOnDone(projectId, cardId, sid, at)
  }

  class HttpError extends Error {
    constructor(public status: number, message: string) {
      super(message)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method ?? 'GET'
    const send = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    const readBody = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? (JSON.parse(text) as Record<string, unknown>) : {}
    }
    try {
      // WS 握手（/api/events）—— 保持连接，不发 end()；之后只写帧。
      if (path === '/api/events' && (req.headers.upgrade ?? '').toLowerCase() === 'websocket') {
        const key = req.headers['sec-websocket-key']
        if (key) {
          const accept = createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64')
          res.writeHead(101, {
            Upgrade: 'websocket',
            Connection: 'Upgrade',
            'Sec-WebSocket-Accept': accept,
          })
          res.flushHeaders()
          const socket = req.socket
          wsClients.set(socket, 'ws')
          socket.on('close', () => wsClients.delete(socket))
          return
        }
      }
      // SSE 兜底（同路由，EventSource 用）
      if (path === '/api/events' && method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        wsClients.set(res, 'sse')
        req.on('close', () => wsClients.delete(res))
        return
      }

      // ---------- 项目 ----------
      if (method === 'GET' && path === '/api/projects') {
        const out = Object.entries(proj.projects)
          .map(([id, p]) => ({ id, name: p.name, path: p.path, card_count: Object.keys(p.cards).length, counts: cardStatusCounts(p) }))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
        send(200, out)
        return
      }
      if (method === 'POST' && path === '/api/projects') {
        const body = await readBody()
        const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
        if (!rawPath) throw new HttpError(400, 'empty path')
        const pathNorm = rawPath.replace(/\/+$/, '')
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : basename(pathNorm) || pathNorm
        const base = basename(pathNorm) || pathNorm
        const id = (base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').split('-').filter(Boolean).join('-')) || 'project'
        // 仅移除可恢复：重新导入同目录 → 移回归档会话 + 取消归档 + 立即恢复
        const archived = storage.findArchivedProject(pathNorm)
        let isRestored = false
        if (archived) {
          restoreSessionDirs(pathNorm)
          storage.unarchiveProject(archived.id)
          isRestored = true
        }
        const projectId = archived?.id ?? id
        ensureProject(proj, projectId, name, pathNorm)
        storage.upsertProject(projectId, name, pathNorm, '{}')
        storage.seedProfiles(projectId) // 种子内置 4 个 Profile（首个 = 项目默认，§2.6）
        const p = proj.projects[projectId]
        send(201, { id: p.id, name: p.name, path: p.path, card_count: Object.keys(p.cards).length, restored: isRestored })
        return
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/)
      if (projectMatch && method === 'DELETE') {
        const pid = decodeURIComponent(projectMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, `project '${pid}' not found`)
        const body = await readBody()
        const mode = body.mode === 'purge' ? 'purge' : 'archive'
        const removedSessions = mode === 'purge' ? purgeSessionDirs(p.path) : archiveSessionDirs(p.path)
        removeProject(proj, pid)
        if (mode === 'purge') {
          storage.purgeProject(pid)
          storage.markDeleted(pid)
        } else {
          storage.archiveProject(pid)
        }
        send(200, { ok: true, mode, sessions: removedSessions })
        return
      }
      if (projectMatch && method === 'GET') {
        const pid = decodeURIComponent(projectMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, 'project not found')
        send(200, { id: p.id, name: p.name, path: p.path, cards: p.cards })
        return
      }

      // ---------- 工作区文件树（活状态现取；安全过滤：跳过依赖/隐藏/产物目录，限深限数） ----------
      const filesMatch = path.match(/^\/api\/projects\/([^/]+)\/files$/)
      if (filesMatch && method === 'GET') {
        const pid = decodeURIComponent(filesMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, `project '${pid}' not found`)
        const root = listFileTree(p.path)
        send(200, root)
        return
      }
      const repoStatusMatch = path.match(/^\/api\/projects\/([^/]+)\/repo-status$/)
      if (repoStatusMatch && method === 'GET') {
        const pid = decodeURIComponent(repoStatusMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, `project '${pid}' not found`)
        send(200, repoStatus(p.path))
        return
      }
      const fileReadMatch = path.match(/^\/api\/projects\/([^/]+)\/files\/read$/)
      if (fileReadMatch && method === 'GET') {
        const pid = decodeURIComponent(fileReadMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, `project '${pid}' not found`)
        const rel = url.searchParams.get('path') ?? ''
        try {
          const preview = readProjectFile(p.path, rel)
          send(200, preview)
        } catch (e) {
          if (e instanceof Error && e.message === 'not found') throw new HttpError(404, 'file not found')
          throw new HttpError(403, e instanceof Error ? e.message : 'read failed')
        }
        return
      }

      // ---------- 卡 ----------
      const cardsMatch = path.match(/^\/api\/projects\/([^/]+)\/cards$/)
      if (cardsMatch && method === 'GET') {
        const pid = decodeURIComponent(cardsMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, 'project not found')
        const out = Object.entries(p.cards)
          .map(([id, c]) => {
            const latest = latestExecution(c)
            return {
              id,
              title: c.title,
              description: c.description,
              kind: c.kind,
              milestone: c.milestone,
              execution_count: c.exec_order.length,
              created_at: c.created_at,
              latest: latest
                ? { session_id: latest.id, status: latest.status, started_at: latest.started_at ?? null, finished_at: latest.finished_at ?? null }
                : null,
            }
          })
          .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
        send(200, out)
        return
      }
      if (cardsMatch && method === 'POST') {
        const pid = decodeURIComponent(cardsMatch[1])
        const body = await readBody()
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (!title) throw new HttpError(400, 'empty title')
        if (!proj.projects[pid]) throw new HttpError(404, `project '${pid}' not found; create it via POST /api/projects first`)
        const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'task'
        const cardId = genCardId()
        const created = nowMs()
        const criteria = typeof body.acceptance === 'string' && body.acceptance.trim() ? body.acceptance.trim() : null
        // 依赖契约（目标契约 taskgraph）：deps = 同项目已存在卡的 id 数组（含循环检测）
        let deps: string[] = []
        try {
          deps = validateDeps(body.deps, Object.keys(proj.projects[pid]?.cards ?? {}), cardId, (id) => proj.projects[pid]?.cards[id]?.deps ?? [])
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : 'bad deps')
        }
        const meta: CardMeta = {
          id: cardId,
          title,
          description: typeof body.description === 'string' ? body.description : '',
          kind,
          milestone: typeof body.milestone === 'string' ? body.milestone : null,
          criteria,
          deps,
          budget: typeof body.budget === 'number' && body.budget > 0 ? body.budget : null,
          created_at: created,
        }
        ensureCard(proj, pid, meta)
        storage.upsertCard({ ...meta, project_id: pid })
        // brief=false = 裸跑（对照实验 B 组）；group 标记实验组
        const brief = body.brief !== false
        const groupTag = typeof body.group === 'string' && body.group ? body.group : undefined
        // 预设 Profile（§2.6）：preset_id 选择三轴 Profile；缺省 = 项目默认；快照落 executions.preset_json
        storage.seedProfiles(pid)
        const presetReq = typeof body.preset_id === 'string' && body.preset_id.trim()
          ? body.preset_id.trim()
          : typeof body.preset === 'string' && body.preset.trim() ? body.preset.trim() : ''
        const profile = presetReq ? storage.getProfile(pid, presetReq) : storage.defaultProfile(pid)
        if (presetReq && !profile) throw new HttpError(404, `profile '${presetReq}' not found`)
        const presetSnapshot = profile
          ? { id: profile.id, name: profile.name, mode: profile.mode, setting: profile.setting, approval: profile.approval, sandbox: profile.sandbox }
          : null
        // 调度门（§2.1）：依赖全部完成才自动跑首代；未完成 → 卡进入"等上游"（无执行，解锁后自动启动）
        const canAutoStart = depsMet({ deps }, proj.projects[pid]?.cards ?? {})
        let sid: string | null = null
        // D1.6 时机①建卡时校准：先校准需求（提案验收标准 → 人确认 → 写回）再执行
        const calibrateFirst = body.calibrate === true
        if (calibrateFirst) {
          sid = await startCalibration(pid, cardId)
        } else if (canAutoStart) {
          sid = await startExecution(pid, cardId, null, {
            brief, groupTag, criteria,
            // 注意：Profile 是三轴语义（协作方式/执行设定/审批/沙箱），不是 dsh 引擎 preset——
            // 不把 profile.id 透传给 _meta.agentPreset（引擎 preset 是独立的"工具集定制"，P0 不同步）
            presetSnapshot: presetSnapshot ? JSON.stringify(presetSnapshot) : null,
          })
        }
        send(201, { card_id: cardId, session_id: sid, preset: presetSnapshot, started: sid !== null })
        return
      }
      const cardMatch = path.match(/^\/api\/cards\/([^/]+)$/)
      if (cardMatch && method === 'GET') {
        const cardId = decodeURIComponent(cardMatch[1])
        for (const [pid, p] of Object.entries(proj.projects)) {
          const c = p.cards[cardId]
          if (c) {
            send(200, { ...c, project_id: pid })
            return
          }
        }
        throw new HttpError(404, `card '${cardId}' not found`)
      }
      const execMatch = path.match(/^\/api\/cards\/([^/]+)\/executions$/)
      if (execMatch && method === 'POST') {
        const cardId = decodeURIComponent(execMatch[1])
        const body = await readBody()
        const entry = Object.entries(proj.projects).find(([, p]) => p.cards[cardId])
        if (!entry) throw new HttpError(404, `card '${cardId}' not found`)
        const [pid, p] = entry
        const c = p.cards[cardId]
        const from = typeof body.from_execution_id === 'string' && body.from_execution_id.trim()
          ? body.from_execution_id.trim()
          : null
        if (from && !c.executions[from]) throw new HttpError(400, `from_execution_id '${from}' not in card '${cardId}'`)
        const sid = await startExecution(pid, cardId, from)
        send(201, { card_id: cardId, session_id: sid, forked_from: from })
        return
      }
      // D1.7 手动需求校准（D1.6 时机②③：先跑/明确需求后可随时发起）
      const calibrateMatch = path.match(/^\/api\/cards\/([^/]+)\/calibrate$/)
      if (calibrateMatch && method === 'POST') {
        const cardId = decodeURIComponent(calibrateMatch[1])
        const entry = Object.entries(proj.projects).find(([, p]) => p.cards[cardId])
        if (!entry) throw new HttpError(404, `card '${cardId}' not found`)
        const [pid] = entry
        const sid = await startCalibration(pid, cardId)
        send(201, { card_id: cardId, session_id: sid, kind: 'calibrate' })
        return
      }

      // ---------- 简单会话（A 组：两级制松入口，不挂卡不进看板） ----------
      const chatsMatch = path.match(/^\/api\/projects\/([^/]+)\/chats$/)
      if (chatsMatch && method === 'POST') {
        const pid = decodeURIComponent(chatsMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, `project '${pid}' not found`)
        const sid = await acp.sessionNew(p.path, undefined)
        registerSession(proj, sid, pid, '')
        storage.registerChat(sid, pid)
        send(201, { session_id: sid })
        return
      }
      if (chatsMatch && method === 'GET') {
        const pid = decodeURIComponent(chatsMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, `project '${pid}' not found`)
        const out = Object.values(p.chats)
          .map((t) => ({
            session_id: t.id,
            status: t.status,
            turns: t.turns,
            steps: t.steps,
            last_text: t.activities.length ? extractLastText(t) : null,
            started_at: t.started_at ?? null,
          }))
          .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
        send(200, out)
        return
      }
      const chatMatch = path.match(/^\/api\/chats\/([^/]+)$/)
      if (chatMatch && method === 'GET') {
        const sid = decodeURIComponent(chatMatch[1])
        const t = resolveChatTask(sid)
        if (!t) throw new HttpError(404, `chat '${sid}' not found`)
        send(200, t)
        return
      }
      if (chatMatch && method === 'POST') {
        const sid = decodeURIComponent(chatMatch[1])
        const t = resolveChatTask(sid)
        if (!t) throw new HttpError(404, `chat '${sid}' not found`)
        const body = await readBody()
        const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : ''
        if (!text) throw new HttpError(400, 'text required')
        const stopReason = await acp.sessionPrompt(sid, text).catch((e) => {
          console.error(`[chat] ${sid}:`, e)
          return 'error'
        })
        await waitTailer()
        finishSession(proj, sid, stopReason, nowMs())
        send(200, { ok: true, stop_reason: stopReason })
        return
      }
      // 提升为任务（主路径：会话上下文进简报 → 建卡自动跑）
      const promoteMatch = path.match(/^\/api\/chats\/([^/]+)\/promote$/)
      if (promoteMatch && method === 'POST') {
        const sid = decodeURIComponent(promoteMatch[1])
        const pid = proj.sessionProject[sid]
        const p = pid ? proj.projects[pid] : undefined
        const t = resolveChatTask(sid)
        if (!p || !t) throw new HttpError(404, `chat '${sid}' not found`)
        const body = await readBody()
        const cardId = genCardId()
        const created = nowMs()
        const firstUser = t.comments.find((c) => c.who === 'user')?.text ?? ''
        const title = typeof body.title === 'string' && body.title.trim()
          ? body.title.trim()
          : firstUser.split('\n')[0]?.slice(0, 60) || `会话提升 ${new Date(created).toLocaleTimeString()}`
        const description = typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : `${firstUser}\n\n（提升自简单会话 · 完整上下文见会话 ${sid.slice(0, 8)}）`.trim()
        const meta: CardMeta = {
          id: cardId, title, description, kind: 'task',
          milestone: null, criteria: null, deps: [], created_at: created,
        }
        ensureCard(proj, pid, meta)
        storage.upsertCard({ ...meta, project_id: pid })
        // 会话转卡执行（挂到新卡下，保留事件流）
        delete p.chats[sid]
        p.cards[cardId].executions[sid] = t
        p.cards[cardId].exec_order.push(sid)
        proj.sessionCard[sid] = cardId
        storage.unregisterChat(sid)
        storage.upsertExecution({
          id: sid, card_id: cardId, status: t.status,
          preset_json: '{}', deps_json: '[]',
          forked_from: null, started_at: t.started_at ?? null, finished_at: t.finished_at ?? null, created_at: created,
        })
        // 首代执行（上下文 = 会话上下文已进 description → 简报）
        const newSid = await startExecution(pid, cardId, null, { brief: true })
        send(201, { card_id: cardId, session_id: newSid, chat_session: sid })
        return
      }
      // 存入知识库（会话结论 → KB 笔记）
      const kbFromChatMatch = path.match(/^\/api\/chats\/([^/]+)\/kb$/)
      if (kbFromChatMatch && method === 'POST') {
        const sid = decodeURIComponent(kbFromChatMatch[1])
        const pid = proj.sessionProject[sid]
        const t = resolveChatTask(sid)
        if (!pid || !t) throw new HttpError(404, `chat '${sid}' not found`)
        const body = await readBody()
        const conclusion = extractConclusion({
          taskTitle: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '会话结论',
          comments: t.comments.map((cm) => ({ who: cm.who, text: cm.text })),
          activities: t.activities,
          turns: t.turns,
          status: t.status,
        })
        const note = makeNote({
          projectId: pid,
          title: conclusion?.title ?? (typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '会话结论'),
          content: conclusion?.content ?? [],
          tags: ['chat'],
          keywords: conclusion?.keywords ?? [],
          summary: conclusion?.summary ?? '',
          sourceKind: 'task',
          sourceRef: sid,
          trust: 'human-approved', // 用户主动判断"值得记住" = 背书（主观 human-approved）
        })
        storage.upsertNote(note)
        send(201, { note_id: note.id })
        return
      }

      // 手动标记状态（设计状态机：任意可操作状态 → 手动标记完成/失败/待办；红线：事件接口，非前端直改）
      const statusMatch = path.match(/^\/api\/cards\/([^/]+)\/status$/)
      if (statusMatch && method === 'POST') {
        const cardId = decodeURIComponent(statusMatch[1])
        const entry = Object.entries(proj.projects).find(([, p]) => p.cards[cardId])
        if (!entry) throw new HttpError(404, `card '${cardId}' not found`)
        const [pid, p] = entry
        const card = p.cards[cardId]
        const body = await readBody()
        const status = body.status === 'Done' || body.status === 'Failed' || body.status === 'Pending' ? body.status : null
        if (!status) throw new HttpError(400, 'status must be Done|Failed|Pending')
        const t = latestExecution(card)
        if (!t) throw new HttpError(400, 'card has no execution to mark')
        t.status = status
        if (status === 'Done') { t.finished_at = t.finished_at ?? nowMs() } else { t.finished_at = undefined }
        storage.upsertExecution({
          id: t.id, card_id: cardId, status,
          preset_json: '{}', deps_json: JSON.stringify(card.deps ?? []),
          forked_from: null, started_at: t.started_at ?? null, finished_at: t.finished_at ?? null,
          created_at: card.created_at,
        })
        // 手动标记 Done → 调度门可能解锁下游
        void kickStartDownstream(pid)
        send(200, { ok: true, status })
        return
      }

      // ---------- 任务（兼容旧接口 + 评论/取消） ----------
      const tasksMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/)
      if (tasksMatch && method === 'POST') {
        const pid = decodeURIComponent(tasksMatch[1])
        const body = await readBody()
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        const title = prompt.split('\n')[0]?.trim() || prompt
        if (!proj.projects[pid]) throw new HttpError(404, `project '${pid}' not found; create it via POST /api/projects first`)
        const cardId = genCardId()
        const created = nowMs()
        const meta: CardMeta = { id: cardId, title, description: '', kind: 'task', milestone: null, criteria: null, deps: [], created_at: created }
        ensureCard(proj, pid, meta)
        storage.upsertCard({ ...meta, project_id: pid })
        const sid = await startExecution(pid, cardId, null)
        send(201, { session_id: sid, card_id: cardId })
        return
      }
      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/)
      if (taskMatch && method === 'GET') {
        const sid = decodeURIComponent(taskMatch[1])
        const cardId = proj.sessionCard[sid]
        const pid = proj.sessionProject[sid]
        const t = pid ? proj.projects[pid]?.cards[cardId]?.executions[sid] : undefined
        if (!t) throw new HttpError(404, 'task not found')
        send(200, t)
        return
      }
      const commentMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments$/)
      if (commentMatch && method === 'POST') {
        const sid = decodeURIComponent(commentMatch[1])
        const body = await readBody()
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) throw new HttpError(400, 'empty comment')
        if (!proj.sessionProject[sid]) throw new HttpError(404, 'task not found')
        void acp.sessionPrompt(sid, text).catch((e) => console.error(`[comment] ${sid} failed:`, e))
        send(200, { ok: true })
        return
      }
      const cancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/)
      if (cancelMatch && method === 'POST') {
        const sid = decodeURIComponent(cancelMatch[1])
        await acp.sessionCancel(sid)
        send(200, { ok: true })
        return
      }

      // ---------- 批复队列（P0：Waiting 状态机） ----------
      // POST /api/tasks/:sid/waiting —— 触发 Waiting{kind}（任务停在等待批复，原会话挂起）
      const waitingMatch = path.match(/^\/api\/tasks\/([^/]+)\/waiting$/)
      if (waitingMatch && method === 'POST') {
        const sid = decodeURIComponent(waitingMatch[1])
        const body = await readBody()
        const kind = body.kind === 'plan' || body.kind === 'permission' || body.kind === 'acceptance' || body.kind === 'cost'
          ? body.kind
          : 'permission'
        const reason = typeof body.reason === 'string' ? body.reason : ''
        const pid = proj.sessionProject[sid]
        const cardId = proj.sessionCard[sid]
        const t = pid ? proj.projects[pid]?.cards[cardId]?.executions[sid] : undefined
        if (!t || !pid) throw new HttpError(404, 'task not found')
        t.waiting = { kind, reason, payload: typeof body.payload === 'object' && body.payload !== null ? body.payload as Record<string, unknown> : {} }
        t.status = 'Running' // Waiting 是派生状态，底层仍挂起（前端 effectiveStatus 映射为 Waiting）
        const aid = storage.insertApproval({
          id: 0,
          project_id: pid,
          execution_id: sid,
          kind,
          payload: typeof body.payload === 'object' && body.payload !== null ? body.payload as Record<string, unknown> : {},
          reason: reason || null,
          outcome: null,
          comment: null,
          created_at: nowMs(),
          decided_at: null,
          suspended_at: null,
        })
        send(201, { approval_id: aid, kind, reason })
        return
      }

      // ---------- 预设 Profile（P0 §2.6：三轴组合 = 命名 Profile，项目级） ----------
      // GET /api/projects/:pid/presets —— Profile 列表（含三轴明细 + 默认标记）
      const listProfilesMatch = path.match(/^\/api\/projects\/([^/]+)\/presets$/)
      if (listProfilesMatch && method === 'GET') {
        const pid = decodeURIComponent(listProfilesMatch[1])
        if (!proj.projects[pid]) throw new HttpError(404, 'project not found')
        storage.seedProfiles(pid)
        send(200, storage.listProfiles(pid))
        return
      }
      // POST /api/projects/:pid/presets —— 自定义 Profile（复制内置/现有，改三轴存新）
      if (listProfilesMatch && method === 'POST') {
        const pid = decodeURIComponent(listProfilesMatch[1])
        if (!proj.projects[pid]) throw new HttpError(404, 'project not found')
        const body = await readBody()
        const id = typeof body.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(body.id) ? body.id : null
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
        if (!id || !name) throw new HttpError(400, 'id (小写连字符) 和 name 必填')
        const mode = body.mode === 'normal' || body.mode === 'plan' || body.mode === 'goal' ? body.mode : 'normal'
        const setting = body.setting === 'light' || body.setting === 'balanced' || body.setting === 'delivery' ? body.setting : 'balanced'
        const approval = body.approval === 'ask' || body.approval === 'auto' || body.approval === 'yolo' ? body.approval : 'ask'
        const sandbox = body.sandbox === 'read-only' || body.sandbox === 'workspace-write' || body.sandbox === 'danger-full-access' ? body.sandbox : 'workspace-write'
        storage.seedProfiles(pid)
        const existing = storage.getProfile(pid, id)
        if (existing?.is_builtin) throw new HttpError(409, `内置 Profile '${id}' 不可覆盖；请用新 id 自定义`)
        storage.upsertProfile(pid, {
          id, name, is_builtin: false,
          mode, setting, approval, sandbox,
          is_default: existing?.is_default ?? false,
        })
        send(201, storage.getProfile(pid, id))
        return
      }
      // POST /api/projects/:pid/presets/:id/default —— 设项目默认
      const defaultProfileMatch = path.match(/^\/api\/projects\/([^/]+)\/presets\/([^/]+)\/default$/)
      if (defaultProfileMatch && method === 'POST') {
        const pid = decodeURIComponent(defaultProfileMatch[1])
        const id = decodeURIComponent(defaultProfileMatch[2])
        if (!storage.setDefaultProfile(pid, id)) throw new HttpError(404, `profile '${id}' not found`)
        send(200, { ok: true, default: id })
        return
      }
      // DELETE /api/projects/:pid/presets/:id —— 删自定义；内置 409；删的是默认则回落到内置
      const oneProfileMatch = path.match(/^\/api\/projects\/([^/]+)\/presets\/([^/]+)$/)
      if (oneProfileMatch && method === 'DELETE') {
        const pid = decodeURIComponent(oneProfileMatch[1])
        const id = decodeURIComponent(oneProfileMatch[2])
        if (!proj.projects[pid]) throw new HttpError(404, 'project not found')
        const existing = storage.getProfile(pid, id)
        if (!existing) throw new HttpError(404, `profile '${id}' not found`)
        if (existing.is_builtin) throw new HttpError(409, '内置预设不可删')
        if (!storage.removeProfile(pid, id)) throw new HttpError(409, '删除失败')
        send(200, { ok: true, default: storage.defaultProfile(pid)?.id ?? null })
        return
      }

      // GET /api/approvals?project= —— 批复队列（待批复 + 等待原因 + 策略建议）
      if (method === 'GET' && path === '/api/approvals') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        const pending = storage.listPendingApprovals(projectId)
        // 附带任务标题/卡归属/策略建议（队列展示需要；建议 = 同类批复历史沉淀，count>=2 才建议）
        const enriched = pending.map((a) => {
          const t = proj.projects[a.project_id]?.cards[proj.sessionCard[a.execution_id]]?.executions[a.execution_id]
          const cardId = proj.sessionCard[a.execution_id] ?? null
          const cardKind = cardId ? proj.projects[a.project_id]?.cards[cardId]?.kind : null
          return {
            ...a,
            task_title: t?.title ?? a.execution_id,
            card_id: cardId,
            card_kind: cardKind ?? null,
            waiting: t?.waiting ?? null,
            policy_suggestion: policySuggestion(storage, projectId, a.kind, cardKind),
          }
        })
        send(200, enriched)
        return
      }

      // ---------- 超时挂起（O5：挂起列表 / 恢复 / 批量恢复） ----------
      if (method === 'GET' && path === '/api/approvals/suspended') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        const suspended = storage.listSuspendedApprovals(projectId).map((a) => ({
          ...a,
          task_title: resolveAnyTask(a.execution_id)?.title ?? a.execution_id,
          card_id: proj.sessionCard[a.execution_id] ?? null,
        }))
        send(200, suspended)
        return
      }
      const resumeMatch = path.match(/^\/api\/approvals\/(\d+)\/resume$/)
      if (resumeMatch && method === 'POST') {
        const id = Number(resumeMatch[1])
        const appr = storage.getApproval(id)
        if (!appr) throw new HttpError(404, `approval ${id} not found`)
        if (!storage.resumeApproval(id)) throw new HttpError(409, 'not suspended')
        const t = resolveAnyTask(appr.execution_id)
        if (t?.waiting) delete t.waiting.payload.suspended_at
        send(200, { ok: true })
        return
      }
      const resumeAllMatch = path.match(/^\/api\/projects\/([^/]+)\/approvals\/resume-all$/)
      if (resumeAllMatch && method === 'POST') {
        const projectId = decodeURIComponent(resumeAllMatch[1])
        const n = storage.resumeAllApprovals(projectId)
        for (const a of storage.listPendingApprovals(projectId)) {
          const t = resolveAnyTask(a.execution_id)
          if (t?.waiting) delete t.waiting.payload.suspended_at
        }
        send(200, { ok: true, resumed: n })
        return
      }

      // ---------- 策略学习（P1 O6：规则可查看可删除） ----------
      if (method === 'GET' && path === '/api/policies') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        send(200, storage.listPolicies(projectId))
        return
      }
      const policyMatch = path.match(/^\/api\/policies\/(\d+)$/)
      if (policyMatch && method === 'DELETE') {
        if (!storage.deletePolicy(Number(policyMatch[1]))) throw new HttpError(404, 'policy not found')
        send(200, { ok: true })
        return
      }

      // POST /api/approvals/:id —— 决策：approve/reject（决策必须带评论送达 agent）
      const approvalMatch = path.match(/^\/api\/approvals\/(\d+)$/)
      if (approvalMatch && method === 'POST') {
        const id = Number(approvalMatch[1])
        const body = await readBody()
        const outcome = body.outcome === 'approved' ? 'approved' : body.outcome === 'rejected' ? 'rejected' : null
        if (!outcome) throw new HttpError(400, 'outcome must be approved|rejected')
        const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
        const remember = body.remember === true
        const appr = storage.getApproval(id)
        if (!appr) throw new HttpError(404, `approval ${id} not found`)
        // 验收/成本批准先合入隔离区；冲突则 409 且保持待批复，避免人点过了文件却没进去。
        if ((appr.kind === 'acceptance' || appr.kind === 'cost') && outcome === 'approved') {
          const cardId0 = proj.sessionCard[appr.execution_id]
          const p0 = proj.projects[appr.project_id]
          const card0 = p0?.cards[cardId0]
          const ct0 = card0?.executions[appr.execution_id]
          if (ct0?.worktree && p0) {
            const mr = mergeTaskWorktree({
              repo: p0.path,
              worktree: ct0.worktree,
              message: `helmsman: ${card0?.title ?? cardId0}`,
            })
            if (!mr.ok) throw new HttpError(409, mr.error ?? '合入主工作区失败')
            ct0.worktree = null
            storage.setExecutionWorktree(appr.execution_id, null, null)
          }
        }
        if (!storage.decideApproval(id, outcome, comment)) throw new HttpError(409, 'already decided')
        // 策略学习（P1 O6）：remember=true → 沉淀策略原子（kind × 卡类型 × outcome 累计）
        if (remember) {
          const cardId = proj.sessionCard[appr.execution_id]
          const cardKind = cardId ? proj.projects[appr.project_id]?.cards[cardId]?.kind : null
          storage.learnPolicy(appr.project_id, appr.kind, cardKind || 'task', outcome)
        }
        // 决策送达 agent：评论回灌 + 放行（Waiting 清除，任务可继续）
        const sid = appr.execution_id
        const t = proj.projects[appr.project_id]?.cards[proj.sessionCard[sid]]?.executions[sid]
        if (t) t.waiting = null
        // D1.7 需求校准决策：批准 → 提案写回卡的验收标准（criteria）并自动启动正常执行；拒绝 → 仅评论送达
        if (appr.kind === 'calibrate') {
          const cardId = proj.sessionCard[sid]
          const card = proj.projects[appr.project_id]?.cards[cardId]
          if (outcome === 'approved' && card) {
            const proposal = typeof appr.payload?.criteria_proposal === 'string' ? appr.payload.criteria_proposal : null
            if (proposal) {
              card.criteria = proposal
              storage.upsertCard({
                id: card.id,
                project_id: appr.project_id,
                title: card.title,
                description: card.description,
                kind: card.kind,
                milestone: card.milestone,
                criteria: proposal,
                budget: card.budget ?? null,
                deps: card.deps ?? [],
                created_at: card.created_at,
              })
              // G1 修复：自动启动带 criteria（进简报 + Done 时触发外部验收门）；依赖未完成 → 409 由 kickStartDownstream 兜底
              if (depsMet(card, proj.projects[appr.project_id]?.cards ?? {})) {
                void startExecution(appr.project_id, cardId, null, { criteria: proposal }).catch((e) => {
                  console.warn(`[calibrate] auto-start ${cardId} failed: ${e instanceof Error ? e.message : e}`)
                })
              }
            }
          }
          // G3 修复：校准会话批复后结束（批准/拒绝都是终态，不留僵尸 Running）
          finishSession(proj, sid, 'end_turn', nowMs())
          const ct = proj.projects[appr.project_id]?.cards[proj.sessionCard[sid]]?.executions[sid]
          if (ct) {
            const oldEx = storage.getExecutionBySession(sid)
            storage.upsertExecution({
              id: sid,
              card_id: proj.sessionCard[sid],
              status: ct.status,
              preset_json: '{}',
              deps_json: '[]',
              forked_from: null,
              started_at: ct.started_at ?? null,
              finished_at: ct.finished_at ?? null,
              created_at: oldEx?.created_at ?? nowMs(),
            })
          }
        }
        // Waiting{cost} 决策（P1.5）：批准 = 接受成本，任务完成；拒绝 = 停止（Cancelled）
        if (appr.kind === 'cost') {
          const pCost = proj.projects[appr.project_id]
          const cardCost = pCost?.cards[proj.sessionCard[sid]]
          const ct = cardCost?.executions[sid]
          if (ct) {
            ct.waiting = null
            ct.status = outcome === 'approved' ? 'Done' : 'Cancelled'
            if (outcome === 'approved') ct.finished_at = ct.finished_at ?? nowMs()
            if (ct.worktree && pCost) {
              if (outcome === 'approved') {
                const mr = mergeTaskWorktree({ repo: pCost.path, worktree: ct.worktree, message: `helmsman: ${cardCost?.title ?? sid}` })
                if (mr.ok) {
                  ct.worktree = null
                  storage.setExecutionWorktree(sid, null, null)
                }
              } else {
                discardTaskWorktree(pCost.path, ct.worktree)
                ct.worktree = null
                storage.setExecutionWorktree(sid, null, null)
              }
            }
            const oldEx = storage.getExecutionBySession(sid)
            storage.upsertExecution({
              id: sid, card_id: proj.sessionCard[sid], status: ct.status,
              preset_json: ct.preset ? JSON.stringify(ct.preset) : '{}', deps_json: '[]',
              forked_from: null, started_at: ct.started_at ?? null, finished_at: ct.finished_at ?? null,
              created_at: oldEx?.created_at ?? appr.created_at,
            })
            // M6(server)：预算批复后补 metrics（终态确定才落账，引用检测/债务统计需要这条）
            const cu = ct.usage
            const cCost = estCostFrom(cu, priceOf(ct.model))
            const cHit = cu.inputTokens + cu.cacheReadTokens > 0 ? cu.cacheReadTokens / (cu.inputTokens + cu.cacheReadTokens) : 0
            storage.insertMetric({
              project_id: appr.project_id,
              task_id: sid,
              brief_snapshot: [],
              outcome: ct.status,
              cited_entries: [],
              turns: ct.turns,
              steps: ct.steps,
              verified: undefined,
              cost: Math.round(cCost * 10000) / 10000,
              cache_hit: Math.round(cHit * 10000) / 10000,
              in_tokens: cu.inputTokens,
              cache_tokens: cu.cacheReadTokens,
              out_tokens: cu.outputTokens,
              reason_tokens: cu.reasoningTokens,
              created_at: nowMs(),
            })
            if (outcome === 'rejected') void acp.sessionCancel(sid).catch(() => {})
          }
          // 任务已结束：不发 sessionPrompt（避免 agent 响应触发 tailer 预算检查重新挂起）
          send(200, { ok: true, outcome, id })
          return
        }
        // 便宜验收：批准 = 已在 decide 前合入隔离区 + merge 知识；拒绝 = 丢掉 worktree、不入库。
        if (appr.kind === 'acceptance') {
          const cardId = proj.sessionCard[sid]
          const card = proj.projects[appr.project_id]?.cards[cardId]
          const ct = card?.executions[sid]
          const pAcc = proj.projects[appr.project_id]
          if (outcome === 'approved' && card && ct) {
            await persistAgentNote(appr.project_id, cardId, card.title, ct)
          }
          if (outcome === 'rejected' && ct) {
            // M6：拒绝 = 改动被丢弃 → 卡置 Cancelled，下游不得按"完成"放行
            if (ct.worktree && pAcc) {
              discardTaskWorktree(pAcc.path, ct.worktree)
              ct.worktree = null
              storage.setExecutionWorktree(sid, null, null)
            }
            ct.status = 'Cancelled'
            ct.waiting = null
            const exOld = storage.getExecutionBySession(sid)
            storage.upsertExecution({
              id: sid, card_id: cardId, status: 'Cancelled',
              preset_json: ct.preset ? JSON.stringify(ct.preset) : '{}', deps_json: '[]',
              forked_from: null, started_at: ct.started_at ?? null, finished_at: ct.finished_at ?? null,
              created_at: exOld?.created_at ?? appr.created_at,
            })
          }
          send(200, { ok: true, outcome, id })
          return
        }
        // 目标模式检查点决策（D1.8）：批准 = 继续下一阶段；拒绝 = 带修改意见调整方向（循环驱动）
        if (appr.kind === 'checkpoint') {
          const cardId = proj.sessionCard[sid]
          const goalSteer = outcome === 'approved'
            ? `[批复] 方向确认，继续。${comment ? `意见：${comment}` : ''}`
            : `[批复] 需调整方向：${comment || '请调整后继续'}`
          void runGoalLoop(appr.project_id, cardId, sid, goalSteer)
          send(200, { ok: true, outcome, id })
          return
        }
        const steer = outcome === 'approved'
          ? `[批复] 已批准（${appr.kind}）：${comment || '继续执行'}`
          : `[批复] 已拒绝（${appr.kind}）：${comment || '请调整方案'}`
        void acp.sessionPrompt(sid, steer)
          .then(async () => {
            await waitTailer()
            await settleWorktreeOnDone(appr.project_id, proj.sessionCard[sid], sid, nowMs())
          })
          .catch((e) => console.error(`[approval] steer ${sid} failed:`, e))
        send(200, { ok: true, outcome, id })
        return
      }

      // ---------- 知识库（M4） ----------
      if (method === 'GET' && path === '/api/kb/notes') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        const notes = storage.listNotes(projectId)
        const history = storage.listMetrics(projectId)
        send(200, notes.map((n) => ({ ...n, debt: scoreNoteDebt(n.id, history) })))
        return
      }
      if (method === 'GET' && path === '/api/kb/search') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        const q = url.searchParams.get('q') ?? ''
        const notes = storage.listNotes(projectId)
        const hits = q ? await retrieveHybrid(notes, deriveQueries(q), q, { limit: 8 }) : []
        send(200, hits.map((h) => ({ note: h.note, score: Math.round(h.score * 100) / 100 })))
        return
      }
      if (method === 'POST' && path === '/api/kb/notes') {
        const body = await readBody()
        const projectId = typeof body.project === 'string' ? body.project : 'helmsman'
        if (!proj.projects[projectId]) throw new HttpError(404, `project '${projectId}' not found`)
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : ''
        if (!title) throw new HttpError(400, 'empty title')
        const note = makeNote({
          projectId,
          title,
          content: Array.isArray(body.content) ? (body.content as unknown[]).filter((x): x is string => typeof x === 'string') : [String(body.content ?? '')],
          tags: Array.isArray(body.tags) ? (body.tags as unknown[]).filter((x): x is string => typeof x === 'string') : [],
          keywords: [],
          summary: typeof body.summary === 'string' ? body.summary : '',
          sourceKind: 'human',
          sourceRef: 'manual',
          trust: 'human-approved',
        })
        storage.upsertNote(note)
        send(201, note)
        return
      }
      const invalidateMatch = path.match(/^\/api\/kb\/notes\/([^/]+)\/invalidate$/)
      if (invalidateMatch && method === 'POST') {
        const id = decodeURIComponent(invalidateMatch[1])
        if (!storage.getNote(id)) throw new HttpError(404, `note '${id}' not found`)
        storage.invalidateNote(id, 'user', Date.now())
        send(200, { ok: true })
        return
      }
      const pinMatch = path.match(/^\/api\/kb\/notes\/([^/]+)\/stable$/)
      if (pinMatch && method === 'POST') {
        const id = decodeURIComponent(pinMatch[1])
        const note = storage.getNote(id)
        if (!note) throw new HttpError(404, `note '${id}' not found`)
        const body = await readBody()
        const pinned = body.pinned !== false
        note.tags = withStableTag(note.tags, pinned)
        storage.upsertNote(note)
        send(200, storage.getNote(id))
        return
      }
      const noteMatch = path.match(/^\/api\/kb\/notes\/([^/]+)$/)
      if (noteMatch && method === 'DELETE') {
        storage.deleteNote(decodeURIComponent(noteMatch[1]))
        send(200, { ok: true })
        return
      }

      // ---------- 度量（M4 §5.2） ----------
      if (method === 'GET' && path === '/api/metrics') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        send(200, storage.listMetrics(projectId))
        return
      }

      // ---------- 对照实验（§6C 实验 A） ----------
      if (method === 'POST' && path === '/api/experiments/run') {
        const body = (await readBody()) as {
          project_id?: unknown
          tasks?: unknown
          brief?: unknown
          name?: unknown
        }
        const projectId = typeof body.project_id === 'string' ? body.project_id : 'helmsman'
        if (!proj.projects[projectId]) throw new HttpError(404, `project '${projectId}' not found`)
        if (!Array.isArray(body.tasks) || body.tasks.length === 0) throw new HttpError(400, 'tasks required')
        const brief = body.brief !== false
        const group = brief ? 'A' : 'B'
        const name = typeof body.name === 'string' && body.name ? body.name : brief ? 'A 带装配' : 'B 裸跑'
        const created: Array<{ card_id: string; session_id: string; title: string }> = []
        for (const t of body.tasks as Array<{ title?: unknown; description?: unknown; acceptance?: unknown }>) {
          const title = typeof t?.title === 'string' ? t.title.trim() : ''
          if (!title) continue
          const cardId = genCardId()
          const criteria = typeof t?.acceptance === 'string' && t.acceptance.trim() ? t.acceptance.trim() : null
          const meta: CardMeta = {
            id: cardId,
            title,
            description: typeof t?.description === 'string' ? t.description : '',
            kind: 'task',
            milestone: null,
            criteria,
            deps: [],
            created_at: nowMs(),
          }
          ensureCard(proj, projectId, meta)
          storage.upsertCard({ ...meta, project_id: projectId })
          const sid = await startExecution(projectId, cardId, null, { brief, groupTag: `${group}:${name}`, criteria })
          created.push({ card_id: cardId, session_id: sid, title })
        }
        send(201, { group, name, created })
        return
      }
      if (method === 'GET' && path === '/api/experiments/compare') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        const all = storage.listMetrics(projectId)
        // 按 group_tag 前缀分组（A/B）
        const aRows = all.filter((m) => m.group_tag?.startsWith('A'))
        const bRows = all.filter((m) => m.group_tag?.startsWith('B'))
        send(200, compareReport(aRows, bRows))
        return
      }

      // ---------- fs ----------
      if (method === 'POST' && path === '/api/fs/pick') {
        try {
          const out = execSync('osascript -e \'POSIX path of (choose folder with prompt "选择项目目录")\'', {
            encoding: 'utf8',
            timeout: 60000,
          }).trim()
          send(200, out ? { cancelled: false, path: out } : { cancelled: true })
        } catch {
          send(200, { cancelled: true })
        }
        return
      }
      if (method === 'GET' && path === '/api/fs/list') {
        const home = homedir()
        const raw = url.searchParams.get('path') || home
        const canon = resolve(raw)
        const entries: Array<{ name: string; path: string; is_dir: boolean; is_symlink: boolean }> = []
        let dirEntries: Array<{ name: string; isDir: boolean; isSymlink: boolean }> = []
        try {
          dirEntries = readdirSync(canon, { withFileTypes: true }).map((e) => ({
            name: e.name,
            isDir: e.isDirectory(),
            isSymlink: e.isSymbolicLink(),
          }))
        } catch {
          /* ignore */
        }
        for (const e of dirEntries) {
          if (e.name.startsWith('.')) continue
          entries.push({ name: e.name, path: join(canon, e.name), is_dir: e.isDir, is_symlink: e.isSymlink })
        }
        entries.sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || (a.name < b.name ? -1 : 1))
        send(200, { path: canon, parent: dirname(canon), entries })
        return
      }
      if (method === 'GET' && path === '/api/fs/find') {
        const name = url.searchParams.get('name') ?? ''
        if (!name) throw new HttpError(400, 'empty name')
        const max = Math.min(Math.max(Number(url.searchParams.get('max') ?? 5), 1), 20)
        const home = homedir()
        const found: Array<{ name: string; path: string }> = []
        let visited = 0
        const queue: Array<[string, number]> = [[home, 0]]
        while (queue.length > 0 && found.length < max && visited < 30000) {
          const [dir, depth] = queue.shift()!
          visited += 1
          let children: Array<{ name: string; isDir: boolean; isSymlink: boolean }> = []
          try {
            children = readdirSync(dir, { withFileTypes: true }).map((e) => ({
              name: e.name,
              isDir: e.isDirectory(),
              isSymlink: e.isSymbolicLink(),
            }))
          } catch {
            continue
          }
          for (const e of children) {
            if (e.name.startsWith('.')) continue
            if (e.isSymlink) continue
            if (!e.isDir) continue
            if (e.name === name && found.length < max) found.push({ name: e.name, path: join(dir, e.name) })
            if (depth < 4 && found.length < max) queue.push([join(dir, e.name), depth + 1])
          }
        }
        send(200, { name, matches: found, truncated: visited >= 30000 })
        return
      }

      send(404, { error: 'not found' })
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: err.message })
      else {
        console.error('[http] error:', err)
        send(500, { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  // ---------- 启动 ----------
  server.listen(PORT, () => {
    console.log(`[http] helmsman-ts serving on http://127.0.0.1:${PORT}`)
  })

  const shutdown = async (): Promise<void> => {
    console.log('[http] shutting down')
    server.close()
    await engine.dispose()
    storage.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

/** 卡状态计数（按最新执行聚合，枚举固定顺序） */
function cardStatusCounts(p: Project): number[] {
  const c = [0, 0, 0, 0, 0] // Pending, Running, Done, Failed, Cancelled
  for (const card of Object.values(p.cards)) {
    const t = latestExecution(card)
    const i = t ? ['Pending', 'Running', 'Done', 'Failed'].indexOf(t.status) : 0
    c[i >= 0 ? i : 4] += 1
  }
  return c
}

let WT_SEQ = 0 // worktree key 全局计数器（同毫秒并发执行防撞名）

function latestExecution(card: CardState): CardState['executions'][string] | null {
  const order = card.exec_order.length ? card.exec_order : Object.keys(card.executions)
  const sid = order[order.length - 1]
  return (sid && card.executions[sid]) || null
}

/** G6：ACP session/prompt resolve 与 JSONL 落盘竞态——等 tailer（轮询 200ms）fold 完最后事件再检测产出标记。 */
function waitTailer(ms = 600): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


/** 工作区文件树（目标契约：活状态现取）。过滤：node_modules/.git/.sessions/.npm-cache/dist/*.db/.DS_Store；限深 5、每目录 100 项。 */
function listFileTree(dir: string, depth = 0): { name: string; type: 'file' | 'dir'; children?: unknown[] } {
  const SKIP = new Set(['node_modules', '.git', '.sessions', '.npm-cache', 'dist', 'research', 'docs-archive', 'design-mockups', '.DS_Store'])
  const name = basename(dir)
  const out: { name: string; type: 'file' | 'dir'; children?: unknown[] } = { name, type: 'dir', children: [] }
  if (depth > 5) return { ...out, children: undefined }
  let entries: string[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !SKIP.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      .slice(0, 100)
      .map((e) => e.name)
  } catch { return { ...out, children: undefined } }
  for (const n of entries) {
    const full = join(dir, n)
    try {
      const st = statSync(full)
      if (st.isDirectory()) out.children!.push(listFileTree(full, depth + 1))
      else out.children!.push({ name: n, type: 'file' })
    } catch { /* 跳过不可读 */ }
  }
  return out
}

/** 读取项目工作区内文件（预览用）。
 * 安全：路径解析到工作区内（防穿越）；路径段命中 SKIP/隐藏 → 拒绝；大小 ≤ 256KB（超出截断标记）；二进制（含 NUL）→ 不返回内容。 */
const SKIP_SET = new Set(['node_modules', '.git', '.sessions', '.npm-cache', 'dist', 'research', 'docs-archive', 'design-mockups', '.DS_Store'])
function readProjectFile(workspace: string, rel: string): {
  path: string; name: string; size: number; content: string; truncated: boolean; binary: boolean
} {
  if (!rel || rel.includes('\0')) throw new Error('bad path')
  const full = resolve(workspace, rel)
  if (!full.startsWith(resolve(workspace) + '/') && full !== resolve(workspace)) throw new Error('path escapes workspace')
  const segs = rel.split('/')
  if (segs.some((s) => SKIP_SET.has(s) || s.startsWith('.'))) throw new Error('path not allowed')
  let st: ReturnType<typeof statSync>
  try { st = statSync(full) } catch { throw new Error('not found') }
  if (!st.isFile()) throw new Error('not a file')
  const size = st.size
  if (size > 262144) {
    return { path: rel, name: basename(full), size, content: '', truncated: true, binary: false }
  }
  const buf = readFileSync(full)
  // 二进制检测：前 8KB 含 NUL
  const head = buf.subarray(0, 8192)
  const binary = head.includes(0)
  if (binary) return { path: rel, name: basename(full), size, content: '', truncated: false, binary: true }
  return { path: rel, name: basename(full), size, content: buf.toString('utf8'), truncated: false, binary: false }
}

/** 仓库活状态：分支 + 改动列表（VSCode 源码管理风格）+ 分支列表 + 提交历史 + ahead/behind。非 git 仓库给 error。 */
export interface RepoChange { code: string; staged: boolean; path: string }
export interface RepoBranch { name: string; current: boolean }
export interface RepoCommit { hash: string; when: string; subject: string }
function repoStatus(workspace: string): {
  branch: string; dirty: number; staged: number; untracked: number; conflicted: number
  ahead: number; behind: number; lastCommit: string
  changes: RepoChange[]; branches: RepoBranch[]; history: RepoCommit[]; error?: string
} {
  // execFileSync 不经 shell：避免 %(refname:short) 这类参数被 sh 解析（%() 语法错误）
  const git = (args: string[], opts: { timeoutMs?: number; trim?: boolean } = {}): string => {
    try {
      const out = execFileSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: opts.timeoutMs ?? 5000 })
      return opts.trim === false ? out : out.trim()
    } catch { return '' }
  }
  if (!git(['rev-parse', '--is-inside-work-tree'])) {
    return { branch: '', dirty: 0, staged: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0, lastCommit: '', changes: [], branches: [], history: [], error: 'not a git repo' }
  }
  const branch = git(['branch', '--show-current'])
  const status = git(['status', '--porcelain'], { trim: false }).split('\n').filter(Boolean).map((l) => l.replace(/\r$/, ''))
  // porcelain 行格式 `XY path`：X = 暂存区状态，Y = 工作区状态；冲突时 X 或 Y 为 U（UU/AA/AU…）
  const staged = status.filter((l) => /^[MADRCU]/.test(l)).length
  const untracked = status.filter((l) => /^\?\?/.test(l)).length
  const conflicted = status.filter((l) => l.length >= 2 && (l[0] === 'U' || l[1] === 'U')).length
  // 改动列表：code = 用户可见状态（M 改 / A 增 / D 删 / ? 新 / U 冲突），staged 标记
  const changes: RepoChange[] = status.map((l) => {
    const x = l[0] ?? ' '
    const y = l[1] ?? ' '
    const path = l.slice(3).replace(/^"|"$/g, '')
    if (x === '?' && y === '?') return { code: '?', staged: false, path }
    const conflictedFlag = x === 'U' || y === 'U'
    if (conflictedFlag) return { code: 'U', staged: false, path }
    const code = y !== ' ' ? y : x
    return { code, staged: x !== ' ' && x !== '?', path }
  })
  // 分支列表（含当前分支标记；过滤任务隔离区 worktree 分支 —— helmsman/card-… 内部噪音）
  const branches: RepoBranch[] = git(['branch', '--format=%(refname:short)'])
    .split('\n').filter(Boolean)
    .filter((name) => !name.startsWith('helmsman/card-'))
    .map((name) => ({ name, current: name === branch }))
  // 提交历史（最近 6 条：hash / 相对时间 / subject）
  const history: RepoCommit[] = git(['log', '-6', '--format=%h%x09%ar%x09%s'])
    .split('\n').filter(Boolean)
    .map((l) => {
      const [hash, when, ...rest] = l.split('\t')
      return { hash, when: when ?? '', subject: rest.join('\t') }
    })
  const lastCommit = history[0] ? `${history[0].hash} ${history[0].subject}` : ''
  // ahead/behind：有 upstream 时 rev-list --left-right --count HEAD...@{u} → "ahead\tbehind"
  let ahead = 0
  let behind = 0
  if (git(['rev-parse', '--abbrev-ref', '@{u}'])) {
    const ab = git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
    const m = ab.match(/(\d+)\s+(\d+)/)
    if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
  }
  return { branch, dirty: status.length, staged, untracked, conflicted, ahead, behind, lastCommit, changes, branches, history }
}

/** 构造一个 WebSocket 文本帧（服务端 → 客户端，未掩码）。 */
function wsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

void main()
