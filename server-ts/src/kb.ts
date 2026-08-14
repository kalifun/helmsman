/**
 * 知识库检索 + 沉淀（M4 最小闭环，规则检索基线 —— 规格 §5.2：先规则检索跑通度量基线，再上向量）。
 * 检索：FTS5 关键词（精确命中文件名/模块/技术词）+ 标签/标题匹配，融合排序。
 * 沉淀：任务 Done → 提炼（LLM 调用，经引擎）→ 建链/矛盾检测（简化：标签去重 + 时间重叠冲突判定）。
 */
import type { KbNote } from './storage.ts'

export interface RetrievalHit {
  note: KbNote
  score: number
}

/** 查询推导：主查询 + 从任务定义提取实体（文件名/模块/技术词，简化：按驼峰/点号/斜杠切词）。 */
export function deriveQueries(taskText: string): string[] {
  const queries = new Set<string>()
  // 主查询：整段任务文本
  const primary = taskText.trim()
  if (primary.length > 0) queries.add(primary)
  // 实体提取：文件路径、驼峰标识符、点号分隔
  const entityRe = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*|(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+/g
  for (const m of taskText.matchAll(entityRe)) {
    const tok = m[0].trim()
    if (tok.length >= 3 && tok.length <= 64) queries.add(tok)
  }
  // 中文技术词：2-4 字连续词（简化：切 2-gram）
  const zhRe = /[\u4e00-\u9fa5]{2,}/g
  for (const m of taskText.matchAll(zhRe)) {
    const zh = m[0]
    if (zh.length <= 8) queries.add(zh)
    for (let i = 0; i + 2 <= zh.length; i++) queries.add(zh.slice(i, i + 2))
  }
  return [...queries].slice(0, 12)
}

/**
 * 规则检索：对每条当前有效笔记打分。
 * 分数 = 0.4·标题命中 + 0.3·关键词/内容命中 + 0.15·新鲜度 + 0.1·信任 + 0.05·标签命中
 * （规格 §5.1 融合重排的规则版；向量版 P1）。
 */
export function retrieve(
  notes: KbNote[],
  queries: string[],
  opts: { limit?: number; threshold?: number } = {},
): RetrievalHit[] {
  const limit = opts.limit ?? 5
  const threshold = opts.threshold ?? 0.15
  const now = Date.now()
  const scored: RetrievalHit[] = []

  for (const note of notes) {
    const titleL = note.title.toLowerCase()
    const contentL = (note.content.join('\n') + ' ' + note.keywords.join(' ') + ' ' + note.summary).toLowerCase()
    const tagsL = note.tags.join(' ').toLowerCase()
    let titleHit = 0
    let contentHit = 0
    let tagHit = 0
    for (const q of queries) {
      const ql = q.toLowerCase()
      const isStrong = ql.length >= 3 && !isZhBigram(q) // 弱查询（中文 2-gram）不匹配内容，防误命中
      if (titleL.includes(ql)) titleHit = Math.max(titleHit, 1)
      if (isStrong && contentL.includes(ql)) contentHit = Math.max(contentHit, 1)
      if (tagsL.includes(ql)) tagHit = Math.max(tagHit, 1)
    }
    // 新鲜度：7 天内满值，30 天后衰减到一半
    const ageDays = Math.max(0, (now - note.validFrom) / 86400000)
    const freshness = ageDays <= 7 ? 1 : ageDays <= 30 ? 0.75 : 0.5
    // 信任：human-approved 1 / agent-generated 0.7 / unverified 0.3
    const trust = note.trust === 'human-approved' ? 1 : note.trust === 'agent-generated' ? 0.7 : 0.3

    const score = 0.4 * titleHit + 0.3 * contentHit + 0.15 * freshness + 0.1 * trust + 0.05 * tagHit
    // 必须至少一个词命中标题/内容/标签，否则不入候选（新鲜度/信任是权重不是触发条件）
    if (titleHit === 0 && contentHit === 0 && tagHit === 0) continue
    if (score > 0) scored.push({ note, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.filter((s) => s.score >= threshold).slice(0, limit)
}

/** 是否纯中文 2 字查询（切词产物，过于泛化，只配标题/标签）。 */
function isZhBigram(q: string): boolean {
  if (q.length !== 2) return false
  return /^[\u4e00-\u9fa5]{2}$/.test(q)
}

/** 生成一条 KbNote（任务沉淀入口）。 */
export function makeNote(input: {
  projectId: string
  title: string
  content: string[]
  tags: string[]
  keywords: string[]
  summary: string
  sourceKind: KbNote['source']['kind']
  sourceRef: string
  trust: KbNote['trust']
  links?: string[]
}): KbNote {
  const t = Date.now()
  return {
    id: `kb-${t}-${Math.floor(Math.random() * 1e6)}`,
    project_id: input.projectId,
    title: input.title,
    content: input.content,
    tags: input.tags,
    keywords: input.keywords,
    summary: input.summary,
    links: input.links ?? [],
    source: { kind: input.sourceKind, ref: input.sourceRef },
    validFrom: t,
    validUntil: null,
    version: 1,
    trust: input.trust,
    createdAt: t,
    updatedAt: t,
  }
}
