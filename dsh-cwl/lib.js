// dsh-cwl 纯函数（无依赖，可独立测试）
// 范式：arXiv:2606.11213 Structured Context Eviction

// ---------- 纯函数：episode 推导 + 驱逐策略 ----------

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

/** 从工具参数提取 act 触碰的文件路径（file_path 或 command 里引用的路径）。 */
function collectTouchedPaths(toolName, argsRaw) {
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    const p = args?.file_path ?? args?.path
    if (typeof p === 'string') return [p]
    if (typeof args?.command === 'string') {
      const m = args.command.matchAll(/[\w./-]+\.[a-z]+/g)
      return [...new Set([...m].map((x) => x[0]).filter((x) => x.includes('/')))].slice(0, 5)
    }
    return []
  } catch { return [] }
}

/**
 * 从事件流推导 episode 图（阶段合并 + 依赖）。
 * 基础单元：每条含 tool-call 的 assistant/message → 一个 tool-batch；
 * 阶段合并：连续同类型合并为 expl（探索）/ act（动作）语义段；
 * 依赖推断：act 触碰的文件若之前 expl 读过 → deps 边（驱逐时保护）。
 */
export function deriveEpisodes(events) {
  const EXPL_TOOLS = new Set(['read', 'search', 'list', 'ls', 'glob', 'grep', 'find', 'web_search'])
  const episodes = []
  let explCount = 0
  let actCount = 0
  let cur = null

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
      const touchedPaths = isExpl ? [] : toolCalls.flatMap((b) => collectTouchedPaths(b.name, b.arguments))
      if (cur && cur.type === (isExpl ? 'expl' : 'act')) {
        cur.batches.push({ seq: ev.seq, names, readPaths, touchedPaths })
        cur.endSeq = ev.seq
        cur.toolNames.push(...names)
        cur.readPaths.push(...readPaths)
        if (!isExpl) cur.touchedPaths.push(...touchedPaths)
      } else {
        flush()
        if (isExpl) {
          explCount += 1
          cur = { name: `expl-${explCount}`, type: 'expl', startSeq: ev.seq, endSeq: ev.seq,
                  batches: [{ seq: ev.seq, names, readPaths, touchedPaths: [] }], toolNames: [...names],
                  readPaths: [...readPaths], deps: [], touchedPaths: [], completed: false }
        } else {
          actCount += 1
          cur = { name: `act-${actCount}`, type: 'act', startSeq: ev.seq, endSeq: ev.seq,
                  batches: [{ seq: ev.seq, names, readPaths, touchedPaths }], toolNames: [...names],
                  readPaths: [...readPaths], deps: [], touchedPaths: [...touchedPaths], completed: false }
        }
      }
    } else if (type === 'tool/result') {
      if (cur) cur.endSeq = ev.seq
    }
  }
  flush()

  // 依赖推断：act 触碰（读写）的文件若之前 expl 读过 → deps 边
  const expls = episodes.filter((e) => e.type === 'expl')
  const readSets = expls.map((e) => new Set(e.readPaths))
  for (const ep of episodes) {
    if (ep.type !== 'act') continue
    const touched = new Set([...ep.readPaths, ...(ep.touchedPaths ?? [])])
    for (let i = 0; i < expls.length; i++) {
      if (expls[i].endSeq < ep.startSeq && [...touched].some((p) => readSets[i].has(p))) {
        ep.deps.push(expls[i].name)
      }
    }
  }
  return episodes
}

/**
 * 分级驱逐选择：选下一个可驱逐的 episode。
 * 优先级：expl（纯上下文）> act；被依赖 expl 保护；已遮蔽/最新尾巴跳过。
 */
export function pickEvictionTarget(events, surface, newestAllowed) {
  const episodes = deriveEpisodes(events)
  const surfaceSet = new Set(surface)
  const depended = new Set()
  for (const ep of episodes) if (ep.type === 'act') for (const d of ep.deps ?? []) depended.add(d)
  let best = null
  for (const ep of episodes) {
    if (!ep.completed) continue
    if (!surfaceSet.has(ep.startSeq)) continue
    if (ep.endSeq > newestAllowed) continue
    if (ep.type === 'expl' && depended.has(ep.name)) continue
    const score = (ep.type === 'expl' ? 0 : 10) + ep.startSeq / 1e9
    if (best === null || score < best.score) best = { ...ep, score }
  }
  if (!best) return null
  return { start: best.startSeq, end: best.endSeq, label: best.name, type: best.type, readPaths: best.readPaths ?? [] }
}
