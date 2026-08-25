/**
 * 知识库检索 + 沉淀（M4 最小闭环，规则检索基线 —— 规格 §5.2：先规则检索跑通度量基线，再上向量）。
 * 检索：FTS5 关键词（精确命中文件名/模块/技术词）+ 标签/标题匹配，融合排序。
 * 沉淀：任务 Done → 提炼（LLM 调用，经引擎）→ 建链/矛盾检测（简化：标签去重 + 时间重叠冲突判定）。
 * P2 向量：retrieveHybrid 在规则基线上叠加语义通道（embedding 不可用自动回落纯规则）。
 */
import type { KbNote } from './storage.ts'
import { embedTexts, embedNotes, cosine } from './embedding.ts'

export const STABLE_TAG = 'stable'

export function isStableTagged(tags: string[]): boolean {
  return tags.some((t) => t.toLowerCase() === STABLE_TAG)
}

export function withStableTag(tags: string[], pinned: boolean): string[] {
  const rest = tags.filter((t) => t.toLowerCase() !== STABLE_TAG)
  return pinned ? [...rest, STABLE_TAG] : rest
}

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
  opts: { limit?: number; threshold?: number; demote?: Record<string, number> } = {},
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

    const raw = 0.4 * titleHit + 0.3 * contentHit + 0.15 * freshness + 0.1 * trust + 0.05 * tagHit
    const score = raw * (opts.demote?.[note.id] ?? 1)
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

/** 语义通道的候选门槛（bge 中文相似度：无关 ~0.3，相关 ~0.6+；0.5 是合理门） */
const SEMANTIC_THRESHOLD = 0.5

/**
 * 混合检索：规则通道（词命中必过，含新鲜度/信任权重）+ 语义通道（向量相似，词未命中也能进）。
 * 融合分：规则命中条目 = 0.7·规则分 + 0.3·语义分；纯语义条目 = 0.8·语义分（无新鲜度/信任信号，折扣防误配）。
 * embedding 不可用 → 返回纯规则结果（降级零破坏）。
 * opts.embedNotes / opts.embedQuery 可注入（测试用 fake；缺省用真实 embedding.ts，笔记侧带缓存）。
 */
export async function retrieveHybrid(
  notes: KbNote[],
  queries: string[],
  queryText: string,
  opts: {
    limit?: number
    threshold?: number
    demote?: Record<string, number>
    embedNotes?: (notes: KbNote[]) => Promise<Float32Array[] | null>
    embedQuery?: (text: string) => Promise<Float32Array[] | null>
  } = {},
): Promise<RetrievalHit[]> {
  const limit = opts.limit ?? 5
  const threshold = opts.threshold ?? 0.15
  const ruleHits = retrieve(notes, queries, opts)
  const ruleById = new Map(ruleHits.map((h) => [h.note.id, h.score]))

  const vecs = opts.embedNotes ? await opts.embedNotes(notes) : await embedNotes(notes)
  if (!vecs || vecs.length !== notes.length) return ruleHits // 笔记向量不可用 → 纯规则（也不调 embedQuery，防拖慢）
  const qv = opts.embedQuery ? await opts.embedQuery(queryText) : await embedTexts([queryText], { query: true })
  if (!qv) return ruleHits

  const q = qv[0]
  const scored: RetrievalHit[] = []
  notes.forEach((note, i) => {
    const sim = cosine(q, vecs[i])
    const rule = ruleById.get(note.id)
    if (rule != null) {
      scored.push({ note, score: 0.7 * rule + 0.3 * sim })
    } else if (sim >= SEMANTIC_THRESHOLD) {
      scored.push({ note, score: 0.8 * sim })
    }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.filter((s) => s.score >= threshold).slice(0, limit)
}

export type DebtStatus = 'idle' | 'useful' | 'unused' | 'toxic'

export interface NoteDebt {
  injected: number
  cited: number
  failedWhenCited: number
  status: DebtStatus
}

interface DebtMetric {
  brief_snapshot: Array<{ id: string }>
  cited_entries: string[]
  outcome: string
  verified?: boolean
}

/** 一条笔记相对历史执行的债务：注入了没用 / 用了还失败。 */
export function scoreNoteDebt(noteId: string, metrics: DebtMetric[]): NoteDebt {
  let injected = 0
  let cited = 0
  let failedWhenCited = 0
  for (const m of metrics) {
    if (m.brief_snapshot.some((h) => h.id === noteId)) injected += 1
    if (m.cited_entries.includes(noteId)) {
      cited += 1
      if (m.outcome !== 'Done' || m.verified === false) failedWhenCited += 1
    }
  }
  let status: DebtStatus = 'idle'
  if (cited >= 1 && failedWhenCited * 2 >= cited) status = 'toxic'
  else if (cited >= 1) status = 'useful'
  else if (injected >= 2) status = 'unused'
  return { injected, cited, failedWhenCited, status }
}

/** 任务相关检索：unused / toxic 不再装配。稳定前缀只收用户钉的 `stable` 标签，不走这条。 */
export function debtDemoteWeight(status: DebtStatus): number {
  if (status === 'toxic' || status === 'unused') return 0
  return 1
}

/** 简报条目是否被本轮工具参数 / 产出文本真正用到（规格 §6C 引用锚点）。不计 Reasoning。 */
export function detectCitedEntries(
  hits: Array<{ id: string; title: string; keywords?: string[] }>,
  haystack: string,
): string[] {
  const text = haystack.toLowerCase()
  if (!text.trim()) return []
  const cited: string[] = []
  for (const h of hits) {
    const anchors = collectAnchors(h.title, h.keywords ?? [])
    if (anchors.some((a) => text.includes(a))) cited.push(h.id)
  }
  return cited
}

function collectAnchors(title: string, keywords: string[]): string[] {
  const out = new Set<string>()
  for (const raw of [...keywords, ...deriveQueries(title)]) {
    const t = raw.trim().toLowerCase()
    if (t.length >= 4 || /\.\w+$/.test(t) || t.includes('/')) out.add(t)
  }
  return [...out]
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
