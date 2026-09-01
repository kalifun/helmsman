// [dsh-cwl] CWL — Context Window Lifecycle：结构化上下文驱逐 for DeepSeek Harness.
// 范式：arXiv:2606.11213（Beyond Compaction: Structured Context Eviction for Long-Horizon Agents）
//
// 超越摘要压缩（ACP 路线）：把轨迹自动推导为类型化 episode 图（expl 探索 / act 动作 + 依赖），
// agent/pre-step 瀑布每次 LLM 调用前检查上下文压力，超阈值用 surface replace 确定性剥除
// （零 LLM、无摘要幻觉、保留因果结构、用户消息永不驱逐）。
//
// 分级驱逐（graduated，对齐论文实现 pi-cwl）：
//   - 优先驱逐 expl（探索段 = 纯上下文，最安全），保留"已探索"摘要（工作记忆不丢）
//   - 被后续 act 依赖的 expl 保护（依赖图）
//   - 最新尾巴保护（preserveRecent，不碰活跃工具调用）
//
// 压力计量：tokenMeter.measure().totalTokens 不含 cacheReadTokens（长会话上下文主要占用），
// 故从 session 的 assistant/message usage 事件累计真实压力（input + cacheRead + output + reasoning）。
//
// 配置（环境变量）：
//   HELMSMAN_CWL_BUDGET  — 覆盖预算（tokens）；默认 = 上下文窗口 80%
//
// 工具：cwl_mark（主动标注 episode，可选）、cwl_recall（找回被驱逐段涉及的文件）
// HTTP：/api/cwl/evictions（驱逐记录）、/api/cwl/force（调试：强制驱逐一次）

import { defineTool } from '@deepseek-ai/dsh-tools'
import { deriveEpisodes, pickEvictionTarget } from './lib.js'

export const name = 'dsh-cwl'
export const inject = ['webServer', 'agents', 'tokenMeter', 'compaction', 'tools']

// ---------- 插件主体 ----------

export function apply(ctx) {
  const { webServer } = ctx
  const tokenMeter = ctx.get('tokenMeter')
  const evictionLog = new Map() // sid → [{episode, start, end, readPaths, at}]

  /** 计算会话当前真实压力（input + cacheRead + output + reasoning）。 */
  function usageTokens(session) {
    try {
      const m = tokenMeter?.measure(session)
      if (m?.pressureTokens != null) return m.pressureTokens
      let input = 0, cache = 0, output = 0, reason = 0
      for (const ev of session.events) {
        if (ev?.type !== 'assistant/message') continue
        const u = ev.data?.usage
        if (!u) continue
        input += typeof u.inputTokens === 'number' ? u.inputTokens : 0
        cache += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
        output += typeof u.outputTokens === 'number' ? u.outputTokens : 0
        reason += typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0
      }
      if (input + cache + output + reason > 0) return input + cache + output + reason
      return m?.totalTokens ?? 0
    } catch { return 0 }
  }

  /** 预算：环境变量覆盖，或上下文窗口 80%。 */
  function budgetTokens(session) {
    const override = Number(process.env.HELMSMAN_CWL_BUDGET)
    if (Number.isFinite(override) && override > 0) return override
    const header = session.requestHeader?.()?.config
    const ctxWindow = header?.contextWindow ?? 128000
    return Math.floor(ctxWindow * 0.8)
  }

  /** 驱逐一段：surface replace 遮蔽，零 LLM。 */
  function evictRange(session, start, end, episode) {
    if (start == null || end == null || start > end) return null
    const summary = episode.type === 'expl' && episode.toolNames?.length
      ? `已探索：${episode.toolNames.join(', ')}${episode.readPaths?.length ? `（${episode.readPaths.slice(0, 3).join(', ')}）` : ''}`
      : `已执行动作段 ${episode.name}（效果已落盘，如需细节用 cwl_recall）`
    const marker = `[cwl-evicted:${episode.name} type=${episode.type}] ${summary}`
    const shadowed = (session.surface?.nodes ?? []).filter((seq) => seq >= start && seq <= end)
    const ev = session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: marker }],
      source: { kind: 'plugin', plugin: 'dsh-cwl', form: 'notice', summary: marker },
    }, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: shadowed.length > 0 ? shadowed : [start],
    })
    const list = evictionLog.get(session.id) ?? []
    list.push({ episode: episode.name, start, end, readPaths: episode.readPaths ?? [], at: Date.now() })
    evictionLog.set(session.id, list)
    if (list.length > 50) list.shift()
    return ev
  }

  // 核心：agent/pre-step 瀑布 —— 每次 LLM 调用前检查压力，超阈值分级驱逐
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    const session = agent?.session
    if (!session) return next()
    const used = usageTokens(session)
    const budget = budgetTokens(session)
    if (used <= budget) return next() // 预算内零干预

    try {
      const PRESERVE_RECENT = 2
      const surface = session.surface?.nodes ?? []
      const newestAllowed = surface.length > PRESERVE_RECENT ? surface[surface.length - 1 - PRESERVE_RECENT] : -1
      let guard = 0
      while (guard++ < 20) {
        const current = usageTokens(session)
        if (current <= budget) break
        const target = pickEvictionTarget(session.events, surface, newestAllowed)
        if (!target) break
        evictRange(session, target.start, target.end, { name: target.label, type: target.type, readPaths: target.readPaths })
      }
      console.log(`[dsh-cwl] ${session.id} 驱逐后 ${usageTokens(session)}/${budget} tokens`)
    } catch (e) {
      console.warn('[dsh-cwl] 驱逐失败（不阻断）:', e?.message ?? e)
    }
    return next()
  })

  // 工具：cwl_mark（主动标注，可选增强）、cwl_recall（恢复被驱逐文件）
  try {
    ctx.tools.register(defineTool({
      name: 'cwl_mark',
      description: '标注当前工作段（结构化上下文驱逐用）。start 开段，end 收段。type=expl 探索 / act 动作。',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'end'] },
        name: { type: 'string', description: '段名（start 时必填）' },
        type: { type: 'string', enum: ['expl', 'act'], description: '段类型' },
        dependencies: { type: 'array', items: { type: 'string' }, description: 'act 依赖的 expl' },
        description: { type: 'string', description: '收 expl 段的一句话总结' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
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
    console.warn('[dsh-cwl] 工具注册失败（不阻断）:', e?.message ?? e)
  }

  // HTTP：驱逐记录（调试/观测）
  if (webServer?.register) {
    webServer.register({
      kind: 'exact',
      path: '/api/cwl/evictions',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([...evictionLog.entries()].map(([sid, list]) => ({ sid, evicted: list }))))
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/api/cwl/force',
      handler: (req, res) => {
        let buf = ''
        req.on('data', (c) => { buf += c })
        req.on('end', () => {
          try {
            const body = JSON.parse(buf || '{}')
            const agent = ctx.get('agents')?.get?.(body.sid)
            const session = agent?.session
            if (!session) {
              res.writeHead(404, { 'content-type': 'application/json' })
              return res.end(JSON.stringify({ error: 'session not live' }))
            }
            const episodes = deriveEpisodes(session.events)
            const surface = session.surface?.nodes ?? []
            const newestAllowed = surface.length > 2 ? surface[surface.length - 3] : -1
            const target = pickEvictionTarget(session.events, surface, newestAllowed)
            if (!target) {
              res.writeHead(200, { 'content-type': 'application/json' })
              return res.end(JSON.stringify({ ok: true, evicted: 0, note: 'no evictable episode' }))
            }
            evictRange(session, target.start, target.end, { name: target.label, type: target.type, readPaths: target.readPaths })
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, evicted: 1, episode: target.label, range: [target.start, target.end] }))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: e?.message ?? String(e) }))
          }
        })
      },
    })
  }

  console.log('[dsh-cwl] 结构化上下文驱逐已挂载（pre-step 压力检查 + 分级驱逐）')
}

export default { name, inject, apply }
