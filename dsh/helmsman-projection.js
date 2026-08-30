// [helmsman] 事件流 → 看板状态投影（从 server-ts/src/projection.ts 原样搬迁，TS→JS）。
// fold 是纯函数增量：board 插件每收到一个 session/event 调一次，状态就地更新。
// 可回放：同一日志重放两次结果一致（确定性、崩溃恢复、测试）。
// M2.3（O1=B）：卡/executions 两层 —— 卡 = 资产（需求/缺陷/任务 + 里程碑），
// 挂 0..n 次执行；执行 = 会话（1:1）。看板状态 = 最新一次执行的状态。

export const MAX_ACTIVITIES = 200
export const MAX_COMMENTS = 200

export function newTaskState(sid) {
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

/** 依赖契约校验（目标契约 taskgraph）：数组 + 同项目存在 + 无自依赖 + 无循环；返回去重后的规范 id 列表。
 *  非法输入抛错（调用方转 HTTP 400）；undefined → 空数组（无依赖）。 */
export function validateDeps(deps, knownIds, selfId, getDeps) {
  if (deps === undefined) return []
  if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string' && d.length > 0)) {
    throw new Error('deps must be an array of card ids')
  }
  const known = new Set(knownIds)
  const out = []
  for (const d of new Set(deps)) {
    if (d === selfId) throw new Error('card cannot depend on itself')
    if (!known.has(d)) throw new Error(`dep '${d}' not in project`)
    if (getDeps && leadsToSelf(d, selfId, getDeps)) throw new Error(`依赖成环：'${d}' 的依赖链回到本卡`)
    out.push(d)
  }
  return out
}

/** DFS：从 start 沿依赖链能否到达 selfId（新增边 → 循环）。 */
function leadsToSelf(start, selfId, getDeps) {
  const seen = new Set()
  const stack = [start]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === selfId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...getDeps(cur))
  }
  return false
}

/** 卡的最新一次执行（exec_order 优先，回退字典序兜底） */
export function latestExecutionState(card) {
  const order = card.exec_order.length ? card.exec_order : Object.keys(card.executions)
  const sid = order[order.length - 1]
  return (sid && card.executions[sid]) || null
}

/** 依赖门判定（§2.1 调度门）：卡的所有依赖卡最新执行均 Done → true（可启动）。 */
export function depsMet(card, cardsById) {
  return (card.deps ?? []).every((d) => {
    const dc = cardsById[d]
    const le = dc ? latestExecutionState(dc) : null
    return !!le && le.status === 'Done'
  })
}

/** 未完成的依赖卡 id 列表（顺序保持 deps 声明序） */
export function unmetDeps(card, cardsById) {
  return (card.deps ?? []).filter((d) => {
    const dc = cardsById[d]
    const le = dc ? latestExecutionState(dc) : null
    return !le || le.status !== 'Done'
  })
}

/** 是否存在正常执行代次（非校准会话；D1.7 校准不算"真正执行过"） */
export function hasRealExecution(card) {
  return card.exec_order.some((sid) => !card.executions[sid]?.calib)
}

export function newCardState(meta) {
  return {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    kind: meta.kind,
    milestone: meta.milestone,
    deps: meta.deps ?? [],
    criteria: meta.criteria ?? null,
    budget: meta.budget ?? null,
    executions: {},
    exec_order: [],
    created_at: meta.created_at,
  }
}

/** 从 content blocks 数组提取全部文本（[{type:'text',text},...]）。 */
function extractText(v) {
  if (!Array.isArray(v)) return undefined
  let out = ''
  for (const b of v) {
    if (typeof b.text === 'string') {
      if (out.length > 0) out += '\n'
      out += b.text
    }
  }
  return out
}

function pushActivity(t, a) {
  if (t.activities.length >= MAX_ACTIVITIES) t.activities.shift()
  t.activities.push(a)
}

function pushComment(t, who, text, at) {
  if (t.comments.length >= MAX_COMMENTS) t.comments.shift()
  t.comments.push({ who, text, at })
}

/** 折叠一个日志事件（纯增量；忽略未知事件类型）。 */
export function foldTask(t, ev) {
  const ty = typeof ev.type === 'string' ? ev.type : ''
  const seq = (typeof ev.seq === 'number' ? ev.seq : typeof ev.seq0 === 'number' ? ev.seq0 : 0)
  const time = (typeof ev.time === 'number' ? ev.time : typeof ev.time0 === 'number' ? ev.time0 : 0)
  if (seq > t.last_seq) t.last_seq = seq
  const data = ev.data

  switch (ty) {
    case 'turn/start': {
      if (t.status === 'Pending') t.status = 'Running'
      if (t.started_at === undefined) t.started_at = time
      t.turns += 1
      const tn = data && typeof data.turn === 'number' ? data.turn : t.turns
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
        const reason = data?.reason
        const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
        t.status = kind === 'completed' ? 'Done' : kind === 'cancelled' ? 'Cancelled' : 'Failed'
        t.finished_at = time
      }
      break
    }
    case 'session/title': {
      const title = data && typeof data.title === 'string' ? data.title : undefined
      if (title) t.title = title
      break
    }
    case 'request/context': {
      const model = data && typeof data.model === 'string' ? data.model : undefined
      if (model) t.model = model
      break
    }
    case 'user/message': {
      const src = data?.source
      if (src?.kind === 'user') {
        const text = extractText(data?.content)
        if (text && text.length > 0) pushComment(t, 'user', text, time)
      }
      break
    }
    case 'assistant/message': {
      // token 用量累积（§6 执行经济学：usage 分桶）
      const u = data?.usage
      if (u) {
        t.usage.inputTokens += typeof u.inputTokens === 'number' ? u.inputTokens : 0
        t.usage.outputTokens += typeof u.outputTokens === 'number' ? u.outputTokens : 0
        t.usage.cacheReadTokens += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
        t.usage.reasoningTokens += typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0
      }
      // 完整文本唯一来源（对齐官方 deriveEventMessage：assistant/message.content 是
      // 权威文本；chunk/text-chunks 都是它的流式/存储中间态，不重复累积）。
      // content 里 text → Text 活动，reasoning → Reasoning 活动（同 turn 合并追加）。
      const msg = data?.message
      const content = Array.isArray(msg?.content) ? msg.content : []
      let textSeen = false
      let reasonSeen = false
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          const last = t.activities[t.activities.length - 1]
          if (!textSeen && last && 'Text' in last && last.Text.turn === t.current_turn) {
            last.Text.text += b.text
          } else {
            pushActivity(t, { Text: { text: b.text, at: time, turn: t.current_turn } })
          }
          textSeen = true
        } else if (b?.type === 'reasoning' && typeof b.text === 'string' && b.text.length > 0) {
          const last = t.activities[t.activities.length - 1]
          if (!reasonSeen && last && 'Reasoning' in last && last.Reasoning.turn === t.current_turn) {
            last.Reasoning.text += b.text
          } else {
            pushActivity(t, { Reasoning: { text: b.text, at: time, turn: t.current_turn } })
          }
          reasonSeen = true
        }
      }
      break
    }
    case 'assistant/chunk': {
      // 流式中间态：前端用 streams 实时显示，不进投影 activities（文本权威来源是
      // assistant/message，避免与 message 双通道重复——v1 projection 同款注释）。
      break
    }
    case 'text-chunks':
    case 'reasoning-chunks': {
      // JSONL 存储编码（assistant/chunk delta 的无损打包）：同样不进投影。
      // 文本以 assistant/message.content 为准（实时与重放同一路径）。
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
      const content = data?.message
      const c0 = Array.isArray(content?.content) ? content.content[0] : undefined
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

/** 控制通道终态（stop_reason）：end_turn → Done；cancelled → Cancelled；其余 → Failed。 */
export function finishTask(t, stopReason, at) {
  // Waiting 非空 = 任务停在等待批复：保留等待态，不被终态覆盖
  if (t.waiting) return
  t.status = stopReason === 'end_turn' ? 'Done' : stopReason === 'cancelled' ? 'Cancelled' : 'Failed'
  t.finished_at = at
}

// ---------- 投影存储（内存态） ----------

export function newProjection() {
  return { projects: {}, sessionProject: {}, sessionCard: {} }
}

export function ensureProject(p, id, name, path) {
  if (!p.projects[id]) p.projects[id] = { id, name, path, cards: {}, chats: {} }
}

export function ensureCard(p, projectId, meta) {
  const proj = p.projects[projectId]
  if (!proj) return
  if (!proj.cards[meta.id]) proj.cards[meta.id] = newCardState(meta)
}

/** 注册会话。cardId 为空 = 简单会话（独立，挂项目 chats 下，不进看板）。 */
export function registerSession(p, sessionId, projectId, cardId) {
  p.sessionProject[sessionId] = projectId
  p.sessionCard[sessionId] = cardId
  const proj = p.projects[projectId]
  if (!proj) return
  if (cardId) {
    const card = proj.cards[cardId]
    if (!card) return
    if (!card.executions[sessionId]) card.executions[sessionId] = newTaskState(sessionId)
    if (!card.exec_order.includes(sessionId)) card.exec_order.push(sessionId)
  } else {
    if (!proj.chats[sessionId]) proj.chats[sessionId] = newTaskState(sessionId)
  }
}

/** 会话归属解析（简单会话 → chats；执行 → 卡 executions） */
function resolveSession(p, sessionId) {
  const pid = p.sessionProject[sessionId]
  const cardId = p.sessionCard[sessionId]
  const proj = p.projects[pid]
  if (!proj) return undefined
  if (cardId) return proj.cards[cardId]?.executions[sessionId]
  return proj.chats[sessionId]
}

export function foldSession(p, sessionId, ev) {
  const cardId = p.sessionCard[sessionId]
  const pid = p.sessionProject[sessionId]
  if (!pid) return
  const proj = p.projects[pid]
  if (!proj) return
  let t
  if (cardId) {
    const card = proj.cards[cardId]
    if (card) t = card.executions[sessionId] ?? (card.executions[sessionId] = newTaskState(sessionId))
  } else {
    t = proj.chats[sessionId] ?? (proj.chats[sessionId] = newTaskState(sessionId))
  }
  if (!t) return
  if (!t.id) t.id = sessionId
  foldTask(t, ev)
}

export function finishSession(p, sessionId, stopReason, at) {
  const t = resolveSession(p, sessionId)
  if (t) finishTask(t, stopReason, at)
}

export function removeProject(p, projectId) {
  delete p.projects[projectId]
  const sids = Object.keys(p.sessionProject).filter((sid) => p.sessionProject[sid] === projectId)
  for (const sid of sids) {
    delete p.sessionProject[sid]
    delete p.sessionCard[sid]
  }
}

// ---------- 标记检测（plan / calibrate / checkpoint） ----------

export const PLAN_DONE_MARKER = '【计划完毕】'
export const CALIBRATE_DONE_MARKER = '【验收标准完毕】'
export const CHECKPOINT_DONE_MARKER = '【阶段完毕】'

/** 最后一段连续 Text 产出（探索/工具调用等非 Text 活动中断；标记检测与提取共用的文本源） */
function lastTextSegment(t) {
  const texts = []
  for (let i = t.activities.length - 1; i >= 0; i--) {
    const a = t.activities[i]
    if (!('Text' in a)) break
    const txt = a.Text?.text ?? ''
    if (!txt) break
    texts.unshift(txt)
  }
  return texts.join('\n')
}

/**
 * 检测 agent 是否已在产出段输出标记（最后连续 Text 活动含 marker）。
 * G5 修复：只认 Text 输出，不计 Reasoning——agent 思考中讨论标记字符串是常见行为，
 * 计入会导致"没产出却挂 Waiting"的假阳性。
 */
export function detectMarker(t, marker) {
  return lastTextSegment(t).includes(marker)
}

export function detectPlanCompletion(t) {
  return detectMarker(t, PLAN_DONE_MARKER)
}

/**
 * 提取 agent 产出的标记前文本（【marker】之前最近的连续 Text 产出段）。
 * G4 修复：只取"最后一段连续 Text 产出"，避免中间文本污染提案。
 */
export function extractMarkerText(t, marker) {
  const joined = lastTextSegment(t)
  const idx = joined.indexOf(marker)
  if (idx >= 0) return joined.slice(0, idx).trim()
  return joined.slice(-800)
}

export function extractPlanText(t) {
  return extractMarkerText(t, PLAN_DONE_MARKER)
}
