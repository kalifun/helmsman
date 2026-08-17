/**
 * 执行经济学定价（P1.5 修正）：DeepSeek V4 峰谷定价（2026-08-17 生效）。
 * 高峰时段 = 北京时间 9:00–12:00 ∪ 14:00–18:00（央视财经确认），其余空闲，空闲 = 高峰半价。
 * 元/百万 tokens。reasoning 未单独公布 → 按输出价近似。
 */
export interface PriceTable {
  input: number      // 输入（缓存未命中）
  output: number     // 输出
  cacheRead: number  // 输入（缓存命中）
  reasoning: number  // 推理（近似输出价）
}

export const PEAK: Record<'flash' | 'pro', PriceTable> = {
  flash: { input: 3.0, output: 9.0, cacheRead: 0.1, reasoning: 9.0 },
  pro: { input: 9.0, output: 27.0, cacheRead: 0.3, reasoning: 27.0 },
}

export const OFFPEAK: Record<'flash' | 'pro', PriceTable> = {
  flash: { input: 1.5, output: 4.5, cacheRead: 0.05, reasoning: 4.5 },
  pro: { input: 4.5, output: 13.5, cacheRead: 0.15, reasoning: 13.5 },
}

/** 北京时间高峰判定（9:00–12:00 ∪ 14:00–18:00） */
export function isPeakHour(now = new Date()): boolean {
  const h = (now.getUTCHours() + 8) % 24 // 北京时间 UTC+8
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 按时段取价表（默认 flash；model 含 'pro' 取 pro） */
export function priceOf(model: string | undefined, now = new Date()): PriceTable {
  const tier: 'flash' | 'pro' = model && model.toLowerCase().includes('pro') ? 'pro' : 'flash'
  return isPeakHour(now) ? PEAK[tier] : OFFPEAK[tier]
}

/** 按用量与价格表估算成本（¥）；usage 各字段 = token 数 */
export function estCostFrom(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number },
  price: PriceTable,
): number {
  return (
    (usage.inputTokens / 1e6) * price.input +
    (usage.outputTokens / 1e6) * price.output +
    (usage.cacheReadTokens / 1e6) * price.cacheRead +
    (usage.reasoningTokens / 1e6) * price.reasoning
  )
}
