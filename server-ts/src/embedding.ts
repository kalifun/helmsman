/**
 * 本地向量嵌入（P2 向量检索第一步）。
 * transformers.js + bge-small-zh-v1.5（512 维 ONNX，~95MB）：
 *  - 懒加载：首次 embed 时才加载模型（HF 缓存默认 ~/.cache/huggingface，可用 HF_HOME 覆盖）
 *  - 降级：模型加载/推理失败 → 返回 null，调用方回落规则检索（零破坏）
 *  - bge 检索前缀：query 侧加指令前缀（文档侧不加），中文/英文 query 都能对齐
 */
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/bge-small-zh-v1.5'
/** bge 检索指令前缀（query 侧；文档侧不加）。中文 query 加中文指令（实测 0.77 vs 0.44 增益显著）；
 * 英文 query 对 bge-zh 天花板 ~0.45，不加前缀（规则通道兜底，语义分只作融合加权）。 */
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

let pipe: FeatureExtractionPipeline | null = null
let loading: Promise<FeatureExtractionPipeline | null> | null = null

/** 懒加载 embedder；失败返回 null（不抛，调用方降级） */
export async function getEmbedder(): Promise<FeatureExtractionPipeline | null> {
  if (pipe) return pipe
  if (loading) return loading
  loading = (async () => {
    try {
      pipe = await pipeline('feature-extraction', MODEL)
      return pipe
    } catch (e) {
      console.error(`[embed] 模型加载失败（${MODEL}），检索回落规则通道：`, e instanceof Error ? e.message : e)
      pipe = null
      return null
    }
  })()
  return loading
}

/**
 * 批量嵌入文本（mean pooling + L2 归一化）。
 * @returns 每段文本的向量；embedder 不可用时返回 null
 */
export async function embedTexts(
  texts: string[],
  opts: { query?: boolean } = {},
): Promise<Float32Array[] | null> {
  const p = await getEmbedder()
  if (!p) return null
  if (texts.length === 0) return []
  const mapped = opts.query
    ? texts.map((t) => (/[\u4e00-\u9fa5]/.test(t) ? QUERY_PREFIX : '') + t)
    : texts
  const out = await p(mapped, { pooling: 'mean', normalize: true })
  // transformers.js 多输入可能返回 Tensor 数组（每条一个）或单个 batch Tensor [n, dim]
  // （版本相关，实测 4.2.0 两者都出现过）——统一解析成按条切分的向量。
  if (Array.isArray(out)) {
    return (out as unknown as Array<{ data: Float32Array }>).map((r) => Float32Array.from(r.data))
  }
  const t = out as unknown as { data: Float32Array; dims?: number[] }
  const data = t.data
  if (texts.length === 1 || data.length === texts.length) return [Float32Array.from(data)]
  const per = Math.floor(data.length / texts.length)
  const rows: Float32Array[] = []
  for (let i = 0; i < texts.length; i++) rows.push(Float32Array.from(data.subarray(i * per, (i + 1) * per)))
  return rows
}

/** 余弦相似度（向量已归一化时等价于点积，这里仍显式归一防未归一输入） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** 笔记向量缓存（按 id + updatedAt 失效；装配是任务启动路径，避免每次全量重算） */
const noteVecCache = new Map<string, { updatedAt: number; vec: Float32Array }>()

function noteEmbedText(n: { title: string; summary?: string; content: string[] }): string {
  return `${n.title}\n${n.summary ?? ''}\n${n.content.join('\n').slice(0, 2000)}`
}

/**
 * 批量嵌入笔记（带缓存）：只对未缓存/内容变化的笔记计算，其余直接复用。
 * @returns 与 notes 等长的向量数组；embedder 不可用时返回 null
 */
export async function embedNotes(
  notes: Array<{ id: string; updatedAt?: number; title: string; summary?: string; content: string[] }>,
): Promise<Float32Array[] | null> {
  const p = await getEmbedder()
  if (!p) return null
  const out: Float32Array[] = new Array(notes.length)
  const miss: number[] = []
  notes.forEach((n, i) => {
    const hit = noteVecCache.get(n.id)
    if (hit && hit.updatedAt === (n.updatedAt ?? 0)) out[i] = hit.vec
    else miss.push(i)
  })
  if (miss.length > 0) {
    const vecs = await embedTexts(miss.map((i) => noteEmbedText(notes[i])))
    if (!vecs) return null
    miss.forEach((i, k) => {
      const v = vecs[k]
      noteVecCache.set(notes[i].id, { updatedAt: notes[i].updatedAt ?? 0, vec: v })
      out[i] = v
    })
  }
  return out
}
