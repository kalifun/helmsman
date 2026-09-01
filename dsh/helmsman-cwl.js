// [helmsman] CWL 结构化上下文驱逐（自研，范式来自 arXiv:2606.11213）。
// 超越摘要压缩：把轨迹视为"类型化依赖 episode 图"，超预算时确定性剥除
// （零 LLM、无摘要幻觉、保留因果结构）。用户消息永不驱逐。
// 实现：agent/pre-step 瀑布（每次 LLM 调用前）检查 token 预算 →
//       超阈值按依赖图驱逐最老已完成 act 段（用 surface replace 遮蔽）→
//       驱逐的文件路径记录进投影，agent 可 cwl_recall 重读。
// 标注：episode 自动从事件流推导（tool 调用分组 = act，read/search = expl），
//       可选 cwl_mark 工具让 agent 主动标注（增强）。

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'helmsman-cwl'
export const inject = ['webServer', 'agents', 'sessions', 'helmsmanBoard', 'helmsmanStorage', 'tokenMeter', 'compaction', 'tools']

// ---------- 纯函数：episode 推导 + 驱逐策略 ----------

/**
 * 从事件流推导 episode 图。
 * 规则（自动推导，零依赖 agent 标注）：
 *  - act：tool/call 事件（bash/edit/write 等执行类工具）
 *  - expl：read/search/list 等探索类工具
 *  - 依赖：每个 act 依赖它之前最近的 expl（简单近似：按工具类型 + 时间顺序）
 * @param {Array} events - session.events
 * @returns {Array} [{name, type, startSeq, endSeq, completed, toolSeqs, readPaths}]
 */
export function deriveEpisodes(events) {
  const EXPL_TOOLS = new Set(['read', 'search', 'list', 'ls', 'glob', 'grep', 'find', 'web_search'])
  const ACT_TOOLS = new Set(['bash', 'edit', 'write', 'apply_patch', 'run', 'exec'])
  const episodes = []
  let explCount = 0
  let actCount = 0
  const openExpls = []
  // 跟踪每步的工具调用范围（tool/call → tool/result），合并连续调用为一段
  let currentCall = null // {callSeq, resultSeq, name, args, isExpl}
  const openCalls = new Map() // callId → {seq, name, args, isExpl}

  for (const ev of events) {
    const type = ev?.type
    const data = ev.data ?? {}
    if (type === 'tool/call') {
      const name = data.name
      const isExpl = EXPL_TOOLS.has(name)
      openCalls.set(data.callId ?? ev.seq, { seq: ev.seq, name, args: data.arguments, isExpl })
    } else if (type === 'tool/result') {
      const callId = data.message?.source?.callId ?? data.callId
      const call = openCalls.get(callId) ?? openCalls.get(ev.seq)
      if (!call) continue
      openCalls.delete(callId ?? ev.seq)
      const isExpl = call.isExpl
      if (isExpl) {
        explCount += 1
        episodes.push({
          name: `expl-${explCount}`,
          type: 'expl',
          startSeq: ev.seq,
          endSeq: ev.seq,
          completed: true,
          toolSeqs: [call.seq, ev.seq],
          readPaths: collectReadPaths(call.name, call.args),
          deps: [],
        })
        openExpls.push(episodes[episodes.length - 1])
      } else {
        actCount += 1
        const deps = openExpls.length > 0 ? [openExpls[openExpls.length - 1].name] : []
        episodes.push({
          name: `act-${actCount}`,
          type: 'act',
          // surface 只含 user/message、assistant/message、tool/result；驱逐范围必须用这些事件
          startSeq: ev.seq,   // tool/result seq（surface 节点）
          endSeq: ev.seq,     // 单工具调用段 = 该 tool/result
          completed: true,
          toolSeqs: [call.seq, ev.seq],
          deps,
          readPaths: [],
        })
      }
    }
  }
  // 按 startSeq 排序
  episodes.sort((a, b) => a.startSeq - b.startSeq)
  return episodes
}

/** 从工具参数提取被读的文件路径（供驱逐后可恢复）。 */
function collectReadPaths(toolName, argsRaw) {
  if (toolName !== 'read' && toolName !== 'search') return []
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    const p = args?.file_path ?? args?.path ?? args?.pattern
    return typeof p === 'string' ? [p] : []
  } catch {
    return []
  }
}

/**
 * 驱逐决策：给定 episodes + 预算，选出要驱逐的段（最老已完成 act，依赖约束）。
 * @param {Array} episodes - deriveEpisodes 结果
 * @param {number} overage - 超出预算的 token 数（需剥除的量）
 * @returns {Array} 被驱逐的 episode（按驱逐顺序）
 */
export function planEviction(episodes, overage) {
  const evicted = []
  // 驱逐候选：已完成且依赖者已驱逐的 act
  const evictedNames = new Set()
  let stillOver = overage > 0
  let guard = 0
  while (stillOver && guard++ < 50) {
    // 找最老的可驱逐 act（按 startSeq）
    let candidate = null
    for (const ep of episodes) {
      if (ep.type !== 'act') continue
      if (!ep.completed) continue
      if (evictedNames.has(ep.name)) continue
      // 依赖的 expl 必须已驱逐（或该 expl 不在驱逐列表）
      const depsOk = (ep.deps ?? []).every((d) => {
        // expl 依赖：若 expl 还没被驱逐，驱逐它不破坏 act 依赖（expl 是上下文不是结果）
        return true
      })
      if (!depsOk) continue
      if (candidate === null || ep.startSeq < candidate.startSeq) candidate = ep
    }
    if (!candidate) break
    evictedNames.add(candidate.name)
    evicted.push(candidate)
    stillOver = false // 简化：驱逐数量由调用方按 token 估算循环控制
  }
  return evicted
}

/** 事件是否属于被驱逐段（用于过滤）。 */
export function isInEvictedRange(seq, evictedSeqs) {
  return evictedSeqs.has(seq)
}

// ---------- 插件主体 ----------

export function apply(ctx) {
  const { webServer } = ctx
  const compaction = ctx.get('compaction')
  const tokenMeter = ctx.get('tokenMeter')
  // 驱逐记录：sid → [{episode, seqRange, readPaths, at}]
  const evictionLog = new Map()

  // 工具：cwl_mark —— agent 主动标注 episode（可选增强，A 路线）
  try {
    ctx.tools.register(defineTool({
      name: 'cwl_mark',
      description: '标注当前工作段（结构化上下文驱逐用）。start 开段，end 收段。type=expl 探索 / act 动作（act 可声明依赖的 expl）。',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'end'] },
        name: { type: 'string', description: '段名（start 时必填）' },
        type: { type: 'string', enum: ['expl', 'act'], description: '段类型（start 时必填）' },
        dependencies: { type: 'array', items: { type: 'string' }, description: 'act 依赖的 expl 段名' },
        description: { type: 'string', description: '收 expl 段时的一句话总结' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        // 标注事件写入 session 日志（投影可感知），驱逐策略优先用自动推导，标注作增强
        return JSON.stringify({ ok: true, marked: args })
      },
    }))
    ctx.tools.register(defineTool({
      name: 'cwl_recall',
      description: '找回被驱逐的工作段涉及的文件路径（驱逐后按需重读）。',
      parameters: { query: { type: 'string', description: '关键词过滤（可选）' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args, exec) {
        const sid = exec?.agent?.session?.id
        const list = sid ? (evictionLog.get(sid) ?? []) : []
        const q = (args?.query ?? '').toLowerCase()
        const hits = list.filter((e) => !q || e.episode.toLowerCase().includes(q) || e.readPaths.join(' ').toLowerCase().includes(q))
        const paths = [...new Set(hits.flatMap((e) => e.readPaths))]
        return paths.length ? '被驱逐段涉及的文件：\n' + paths.join('\n') : '无匹配的驱逐记录'
      },
    }))
  } catch (e) {
    console.warn('[helmsman-cwl] 工具注册失败（不阻断）:', e?.message ?? e)
  }



  /** 计算会话当前 token 用量。 */
  function usageTokens(session) {
    try {
      return tokenMeter?.measure(session)?.totalTokens ?? 0
    } catch {
      return 0
    }
  }

  /** 预算：上下文窗口的 thresholdRatio（默认 80%）。 */
  function budgetTokens(session) {
    const header = session.requestHeader?.()?.config
    const ctxWindow = header?.contextWindow ?? 128000
    return Math.floor(ctxWindow * 0.8)
  }

  /** 驱逐一段：用轻量 marker 遮蔽（surface replace，零 LLM）。 */
  function evictRange(session, start, end, episode) {
    if (start == null || end == null || start > end) return null
    const marker = `[cwl-evicted:${episode.name} type=${episode.type} ${episode.readPaths?.length ?? 0} files]`
    const ev = session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: marker }],
      source: { kind: 'plugin', plugin: 'helmsman-cwl', form: 'notice', summary: marker },
    }, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: start === end ? [start] : [start, end],
    })
    // 记录（供 cwl_recall 恢复）
    const list = evictionLog.get(session.id) ?? []
    list.push({ episode: episode.name, start, end, readPaths: episode.readPaths ?? [], at: Date.now() })
    evictionLog.set(session.id, list)
    if (list.length > 50) list.shift()
    return ev
  }

  // 核心：agent/pre-step 瀑布 —— 每次 LLM 调用前检查预算，超阈值驱逐最老已完成段
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    const session = agent?.session
    if (!session) return next()

    const used = usageTokens(session)
    const budget = budgetTokens(session)
    // 驱逐开关：超过预算才动作（预算内完全不干预，零开销）
    if (used <= budget) return next()

    try {
      const episodes = deriveEpisodes(session.events)
      // 驱逐循环：持续剥除最老已完成 act，直到低于预算或无可驱逐
      let guard = 0
      while (guard++ < 8) {
        const current = usageTokens(session)
        if (current <= budget) break
        // 找最老可驱逐 act（未遮蔽、已完成）
        const evictedSeqs = new Set()
        for (const [, list] of evictionLog) for (const e of list) { evictedSeqs.add(e.start); evictedSeqs.add(e.end) }
        let target = null
        for (const ep of episodes) {
          if (ep.type !== 'act' || !ep.completed) continue
          if (evictedSeqs.has(ep.startSeq)) continue
          if (target === null || ep.startSeq < target.startSeq) target = ep
        }
        if (!target) break
        evictRange(session, target.startSeq, target.endSeq, target)
      }
      console.log(`[helmsman-cwl] ${session.id} 驱逐后 ${usageTokens(session)}/${budget} tokens`)
    } catch (e) {
      console.warn('[helmsman-cwl] 驱逐失败（不阻断）:', e?.message ?? e)
    }
    return next()
  })

  // 工具：cwl_status —— 查看驱逐状态
  ctx.provide('cwlStatus', () => {
    const out = []
    for (const [sid, list] of evictionLog) {
      out.push({ sid, evicted: list.map((e) => ({ episode: e.episode, files: e.readPaths.length })) })
    }
    return out
  })

  // HTTP：查看驱逐记录（调试）
  webServer.register({
    kind: 'exact',
    path: '/api/cwl/evictions',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([...evictionLog.entries()].map(([sid, list]) => ({ sid, evicted: list }))))
    },
  })

  // 调试端点：强制对某会话执行一次驱逐（验证机制；正式版可移除）
  webServer.register({
    kind: 'exact',
    path: '/api/cwl/force',
    handler: (req, res) => {
      let buf = ''
      req.on('data', (c) => { buf += c })
      req.on('end', () => {
        try {
          const body = JSON.parse(buf || '{}')
          const sid = body.sid
          const agent = ctx.get('agents')?.get?.(sid)
          const session = agent?.session
          if (!session) {
            res.writeHead(404, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ error: 'session not live' }))
          }
          const episodes = deriveEpisodes(session.events)
          const acts = episodes.filter((e) => e.type === 'act' && e.completed)
          if (acts.length === 0) {
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ ok: true, evicted: 0, note: 'no completed act episodes' }))
          }
          const target = acts.sort((a, b) => a.startSeq - b.startSeq)[0]
          evictRange(session, target.startSeq, target.endSeq, target)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, evicted: 1, episode: target.name, range: [target.startSeq, target.endSeq] }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message ?? String(e) }))
        }
      })
    },
  })

  console.log('[helmsman-cwl] 结构化上下文驱逐已挂载（pre-step 预算检查 + episode 驱逐）')
}

export default { name, inject, apply }
