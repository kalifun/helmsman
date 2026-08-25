/**
 * 上下文装配（简报）+ 知识沉淀（M4 最小闭环）。
 * 装配：任务定义 + 知识库检索命中 → 首条 prompt（规格 §4.2 五步的规则版）。
 * 沉淀：任务 Done 后 → 提炼（规则版：从任务输出/评论提取结论）→ 入库。
 * P1：LLM 提炼（经引擎 ACP）、向量检索、矛盾检测（强模型）。
 */
import type { KbNote } from './storage.ts'
import { retrieveHybrid, deriveQueries, isStableTagged } from './kb.ts'

export interface BriefEntry {
  id: string
  title: string
  score: number
  trust: KbNote['trust']
}

export interface Brief {
  taskTitle: string
  taskDescription: string
  kbHits: BriefEntry[]
}

/** 装配简报（规格 §4.2：resolve → annotate → select → emit）。混合检索：规则 + 语义（向量可用时）。
 * embedOpts 可注入 fake embedder（测试避免加载真实模型）；缺省用真实 embedding.ts（笔记侧带缓存）。 */
export async function assembleBrief(
  input: {
    taskTitle: string
    taskDescription: string
    notes: KbNote[]
    maxKbEntries?: number
    demote?: Record<string, number>
  },
  embedOpts: {
    embedNotes?: (notes: KbNote[]) => Promise<Float32Array[] | null>
    embedQuery?: (text: string) => Promise<Float32Array[] | null>
  } = {},
): Promise<Brief> {
  const taskText = `${input.taskTitle}\n${input.taskDescription}`.trim()
  const queries = deriveQueries(taskText)
  const hits = await retrieveHybrid(input.notes, queries, taskText, {
    limit: input.maxKbEntries ?? 5,
    threshold: 0.15,
    demote: input.demote,
    embedNotes: embedOpts.embedNotes,
    embedQuery: embedOpts.embedQuery,
  })
  return {
    taskTitle: input.taskTitle,
    taskDescription: input.taskDescription,
    kbHits: hits.map((h) => ({
      id: h.note.id,
      title: h.note.title,
      score: Math.round(h.score * 100) / 100,
      trust: h.note.trust,
    })),
  }
}

const TRUST_RANK = { 'human-approved': 3, 'agent-generated': 2, unverified: 1 } as const

/** 稳定前缀只收用户钉过的笔记（标签 `stable`）。
 * 不按信任级自动塞 top-N：人工确认过的旧实验结论会污染每张卡，且改人选会断 KV 缓存。
 */
export function selectStableNotes(
  notes: KbNote[],
  limit = 5,
): Array<{ title: string; content: string[] }> {
  return notes
    .filter((n) => isStableTagged(n.tags))
    .sort((a, b) => {
      const tr = (TRUST_RANK[b.trust] ?? 0) - (TRUST_RANK[a.trust] ?? 0)
      if (tr !== 0) return tr
      return a.id.localeCompare(b.id)
    })
    .slice(0, limit)
    .map((n) => ({ title: n.title, content: n.content }))
}

/** 渲染为发给引擎的 prompt 文本（简报 → 首条消息）。
 * 前缀分区（§6 路径 2 + §6D 缓存杠杆）：
 *   [项目稳定知识块（固定，跨任务不变 → 命中 KV 缓存）]
 *   [任务定义 + 任务相关命中（变化）]
 * 稳定块 = 调用方传入的 projectStableNotes（同项目每次相同）；命中块 = 本次检索结果。
 */
export function renderBriefPrompt(
  brief: Brief,
  projectStableNotes: Array<{ title: string; content: string[] }> = [],
): string {
  const lines: string[] = []
  if (projectStableNotes.length > 0) {
    lines.push('—— 项目稳定知识（本项目的既有结论，跨任务一致）——')
    for (const n of projectStableNotes) {
      lines.push(`• ${n.title}：${n.content.join(' ').slice(0, 200)}`)
    }
    lines.push('')
  }
  lines.push(`任务：${brief.taskTitle}`)
  if (brief.taskDescription.trim()) lines.push(brief.taskDescription.trim())
  if (brief.kbHits.length > 0) {
    lines.push('', '—— 与本任务相关的知识库条目（按相关度排序）——')
    for (const h of brief.kbHits) {
      lines.push(`[${h.score}] ${h.title}`)
    }
  }
  return lines.join('\n')
}

/** 任务输出 → 结论行（规则版提炼：取活动流末尾的文本聚合 + 任务结果）。 */
export function extractConclusion(input: {
  taskTitle: string
  comments: Array<{ who: string; text: string }>
  activities: Array<{ Text?: { text: string } } | { Reasoning?: { text: string } } | { ToolStart?: { name: string } } | { ToolResult?: { name: string } }>
  turns: number
  status: string
}): { title: string; content: string[]; keywords: string[]; summary: string } | null {
  if (input.status !== 'Done') return null // 失败任务不沉淀（防知识腐烂，§3.3）
  // 结论源：活动流末尾的 Text 活动（agent 的最终输出文本）
  const texts: string[] = []
  for (const a of input.activities) {
    if ('Text' in a && a.Text?.text) texts.push(a.Text.text)
  }
  const agentOutput = texts.join('').trim()
  if (agentOutput.length < 8) return null // 无实质结论 → 不自动沉淀
  // —— 具体性门槛（§6D：泛化总结不沉淀，浅知识会污染装配）——
  // 结论必须含"项目特有事实"信号才入库；只有常识/泛化描述（"这是单文件应用"）→ 丢弃。
  const tail = agentOutput.slice(-600) // 用更长窗口判断具体性
  if (!hasConcreteFacts(tail)) {
    return null
  }
  const title = input.taskTitle.length <= 40 ? input.taskTitle : `${input.taskTitle.slice(0, 40)}…`
  // 结论 = 最后 400 字符（收尾语义），按句子切行
  const content = tail.slice(-400).split(/(?<=[。！？.!?]|\n)/).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 8)
  const keywords = deriveQueries(input.taskTitle).filter((q) => q.length <= 24).slice(0, 6)
  return {
    title,
    content,
    keywords,
    summary: content[0]?.slice(0, 120) ?? '',
  }
}

/**
 * 具体性判定：结论文本是否含"项目特有事实"信号。
 * 命中的信号：文件名/路径、行号、具体值（数字+单位/等号）、代码标识符（驼峰+括号/点号）。
 * 纯泛化描述（无任何具体指涉）→ false，不沉淀。
 */
function hasConcreteFacts(text: string): boolean {
  // ① 文件名 / 路径（含扩展名或斜杠）
  if (/[\w-]+\.(ts|tsx|js|jsx|go|rs|py|html|css|json|md|yml|yaml|sql|toml)\b/i.test(text)) return true
  if (/[\w-]+\/[\w-]+/.test(text)) return true
  // ② 行号（:数字、N 行、N:N）
  if (/[:\uFF1A]\d{1,5}\b/.test(text)) return true
  if (/\b\d{1,5}\s*行\b/.test(text)) return true
  if (/\b\d{1,5}:\d{1,5}\b/.test(text)) return true
  // ③ 具体值（数字 + 单位/货币/百分比，或 = 赋值）
  if (/\b\d+(\.\d+)?\s*(ms|s|秒|毫秒|mb|kb|元|¥|\$|%|px|rem|v?h|v?w|gb)\b/i.test(text)) return true
  if (/\w+\s*=\s*["']?[\w./-]+/.test(text)) return true
  // ④ 色值（#hex 6 位）
  if (/#[0-9a-fA-F]{6}\b/.test(text)) return true
  // ⑤ 代码标识符（驼峰 + 括号调用 或 点号成员访问）
  if (/\b[a-z][A-Za-z0-9]*\([^)]{0,40}\)/g.test(text)) return true
  if (/\b[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*/g.test(text)) return true
  // ⑥ 版本号 / 哈希 / id 形态
  if (/\bv?\d+\.\d+\.\d+\b/.test(text)) return true
  if (/\b[0-9a-f]{8,}\b/i.test(text)) return true
  return false
}
