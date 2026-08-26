import { describe, expect, it } from 'vitest'
import { parseDistillJson, buildDistillPrompt } from '../src/distill.ts'

describe('提炼 JSON 解析（distill Agent 输出校验）', () => {
  it('纯 JSON 正常解析', () => {
    const r = parseDistillJson('{"title": "transfer.go 锁时序根因", "content": ["加锁顺序不一致会死锁"], "keywords": ["transfer.go"], "summary": "锁时序问题"}')
    expect(r).not.toBeNull()
    expect(r!.title).toBe('transfer.go 锁时序根因')
    expect(r!.content).toEqual(['加锁顺序不一致会死锁'])
  })

  it('```json 围栏 + 前后说明文字容忍', () => {
    const r = parseDistillJson('好的，结论如下：\n```json\n{"title": "A", "content": ["事实1"]}\n```\n以上')
    expect(r).not.toBeNull()
    expect(r!.title).toBe('A')
  })

  it('显式 skip → 返回空 title 哨兵', () => {
    const r = parseDistillJson('{"skip": "泛化总结，无项目特有事实"}')
    expect(r).not.toBeNull()
    expect(r!.title).toBe('')
  })

  it('字段边界：title ≤40 / content ≤8 行 / keywords ≤6', () => {
    const longTitle = 'x'.repeat(80)
    const manyContent = Array.from({ length: 12 }, (_, i) => `line${i}`)
    const manyKw = Array.from({ length: 10 }, (_, i) => `kw${i}`)
    const r = parseDistillJson(JSON.stringify({ title: longTitle, content: manyContent, keywords: manyKw }))
    expect(r!.title.length).toBe(40)
    expect(r!.content.length).toBe(8)
    expect(r!.keywords.length).toBe(6)
  })

  it('无效：非 JSON / 缺 title / content 空 → null', () => {
    expect(parseDistillJson('不是 JSON')).toBeNull()
    expect(parseDistillJson('{"content": ["只有内容"]}')).toBeNull()
    expect(parseDistillJson('{"title": "t", "content": []}')).toBeNull()
    expect(parseDistillJson('')).toBeNull()
  })

  it('buildDistillPrompt 有界：尾部截断 2000 字符', () => {
    const p = buildDistillPrompt({ title: '任务', tail: 'x'.repeat(5000), related: [] })
    expect(p).toContain('任务')
    expect(p.length).toBeLessThan(2400)
  })
})
