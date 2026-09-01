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
/** 从工具参数提取 act 触碰的文件路径（file_path 或 command 里引用的路径）。 */
function collectTouchedPaths(toolName, argsRaw) {
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    const p = args?.file_path ?? args?.path
    if (typeof p === 'string') return [p]
    // bash 命令里的路径（粗略：/xx/yy.ext 模式）
    if (typeof args?.command === 'string') {
      const m = args.command.matchAll(/[\w./-]+\.[a-z]+/g)
      return [...new Set([...m].map((x) => x[0]).filter((x) => x.includes('/')))].slice(0, 5)
    }
    return []
  } catch { return [] }
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

export function deriveEpisodes(events) {
  // episode 推断（v2：阶段合并 + 依赖图）
  // 基础单元：每条含 tool-call 的 assistant/message → 一个 tool-batch（记录工具名 + 读的文件）
  // 阶段合并：连续同类型 tool-batch 合并为更大语义单元（expl 探索阶段 / act 执行阶段），
  //           避免碎片化驱逐（论文"类型化依赖 episode"的核心）。
  // 依赖推断：act 阶段读写的文件若在之前 expl 阶段读过 → 建立 deps 边（驱逐时保护）。
  const EXPL_TOOLS = new Set(['read', 'search', 'list', 'ls', 'glob', 'grep', 'find', 'web_search'])
  const episodes = []
  let explCount = 0
  let actCount = 0
  let cur = null // 当前阶段

  const flush = () => {
    if (cur) { cur.completed = true; episodes.push(cur); cur = null }
  }

  for (const ev of events) {
    const type = ev?.type
    const data = ev.data ?? {}
    if (type === 'assistant/message') {
      const content = data.message?.content ?? []
      const toolCalls = content.filter((b) => b?.type === 'tool-call')
      if (toolCalls.length === 0) continue
      const isExpl = toolCalls.every((b) => EXPL_TOOLS.has(b.name))
      const readPaths = toolCalls.flatMap((b) => collectReadPaths(b.name, b.arguments))
      const names = toolCalls.map((b) => b.name)
      // act 的工具参数里出现的文件路径（bash/edit 的 file_path / command 引用）
      const touchedPaths = isExpl ? [] : toolCalls.flatMap((b) => collectTouchedPaths(b.name, b.arguments))
      // 同类型连续 → 合并；类型切换 → 关当前开新
      if (cur && cur.type === (isExpl ? 'expl' : 'act')) {
        cur.batches.push({ seq: ev.seq, names, readPaths })
        cur.endSeq = ev.seq
        cur.toolNames.push(...names)
        cur.readPaths.push(...readPaths)
        if (!isExpl) cur.touchedPaths.push(...touchedPaths)
      } else {
        flush()
        if (isExpl) {
          explCount += 1
          cur = { name: `expl-${explCount}`, type: 'expl', startSeq: ev.seq, endSeq: ev.seq,
                  batches: [{ seq: ev.seq, names, readPaths }], toolNames: [...names],
                  readPaths: [...readPaths], deps: [], touchedPaths: [], completed: false }
        } else {
          actCount += 1
          cur = { name: `act-${actCount}`, type: 'act', startSeq: ev.seq, endSeq: ev.seq,
                  batches: [{ seq: ev.seq, names, readPaths }], toolNames: [...names],
                  readPaths: [...readPaths], deps: [], touchedPaths: [...touchedPaths], completed: false }
        }
      }
    } else if (type === 'tool/result') {
      if (cur) cur.endSeq = ev.seq
    }
  }
  flush()

  // 依赖推断：act 阶段的读文件若之前 expl 阶段读过 → deps 边
  const expls = episodes.filter((e) => e.type === 'expl')
  const readSets = expls.map((e) => new Set(e.readPaths))
  for (const ep of episodes) {
    if (ep.type !== 'act') continue
    const touched = new Set([...ep.readPaths, ...(ep.touchedPaths ?? [])])
    for (let i = 0; i < expls.length; i++) {
      // act 触碰（读写）了 expl 读过的文件 → 依赖（且 expl 在 act 之前）
      if (expls[i].endSeq < ep.startSeq && [...touched].some((p) => readSets[i].has(p))) {
        ep.deps.push(expls[i].name)
      }
    }
  }
  return episodes
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

  /** 预算：上下文窗口的 thresholdRatio（默认 80%）；实验可注入 HELMSMAN_CWL_BUDGET 覆盖（模拟长任务压力）。 */
  function budgetTokens(session) {
    const override = Number(process.env.HELMSMAN_CWL_BUDGET)
    if (Number.isFinite(override) && override > 0) return override
    const header = session.requestHeader?.()?.config
    const ctxWindow = header?.contextWindow ?? 128000
    return Math.floor(ctxWindow * 0.8)
  }

  /** 驱逐一段：用轻量 marker 遮蔽（surface replace，零 LLM）。 */
  function evictRange(session, start, end, episode) {
    if (start == null || end == null || start > end) return null
    // expl 驱逐保留摘要（agent 仍知道探索过什么，只是省掉原始大块输出）
    const summary = episode.type === 'expl' && episode.toolNames?.length
      ? `已探索：${episode.toolNames.join(', ')}${episode.readPaths?.length ? `（${episode.readPaths.slice(0, 3).join(', ')}）` : ''}`
      : `已执行动作段 ${episode.name}（效果已落盘，如需细节用 cwl_recall）`
    const marker = `[cwl-evicted:${episode.name} type=${episode.type}] ${summary}`
    // sourceEventSeqs 必须包含 range 内全部被遮蔽的 surface 节点（官方约束）
    const shadowed = (session.surface?.nodes ?? []).filter((seq) => seq >= start && seq <= end)
    const ev = session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: marker }],
      source: { kind: 'plugin', plugin: 'helmsman-cwl', form: 'notice', summary: marker },
    }, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: shadowed.length > 0 ? shadowed : [start],
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
      // 驱逐循环：优先剥 expl（探索段 = 纯上下文，最安全），无 expl 才动 act
      const PRESERVE_RECENT = 2 // 保留最新 N 个 surface 节点（含活跃工具调用）
      const surface = session.surface?.nodes ?? []
      const newestAllowed = surface.length > PRESERVE_RECENT ? surface[surface.length - 1 - PRESERVE_RECENT] : -1
      let guard = 0
      while (guard++ < 12) {
        const current = usageTokens(session)
        if (current <= budget) break
        // 找最老可驱逐段（未遮蔽、已完成、不碰最新尾巴）；优先无依赖 expl，其次最老 act
        const evictedSeqs = new Set()
        for (const [, list] of evictionLog) for (const e of list) { evictedSeqs.add(e.start); evictedSeqs.add(e.end) }
        // 被后续 act 依赖的 expl 不可驱逐（依赖图保护）
        const dependedExpls = new Set()
        for (const ep of episodes) if (ep.type === 'act') for (const d of ep.deps ?? []) dependedExpls.add(d)
        let target = null
        for (const ep of episodes) {
          if (!ep.completed) continue
          if (evictedSeqs.has(ep.startSeq)) continue
          if (ep.endSeq > newestAllowed) continue // 保护最新尾巴
          if (ep.type === 'expl' && dependedExpls.has(ep.name)) continue // 有依赖 → 保护
          if (target === null) { target = ep; continue }
          // 优先 expl（纯上下文最安全）；同类型取更老
          if (ep.type === 'expl' && target.type === 'act') { target = ep; continue }
          if (ep.type === target.type && ep.startSeq < target.startSeq) target = ep
        }
        if (!target) break
        // 平衡校验（官方 helper）：段尾必须是配对的 tool 边界
        try {
          const { toolPairingBalancedAfter } = await import('@deepseek-ai/dsh-compaction')
          if (!toolPairingBalancedAfter(session, target.endSeq)) { console.warn('[helmsman-cwl] 跳过不平衡段', target.name); break }
        } catch { /* 校验不可用时跳过 */ }
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
          const surface = session.surface?.nodes ?? []
          const newestAllowed = surface.length > 2 ? surface[surface.length - 3] : -1
          const target = acts.filter((e) => e.endSeq <= newestAllowed).sort((a, b) => a.startSeq - b.startSeq)[0]
          if (!target) {
            res.writeHead(200, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ ok: true, evicted: 0, note: 'no evictable completed act (all in recent tail)' }))
          }
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
