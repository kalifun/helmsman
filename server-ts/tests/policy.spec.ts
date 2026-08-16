/**
 * 策略学习测试（P1 O6）：批复 → 策略原子（count 累计）/ 建议匹配 / 删除。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage, policySuggestion } from '../src/storage.ts'

let dir: string
let s: Storage
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hm-policy-'))
  s = new Storage(join(dir, 'test.db'))
})

describe('策略原子（learnPolicy）', () => {
  it('同 (kind, scope, outcome) 累计 count', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    const p = s.getPolicy('p1', 'checkpoint', 'task', 'approved')
    expect(p?.count).toBe(2)
    expect(s.listPolicies('p1').length).toBe(1)
  })

  it('不同 kind/scope/outcome 各自成条', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    s.learnPolicy('p1', 'checkpoint', 'requirement', 'approved')
    s.learnPolicy('p1', 'calibrate', 'task', 'rejected')
    expect(s.listPolicies('p1').length).toBe(3)
  })

  it('可删除（规则防腐烂，O6）', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    const p = s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    expect(s.deletePolicy(p.id)).toBe(true)
    expect(s.listPolicies('p1').length).toBe(0)
    expect(s.deletePolicy(p.id)).toBe(false)
  })
})

describe('策略建议（policySuggestion）', () => {
  it('count<2 不建议（防噪声）', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    expect(policySuggestion(s, 'p1', 'checkpoint', 'task')).toBeNull()
  })

  it('count>=2 建议（精确卡类型优先）', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    const sug = policySuggestion(s, 'p1', 'checkpoint', 'task')
    expect(sug?.outcome).toBe('approved')
    expect(sug?.count).toBe(2)
    expect(sug?.scope).toBe('task')
  })

  it('卡类型不匹配时 fallback global', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.learnPolicy('p1', 'checkpoint', 'global', 'approved')
    s.learnPolicy('p1', 'checkpoint', 'global', 'approved')
    const sug = policySuggestion(s, 'p1', 'checkpoint', 'bug')
    expect(sug?.scope).toBe('global')
  })

  it('rejected 历史不产生"自动批准"建议', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.learnPolicy('p1', 'checkpoint', 'task', 'rejected')
    s.learnPolicy('p1', 'checkpoint', 'task', 'rejected')
    expect(policySuggestion(s, 'p1', 'checkpoint', 'task')).toBeNull()
  })

  it('不同 kind 互不干扰', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    s.learnPolicy('p1', 'checkpoint', 'task', 'approved')
    expect(policySuggestion(s, 'p1', 'calibrate', 'task')).toBeNull()
  })
})
