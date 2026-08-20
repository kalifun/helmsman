/**
 * Profile 存储测试：内置种子 / 三轴快照 / 默认切换。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage, BUILTIN_PROFILES } from '../src/storage.ts'

let dir: string
let s: Storage
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hm-profile-'))
  s = new Storage(join(dir, 'test.db'))
})

describe('Profile 存储（§2.6）', () => {
  it('种子内置 4 个，首个为默认', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    const first = s.seedProfiles('p1')
    expect(first).toBe(true)
    const ps = s.listProfiles('p1')
    expect(ps.length).toBe(4)
    expect(ps.filter((p) => p.is_default).length).toBe(1)
    expect(ps.find((p) => p.is_default)?.id).toBe(BUILTIN_PROFILES[0].id)
  })

  it('重复种子幂等', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.seedProfiles('p1')
    const again = s.seedProfiles('p1')
    expect(again).toBe(false)
    expect(s.listProfiles('p1').length).toBe(4)
  })

  it('自定义 Profile 可创建，内置不可覆盖', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.seedProfiles('p1')
    s.upsertProfile('p1', { id: 'my-plan', name: '我的计划流', is_builtin: false, mode: 'plan', setting: 'delivery', approval: 'ask', sandbox: 'workspace-write', is_default: false })
    const p = s.getProfile('p1', 'my-plan')
    expect(p).toBeDefined()
    expect(p!.mode).toBe('plan')
    // 内置覆盖被拒绝（ON CONFLICT WHERE is_builtin=0）
    s.upsertProfile('p1', { id: 'standard', name: '篡改', is_builtin: false, mode: 'yolo' as never, setting: 'light', approval: 'yolo', sandbox: 'danger-full-access', is_default: false })
    const st = s.getProfile('p1', 'standard')
    expect(st!.name).toBe('标准') // 未被篡改
  })

  it('设默认：清旧设新', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.seedProfiles('p1')
    s.upsertProfile('p1', { id: 'mine', name: '我的', is_builtin: false, mode: 'normal', setting: 'balanced', approval: 'ask', sandbox: 'workspace-write', is_default: false })
    expect(s.setDefaultProfile('p1', 'mine')).toBe(true)
    const ps = s.listProfiles('p1')
    expect(ps.find((p) => p.is_default)?.id).toBe('mine')
  })

  it('自定义可删，内置不可删；删默认回落到内置', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.seedProfiles('p1')
    s.upsertProfile('p1', { id: 'mine', name: '我的', is_builtin: false, mode: 'normal', setting: 'balanced', approval: 'ask', sandbox: 'workspace-write', is_default: false })
    expect(s.setDefaultProfile('p1', 'mine')).toBe(true)
    expect(s.removeProfile('p1', 'standard')).toBe(false)
    expect(s.removeProfile('p1', 'mine')).toBe(true)
    expect(s.getProfile('p1', 'mine')).toBeUndefined()
    expect(s.defaultProfile('p1')?.id).toBe(BUILTIN_PROFILES[0].id)
  })
})
