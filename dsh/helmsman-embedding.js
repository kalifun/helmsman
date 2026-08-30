// [helmsman] D3-8 本地向量嵌入（server-ts/embedding.ts 迁移）。
// transformers.js + bge-small-zh-v1.5（512 维 ONNX，~95MB）：
//   - 懒加载：首次 embed 才加载模型（HF 缓存默认 ~/.cache/huggingface，HF_HOME 可覆盖）
//   - 降级：模型加载/推理失败 → null，调用方回落规则检索（零破坏）
//   - bge 检索前缀：query 侧加指令前缀（文档侧不加），中文 query 对齐
// 纯函数模块：不注册插件服务，由 helmsman-kb 静态 import 调用。
import { pipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/bge-small-zh-v1.5'
/** bge 检索指令前缀（query 侧；文档侧不加）。中文 query 加中文指令（实测增益显著）。 */
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

let pipe = null
let loading = null

/** 懒加载 embedder；失败返回 null（不抛，调用方降级）。 */
export async function getEmbedder() {
  if (pipe) return pipe
  if (loading) return loading
  loading = (async () => {
    try {
      pipe = await pipeline('feature-extraction', MODEL)
      return pipe
    } catch (e) {
      console.error(`[helmsman-embedding] 模型加载失败（${MODEL}），检索回落规则通道：`, e?.message ?? e)
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
export async function embedTexts(texts, opts = {}) {
  const p = await getEmbedder()
  if (!p) return null
  if (!texts || texts.length === 0) return []
  const mapped = opts.query
    ? texts.map((t) => (/[\u4e00-\u9fa5]/.test(t ?? '') ? QUERY_PREFIX : '') + (t ?? ''))
    : texts.map((t) => t ?? '')
  const out = await p(mapped, { pooling: 'mean', normalize: true })
  // transformers.js 多输入可能返回 Tensor 数组（每条一个）或单个 batch Tensor [n, dim]
  if (Array.isArray(out)) {
    return out.map((r) => Float32Array.from(r?.data ?? []))
  }
  const t = out ?? {}
  const data = t.data
  if (!data) return null
  if (texts.length === 1 || data.length === texts.length) return [Float32Array.from(data)]
  const per = Math.floor(data.length / texts.length)
  const rows = []
  for (let i = 0; i < texts.length; i++) rows.push(Float32Array.from(data.subarray(i * per, (i + 1) * per)))
  return rows
}

/** 余弦相似度（向量已归一化时等价于点积，仍显式归一防未归一输入）。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
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

/** 笔记向量缓存（按 id + updatedAt 失效；装配是任务启动路径，避免每次全量重算）。 */
const noteVecCache = new Map()

function noteEmbedText(n) {
  return `${n.title ?? ''}\n${n.summary ?? ''}\n${(n.content ?? []).join('\n').slice(0, 2000)}`
}

/**
 * 批量嵌入笔记（带缓存）：只对未缓存/内容变化的笔记计算，其余直接复用。
 * @returns 与 notes 等长的向量数组；embedder 不可用时返回 null
 */
export async function embedNotes(notes) {
  const p = await getEmbedder()
  if (!p) return null
  if (!notes || notes.length === 0) return []
  const out = new Array(notes.length)
  const miss = []
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
