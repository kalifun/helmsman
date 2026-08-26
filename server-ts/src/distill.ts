/**
 * 沉淀提炼 Agent（借鉴 dsh-mnemon 的受监督写入模式）：
 * 独立 ACP 会话 + distill 预设（无工具纯文本），主对话零污染。
 * 输入：任务标题 + 活动流尾部文本 + 相关笔记摘要；输出：结构化知识条目 JSON（或 {skip}）。
 * Host 侧保证：JSON 校验 + 字段边界 + 超时降级；提炼失败 → 调用方回落规则版（零破坏）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import type { AcpClient } from './acp-client.ts'

export interface DistillResult {
  title: string
  content: string[]
  keywords: string[]
  summary: string
}

/** 提炼输入（有界：尾部 2000 字符 + 相关笔记 ≤3 条摘要） */
export function buildDistillPrompt(input: {
  title: string
  tail: string
  related: Array<{ title: string; summary: string }>
}): string {
  const lines: string[] = []
  lines.push('任务标题：' + input.title.slice(0, 200))
  lines.push('')
  lines.push('任务输出（末尾）：')
  lines.push(input.tail.slice(0, 2000))
  if (input.related.length > 0) {
    lines.push('')
    lines.push('相关知识库条目（参考，不要重复沉淀已有结论）：')
    for (const r of input.related.slice(0, 3)) {
      lines.push(`- ${r.title.slice(0, 80)}：${r.summary.slice(0, 120)}`)
    }
  }
  return lines.join('\n')
}

/** 校验并规范化 Agent 返回的 JSON；不合法返回 null（调用方回落）。 */
export function parseDistillJson(text: string): DistillResult | null {
  if (!text) return null
  // 提取 JSON：容忍 ```json 围栏 / 前后说明文字
  let raw = text.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) raw = fence[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (o.skip != null) return { title: '', content: [], keywords: [], summary: '' } // 显式跳过（哨兵：空 title）
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 40) : ''
  const content = Array.isArray(o.content)
    ? o.content.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 8)
    : []
  const keywords = Array.isArray(o.keywords)
    ? o.keywords.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 24)).slice(0, 6)
    : []
  const summary = typeof o.summary === 'string' ? o.summary.trim().slice(0, 120) : content[0]?.slice(0, 120) ?? ''
  if (!title || content.length === 0) return null // 缺关键字段 → 视为无效（回落规则版）
  return { title, content, keywords, summary }
}

/** 从会话日志提取最后一个 assistant/message 文本块（event.type === 'assistant/message'，data.text 聚合）。 */
export function readSessionText(root: string, sid: string): string {
  const file = findSessionLog(root, sid)
  if (!file) return ''
  let text = ''
  try {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as {
          type?: string
          data?: { message?: { content?: Array<{ type?: string; text?: unknown }> }; text?: string | string[] }
        }
        if (ev.type === 'assistant/message') {
          // 最终消息文本在 message.content 的 type==='text' parts（reasoning 部分不算）
          const content = ev.data?.message?.content
          if (Array.isArray(content)) {
            const t = content
              .filter((p) => p?.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text as string)
              .join('')
            if (t) text = t // 保留最后一段（迭代追问取最终输出）
          }
        }
      } catch { /* 半行跳过 */ }
    }
  } catch { return '' }
  return text.trim()
}

/** 递归找 `<root>/.../<sid>/session.jsonl`（sid = 会话目录名，全局唯一）。 */
function findSessionLog(root: string, sid: string): string | null {
  let found: string | null = null
  const walk = (dir: string, depth: number): void => {
    if (found || depth > 4) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch { return }
    for (const name of entries) {
      if (found) return
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (name === sid) {
          const log = join(full, 'session.jsonl')
          try { if (statSync(log).isFile()) found = log } catch { /* 无日志 */ }
        } else {
          walk(full, depth + 1)
        }
      }
    }
  }
  walk(root, 0)
  return found
}

/**
 * 跑一次提炼会话：创建独立 ACP 会话（distill 预设）→ 发 prompt → 等 idle →
 * 读日志取输出 → JSON 解析校验。失败/超时/跳过 → 返回 null（调用方回落规则版）。
 * @param sessionsRoot 会话日志根（HELMSMAN_SESSIONS_ROOT）
 */
export async function distillWithAgent(
  acp: AcpClient,
  sessionsRoot: string,
  input: { cwd: string; title: string; tail: string; related: Array<{ title: string; summary: string }> },
  timeoutMs = 120000,
): Promise<DistillResult | null> {
  const prompt = buildDistillPrompt(input)
  let sid: string | null = null
  try {
    sid = await acp.sessionNew(input.cwd, 'distill')
    const stop = await acp.sessionPrompt(sid, prompt)
    if (stop !== 'end_turn' && stop !== 'idle') return null
    // 日志 flush 有延迟：轮询直到读到输出或超时
    const deadline = Date.now() + timeoutMs
    let text = ''
    while (Date.now() < deadline) {
      text = readSessionText(sessionsRoot, sid)
      if (text) break
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!text) return null
    const parsed = parseDistillJson(text)
    if (parsed == null) return null
    if (parsed.title === '') return null // 显式 skip
    return parsed
  } catch (e) {
    console.error('[distill] 提炼会话失败（回落规则版）:', e instanceof Error ? e.message : e)
    return null
  } finally {
    if (sid) await acp.sessionCancel(sid).catch(() => undefined)
  }
}
