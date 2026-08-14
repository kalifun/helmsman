/**
 * 事件流 → 看板状态投影（TS 版）——照 crates/taskgraph/src/projection.rs 翻译。
 * 双源：日志事件（JSONL，过程）+ ACP stop_reason（控制通道，终态）。
 * fold 是纯函数增量：tailer 每收到一个事件调一次，状态就地更新。
 * 可回放：同一日志重放两次结果一致（确定性、崩溃恢复、测试）。
 * M2.3（O1=B）：卡/executions 两层 —— 卡 = 资产（需求/缺陷/任务 + 里程碑），
 * 挂 0..n 次执行；执行 = 会话（1:1，D1.2）。看板状态 = 最新一次执行的状态。
 */
import type { TailEvent } from './observe/tail.ts'

export const MAX_ACTIVITIES = 200
export const MAX_COMMENTS = 200

export type TaskStatus = 'Pending' | 'Running' | 'Done' | 'Failed' | 'Cancelled'

export interface ToolCall {
  call_id: string
  name: string
  args: string
  is_error: boolean
}

export type Activity =
  | { Text: { text: string; at: number; turn: number } }
  | { Reasoning: { text: string; at: number; turn: number } }
  | { ToolStart: { name: string; at: number; turn: number } }
  | { ToolResult: { name: string; is_error: boolean; at: number; turn: number } }

export interface Comment {
  who: string
  text: string
  at: number
}

export interface CardMeta {
  id: string
  title: string
  description: string
  kind: string
  milestone: string | null
  /** 需求契约：验收标准（可判定断言；实验任务集的验收命令） */
  criteria: string | null
  /** 依赖契约（目标契约 taskgraph）：完成本卡前需先完成的卡 id（同项目内） */
  deps: string[]
  created_at: number
}

export interface TaskState {
  id: string
  status: TaskStatus
  title?: string
  model?: string
  turns: number
  steps: number
  tool_calls: ToolCall[]
  activities: Activity[]
  comments: Comment[]
  started_at?: number
  finished_at?: number
  last_seq: number
  recovered: boolean
  /** 会话级 token 用量（assistant/message.usage 累积，§6 执行经济学） */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number }
  /** Waiting 判别联合（§2.5）：非空 = 任务停在等待批复（plan/permission/acceptance/cost） */
  waiting: { kind: 'plan' | 'permission' | 'acceptance' | 'cost'; reason: string; payload: Record<string, unknown> } | null
  /** 执行启动时的预设快照（§2.6：预设 = 执行契约，随任务生命周期延续） */
  preset: { id: string; name: string; mode: string; setting: string; approval: string; sandbox: string } | null
  /** 依赖契约快照（继承自卡的 deps；图 DAG 边 = 最新执行此字段） */
  deps?: string[]
  /** fold 内部状态：当前回合号（Activity.turn 来源，不参与业务语义） */
  current_turn: number
}

export interface CardState {
  id: string
  title: string
  description: string
  kind: string
  milestone: string | null
  deps: string[]
  executions: Record<string, TaskState>
  exec_order: string[]
  created_at: number
}

export function newTaskState(sid: string): TaskState {
  return {
    id: sid,
    status: 'Pending',
    turns: 0,
    steps: 0,
    tool_calls: [],
    activities: [],
    comments: [],
    last_seq: 0,
    recovered: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
    waiting: null,
    preset: null,
    current_turn: 0,
  }
}

/** 依赖契约校验（目标契约 taskgraph）：数组 + 同项目存在 + 无自依赖；返回去重后的规范 id 列表。
 *  非法输入抛错（调用方转 HttpError 400）；undefined → 空数组（无依赖）。 */
export function validateDeps(deps: unknown, knownIds: Iterable<string>, selfId: string): string[] {
  if (deps === undefined) return []
  if (!Array.isArray(deps) || !deps.every((d): d is string => typeof d === 'string' && d.length > 0)) {
    throw new Error('deps must be an array of card ids')
  }
  const known = new Set(knownIds)
  const out: string[] = []
  for (const d of new Set(deps)) {
    if (d === selfId) throw new Error('card cannot depend on itself')
    if (!known.has(d)) throw new Error(`dep '${d}' not in project`)
    out.push(d)
  }
  return out
}

export function newCardState(meta: CardMeta): CardState {
  return {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    kind: meta.kind,
    milestone: meta.milestone,
    deps: meta.deps ?? [],
    executions: {},
    exec_order: [],
    created_at: meta.created_at,
  }
}

/** 从 content blocks 数组提取全部文本（[{type:'text',text},...]）。 */
function extractText(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined
  let out = ''
  for (const b of v as Array<Record<string, unknown>>) {
    if (typeof b.text === 'string') {
      if (out.length > 0) out += '\n'
      out += b.text
    }
  }
  return out
}

function pushActivity(t: TaskState, a: Activity): void {
  if (t.activities.length >= MAX_ACTIVITIES) t.activities.shift()
  t.activities.push(a)
}

function pushComment(t: TaskState, who: string, text: string, at: number): void {
  if (t.comments.length >= MAX_COMMENTS) t.comments.shift()
  t.comments.push({ who, text, at })
}

/** 折叠一个日志事件（纯增量；忽略未知事件类型）。 */
export function foldTask(t: TaskState, ev: Record<string, unknown>): void {
  const ty = typeof ev.type === 'string' ? ev.type : ''
  const seq = (typeof ev.seq === 'number' ? ev.seq : typeof ev.seq0 === 'number' ? ev.seq0 : 0) as number
  const time = (typeof ev.time === 'number' ? ev.time : typeof ev.time0 === 'number' ? ev.time0 : 0) as number
  if (seq > t.last_seq) t.last_seq = seq
  const data = ev.data as Record<string, unknown> | undefined

  switch (ty) {
    case 'turn/start': {
      if (t.status === 'Pending') t.status = 'Running'
      if (t.started_at === undefined) t.started_at = time
      t.turns += 1
      const tn = data && typeof data.turn === 'number' ? (data.turn as number) : t.turns
      t.current_turn = tn
      break
    }
    case 'step/start':
      t.steps += 1
      break
    case 'turn/end': {
      // waiting 非空 = 任务停在等待批复（plan/acceptance）：本轮虽结束但任务未完结，保留等待态
      if (t.waiting !== null) break
      if (t.status === 'Running' || t.status === 'Pending') {
        const reason = data?.reason as Record<string, unknown> | undefined
        const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
        t.status = kind === 'completed' ? 'Done' : kind === 'cancelled' ? 'Cancelled' : 'Failed'
        t.finished_at = time
      }
      break
    }
    case 'session/title': {
      const title = data && typeof data.title === 'string' ? (data.title as string) : undefined
      if (title) t.title = title
      break
    }
    case 'request/context': {
      const model = data && typeof data.model === 'string' ? (data.model as string) : undefined
      if (model) t.model = model
      break
    }
    case 'user/message': {
      const src = data?.source as Record<string, unknown> | undefined
      if (src?.kind === 'user') {
        const text = extractText(data?.content)
        if (text && text.length > 0) pushComment(t, 'user', text, time)
      }
      break
    }
    case 'assistant/message': {
      // token 用量累积（§6 执行经济学：usage 分桶）
      const u = data?.usage as Record<string, unknown> | undefined
      if (u) {
        t.usage.inputTokens += typeof u.inputTokens === 'number' ? u.inputTokens : 0
        t.usage.outputTokens += typeof u.outputTokens === 'number' ? u.outputTokens : 0
        t.usage.cacheReadTokens += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
        t.usage.reasoningTokens += typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0
      }
      break
    }
    case 'assistant/chunk': {
      const chunk = data?.chunk as Record<string, unknown> | undefined
      // text-delta 是流式增量碎片，与 text-chunks（打包增量）是同一文本的重复传输。
      // 存活动只取 text-chunks（追加合并）；chunk 仅作前端流式信号（streams[sid]），不进投影。
      break
    }
    case 'text-chunks':
    case 'reasoning-chunks': {
      const texts = Array.isArray(data?.texts)
        ? (data.texts as unknown[]).filter((x): x is string => typeof x === 'string').join('')
        : ''
      if (texts.length > 0) {
        if (ty === 'text-chunks') {
          // text-chunks 是增量打包块：同 turn 追加到上一条 Text（dsh 式完整消息，不逐块存）
          const last = t.activities[t.activities.length - 1]
          if (last && 'Text' in last && last.Text.turn === t.current_turn) {
            last.Text.text += texts
          } else {
            pushActivity(t, { Text: { text: texts, at: time, turn: t.current_turn } })
          }
        } else {
          pushActivity(t, { Reasoning: { text: texts, at: time, turn: t.current_turn } })
        }
      }
      break
    }
    case 'tool/call': {
      const callId = data && typeof data.callId === 'string' ? data.callId : undefined
      const name = data && typeof data.name === 'string' ? data.name : undefined
      if (callId && name) {
        const args = data && typeof data.arguments === 'string' ? data.arguments : ''
        t.tool_calls.push({ call_id: callId, name, args, is_error: false })
        pushActivity(t, { ToolStart: { name, at: time, turn: t.current_turn } })
      }
      break
    }
    case 'tool/result': {
      const content = data?.message as Record<string, unknown> | undefined
      const c0 = Array.isArray(content?.content) ? (content.content as unknown[])[0] as Record<string, unknown> : undefined
      if (c0) {
        const tid = typeof c0.toolCallId === 'string' ? c0.toolCallId : ''
        const isErr = c0.isError === true
        const tc = t.tool_calls.find((x) => x.call_id === tid)
        if (tc) tc.is_error = isErr
        pushActivity(t, { ToolResult: { name: tid, is_error: isErr, at: time, turn: t.current_turn } })
      }
      break
    }
    default:
      break
  }
}

/** 控制通道终态（ACP stop_reason）：end_turn → Done；cancelled → Cancelled；其余 → Failed。 */
export function finishTask(t: TaskState, stopReason: string, at: number): void {
  t.status = stopReason === 'end_turn' ? 'Done' : stopReason === 'cancelled' ? 'Cancelled' : 'Failed'
  t.finished_at = at
}

// ---------- 投影存储（内存态） ----------

export interface Project {
  id: string
  name: string
  path: string
  cards: Record<string, CardState>
}

export interface Projection {
  projects: Record<string, Project>
  sessionProject: Record<string, string>
  sessionCard: Record<string, string>
}

export function newProjection(): Projection {
  return { projects: {}, sessionProject: {}, sessionCard: {} }
}

export function ensureProject(p: Projection, id: string, name: string, path: string): void {
  if (!p.projects[id]) p.projects[id] = { id, name, path, cards: {} }
}

export function ensureCard(p: Projection, projectId: string, meta: CardMeta): void {
  const proj = p.projects[projectId]
  if (!proj) return
  if (!proj.cards[meta.id]) proj.cards[meta.id] = newCardState(meta)
}

export function registerSession(p: Projection, sessionId: string, projectId: string, cardId: string): void {
  p.sessionProject[sessionId] = projectId
  p.sessionCard[sessionId] = cardId
  const proj = p.projects[projectId]
  const card = proj?.cards[cardId]
  if (!card) return
  if (!card.executions[sessionId]) card.executions[sessionId] = newTaskState(sessionId)
  if (!card.exec_order.includes(sessionId)) card.exec_order.push(sessionId)
}

export function foldSession(p: Projection, sessionId: string, ev: Record<string, unknown>): void {
  const cardId = p.sessionCard[sessionId]
  const pid = p.sessionProject[sessionId]
  if (!cardId || !pid) return
  const card = p.projects[pid]?.cards[cardId]
  if (!card) return
  const t = card.executions[sessionId] ?? (card.executions[sessionId] = newTaskState(sessionId))
  if (!t.id) t.id = sessionId
  foldTask(t, ev)
}

export function finishSession(p: Projection, sessionId: string, stopReason: string, at: number): void {
  const cardId = p.sessionCard[sessionId]
  const pid = p.sessionProject[sessionId]
  if (!cardId || !pid) return
  const t = p.projects[pid]?.cards[cardId]?.executions[sessionId]
  if (t) finishTask(t, stopReason, at)
}

export function removeProject(p: Projection, projectId: string): void {
  delete p.projects[projectId]
  const sids = Object.keys(p.sessionProject).filter((sid) => p.sessionProject[sid] === projectId)
  for (const sid of sids) {
    delete p.sessionProject[sid]
    delete p.sessionCard[sid]
  }
}

export type { TailEvent }

/** 计划完成的检测标记（阶段 2 · plan 协作方式）。 */
export const PLAN_DONE_MARKER = '【计划完毕】'

/**
 * 检测 agent 是否已产出计划（活动流文本含【计划完毕】标记）。
 * 纯函数：从 activities 提取文本，供 plan 模式判断是否挂 Waiting{plan}。
 */
export function detectPlanCompletion(t: TaskState): boolean {
  const allText = t.activities
    .map((a) => ('Text' in a ? a.Text?.text : 'Reasoning' in a ? a.Reasoning?.text : ''))
    .join('')
  return allText.includes(PLAN_DONE_MARKER)
}

/**
 * 提取 agent 产出的计划文本（【计划完毕】标记之前的 Text 活动内容）。
 * 纯函数：供 plan 模式挂 Waiting{plan} 时把计划本体放进批复。
 */
export function extractPlanText(t: TaskState): string {
  // 只取 Text 活动（Reasoning 是思考不是计划输出）；取【计划完毕】之前的全部计划文本
  const texts = t.activities
    .map((a) => ('Text' in a ? a.Text?.text : ''))
    .join('')
  const idx = texts.indexOf(PLAN_DONE_MARKER)
  if (idx < 0) return texts.slice(-800)
  return texts.slice(0, idx).trim()
}
