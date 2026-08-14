/**
 * 依赖契约测试（目标契约 taskgraph）：validateDeps 校验 / storage deps 往返 / 投影透传。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '../src/storage.ts'
import { newProjection, ensureProject, ensureCard, registerSession, finishSession, depsMet, unmetDeps, validateDeps, newCardState, type CardMeta } from '../src/projection.ts'

let dir: string
let s: Storage
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hm-deps-'))
  s = new Storage(join(dir, 'test.db'))
})

function meta(id: string, deps: string[] = []): CardMeta {
  return { id, title: id, description: '', kind: 'task', milestone: null, criteria: null, deps, created_at: 1 }
}

describe('validateDeps（建卡依赖校验）', () => {
  const known = ['card-a', 'card-b']

  it('undefined → 空数组（无依赖）', () => {
    expect(validateDeps(undefined, known, 'card-c')).toEqual([])
  })

  it('合法引用：去重 + 保持顺序', () => {
    expect(validateDeps(['card-b', 'card-a', 'card-b'], known, 'card-c')).toEqual(['card-b', 'card-a'])
  })

  it('自依赖拒绝', () => {
    expect(() => validateDeps(['card-c'], known, 'card-c')).toThrow('cannot depend on itself')
  })

  it('引用不存在的卡拒绝', () => {
    expect(() => validateDeps(['card-x'], known, 'card-c')).toThrow("dep 'card-x' not in project")
  })

  it('非数组拒绝', () => {
    expect(() => validateDeps('card-a', known, 'card-c')).toThrow('must be an array')
    expect(() => validateDeps([42], known, 'card-c')).toThrow('must be an array')
  })

  it('循环依赖拒绝：新增 A 依赖 B，而 B 已依赖 A → 成环', () => {
    const getDeps = (id: string): string[] => (id === 'card-b' ? ['card-a'] : [])
    expect(() => validateDeps(['card-b'], ['card-a', 'card-b'], 'card-a', getDeps)).toThrow('依赖成环')
  })

  it('非循环通过', () => {
    const getDeps = (id: string): string[] => (id === 'card-b' ? ['card-c'] : [])
    expect(validateDeps(['card-b'], ['card-a', 'card-b', 'card-c'], 'card-a', getDeps)).toEqual(['card-b'])
  })
})

describe('storage：卡 deps 往返', () => {
  it('upsert → loadCards/getCard 读回 deps', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.upsertCard({ ...meta('card-b'), project_id: 'p1' })
    s.upsertCard({ ...meta('card-a', ['card-b']), project_id: 'p1' })
    const cards = s.loadCards('p1')
    const a = cards.find((c) => c.id === 'card-a')
    expect(a?.deps).toEqual(['card-b'])
    expect(s.getCard('card-a')?.deps).toEqual(['card-b'])
    expect(s.getCard('card-b')?.deps).toEqual([])
  })

  it('deps 缺省/非法 JSON → 空数组', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.upsertCard({ ...meta('card-a'), project_id: 'p1' })
    expect(s.getCard('card-a')?.deps).toEqual([])
  })

  it('update 覆盖 deps', () => {
    s.upsertProject('p1', '项目', '/tmp/x', '{}')
    s.upsertCard({ ...meta('card-b'), project_id: 'p1' })
    s.upsertCard({ ...meta('card-a', ['card-b']), project_id: 'p1' })
    s.upsertCard({ ...meta('card-a', []), project_id: 'p1' })
    expect(s.getCard('card-a')?.deps).toEqual([])
  })
})

describe('投影：卡 deps 透传', () => {
  it('newCardState 带 deps；ensureCard 保留', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    ensureCard(p, 'p1', meta('card-a', ['card-b']))
    expect(p.projects['p1'].cards['card-a'].deps).toEqual(['card-b'])
  })

  it('newCardState deps 缺省 → 空数组', () => {
    const st = newCardState(meta('card-x'))
    expect(st.deps).toEqual([])
  })
})

describe('调度门（§2.1）：depsMet / unmetDeps', () => {
  function proj(): ReturnType<typeof newProjection> {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    ensureCard(p, 'p1', meta('card-a'))
    ensureCard(p, 'p1', meta('card-b', ['card-a']))
    return p
  }

  it('上游无执行 → 未解锁（等上游）', () => {
    const p = proj()
    const cards = p.projects['p1'].cards
    expect(depsMet(cards['card-b'], cards)).toBe(false)
    expect(unmetDeps(cards['card-b'], cards)).toEqual(['card-a'])
  })

  it('上游 Running → 未解锁', () => {
    const p = proj()
    const cards = p.projects['p1'].cards
    registerSession(p, 's1', 'p1', 'card-a')
    expect(depsMet(cards['card-b'], cards)).toBe(false)
  })

  it('上游 Done → 解锁', () => {
    const p = proj()
    const cards = p.projects['p1'].cards
    registerSession(p, 's1', 'p1', 'card-a')
    finishSession(p, 's1', 'end_turn', 10)
    expect(depsMet(cards['card-b'], cards)).toBe(true)
    expect(unmetDeps(cards['card-b'], cards)).toEqual([])
  })

  it('无依赖卡恒解锁', () => {
    const p = proj()
    const cards = p.projects['p1'].cards
    expect(depsMet(cards['card-a'], cards)).toBe(true)
  })

  it('多依赖：全部 Done 才解锁', () => {
    const p = proj()
    ensureCard(p, 'p1', meta('card-c'))
    ensureCard(p, 'p1', meta('card-d', ['card-a', 'card-c']))
    const cards = p.projects['p1'].cards
    registerSession(p, 's1', 'p1', 'card-a')
    finishSession(p, 's1', 'end_turn', 10)
    // card-c 无执行 → 仍等上游
    expect(depsMet(cards['card-d'], cards)).toBe(false)
    expect(unmetDeps(cards['card-d'], cards)).toEqual(['card-c'])
  })
})
