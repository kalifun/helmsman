/**
 * 执行经济学测试（P1.5）：峰谷定价 —— 北京时间高峰判定 / 按时段取价 / 成本估算。
 */
import { describe, expect, it } from 'vitest'
import { isPeakHour, priceOf, estCostFrom, PEAK, OFFPEAK } from '../src/pricing.ts'

const bj = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h - 8, mi)) // 构造北京时间

describe('峰谷定价（P1.5）', () => {
  it('高峰时段：北京 9-12 与 14-18', () => {
    expect(isPeakHour(bj(2026, 8, 18, 9))).toBe(true)   // 9:00 开始
    expect(isPeakHour(bj(2026, 8, 18, 11, 59))).toBe(true)
    expect(isPeakHour(bj(2026, 8, 18, 12))).toBe(false)  // 12-14 空闲
    expect(isPeakHour(bj(2026, 8, 18, 14))).toBe(true)   // 14:00 开始
    expect(isPeakHour(bj(2026, 8, 18, 17, 59))).toBe(true)
    expect(isPeakHour(bj(2026, 8, 18, 18))).toBe(false)  // 18:00 结束
    expect(isPeakHour(bj(2026, 8, 18, 2))).toBe(false)   // 凌晨空闲
  })

  it('按时段取价：高峰=空闲×2（Flash）', () => {
    const peak = priceOf('deepseek-v4-flash', bj(2026, 8, 18, 10))
    const off = priceOf('deepseek-v4-flash', bj(2026, 8, 18, 2))
    expect(peak.input).toBe(PEAK.flash.input)
    expect(off.input).toBe(OFFPEAK.flash.input)
    expect(peak.input).toBe(off.input * 2)
    expect(peak.output).toBe(off.output * 2)
  })

  it('model 含 pro → pro 价', () => {
    const p = priceOf('DeepSeek-V4-Pro', bj(2026, 8, 18, 10))
    expect(p.input).toBe(PEAK.pro.input)
    const p2 = priceOf(undefined, bj(2026, 8, 18, 10))
    expect(p2.input).toBe(PEAK.flash.input)
  })

  it('成本估算：1M 输出 token 高峰 Flash = 9 元', () => {
    const cost = estCostFrom({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, reasoningTokens: 0 }, PEAK.flash)
    expect(cost).toBeCloseTo(9.0)
  })

  it('缓存命中省钱：1M 缓存读高峰 Flash = 0.1 元', () => {
    const cost = estCostFrom({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, reasoningTokens: 0 }, PEAK.flash)
    expect(cost).toBeCloseTo(0.1)
  })
})
