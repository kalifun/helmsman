/**
 * 启动恢复测试 —— 平移 crates/taskgraph/tests/recovery.rs。
 * 从真实会话日志 fixture 重建投影（卡/执行两层）。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { newProjection } from '../src/projection.ts'
import { recoverStore, projectIdForSessionCwd, type RecoveredCard } from '../src/recovery.ts'

const FIXTURE_ROOT = join(__dirname, 'fixtures')
const DEFAULT_PROJECT: [string, string] = ['helmsman', '/Users/kalifun/Code/github/opensource/helmsman']

describe('recovery: 从日志恢复', () => {
  it('无执行记录 → 隐式建卡（1 卡 1 执行）', () => {
    const proj = newProjection()
    const { restored, offsets } = recoverStore(FIXTURE_ROOT, proj, DEFAULT_PROJECT, new Map())
    expect(restored).toBe(1)
    expect(offsets.size).toBe(1)

    expect(proj.projects['helmsman']).toBeDefined()
    const cards = proj.projects['helmsman'].cards
    expect(Object.keys(cards).length).toBe(1)
    const card = Object.values(cards)[0]
    expect(card.exec_order.length).toBe(1)
    const sid = card.exec_order[0]
    const task = card.executions[sid]
    expect(task.recovered).toBe(true)
    // 中断检测（recovery.ts）：日志无 turn/end → 上次进程被中断 → 标记 Failed（不复位为 Running）
    expect(task.status).toBe('Failed')
    expect(task.steps).toBe(2)
    expect(task.model).toBe('deepseek-v4-flash')
    expect(sid.length).toBeGreaterThan(0)
  })

  it('确定性：干净重放两次一致', () => {
    const a = newProjection()
    const b = newProjection()
    recoverStore(FIXTURE_ROOT, a, DEFAULT_PROJECT, new Map())
    recoverStore(FIXTURE_ROOT, b, DEFAULT_PROJECT, new Map())
    const ta = Object.values(a.projects['helmsman'].cards)[0].executions
    const tb = Object.values(b.projects['helmsman'].cards)[0].executions
    const [sa] = Object.keys(ta)
    const [sb] = Object.keys(tb)
    expect(ta[sa].last_seq).toBe(tb[sb].last_seq)
    expect(ta[sa].activities.length).toBe(tb[sb].activities.length)
  })

  it('有执行记录 → 会话挂到指定卡；无日志的 Pending 也占位', () => {
    const cardOfSession = new Map<string, RecoveredCard>()
    cardOfSession.set('sess-from-log', {
      projectId: 'helmsman',
      meta: { id: 'card-x', title: '修复登录锁时序', description: 'transfer.go 锁竞态', kind: 'bug', milestone: 'v0.2', criteria: null, created_at: 100 },
      executionCreatedAt: 100,
    })
    cardOfSession.set('sess-pending', {
      projectId: 'helmsman',
      meta: { id: 'card-x', title: '修复登录锁时序', description: '', kind: 'bug', milestone: null, criteria: null, created_at: 100 },
      executionCreatedAt: 300,
    })

    const proj = newProjection()
    const { restored } = recoverStore(FIXTURE_ROOT, proj, DEFAULT_PROJECT, cardOfSession)
    expect(restored).toBe(1) // 日志会话恢复 1 个

    const cards = proj.projects['helmsman'].cards
    expect(cards['card-x']).toBeDefined()
    expect(cards['card-x'].kind).toBe('bug')
    expect(cards['card-x'].milestone).toBe('v0.2')
    // 日志会话挂到卡；无日志的 Pending 执行也占位
    expect(cards['card-x'].executions['sess-from-log']).toBeDefined()
    expect(cards['card-x'].executions['sess-pending']).toBeDefined()
    // 旧会话（fixture 的 sid）无执行记录 → 隐式卡
    const legacy = cards['c5c42045-3350-4a28-9df1-c5bb8208b972']
    expect(legacy).toBeDefined()
    expect(legacy.exec_order.length).toBe(1)
    // card-x 下 2 次执行（日志会话 + Pending 占位）
    expect(cards['card-x'].exec_order.length).toBe(2)
  })
})

describe('recovery: worktree cwd 不另立项目', () => {
  const repo = '/Users/kalifun/Code/github/opensource/helmsman'
  const wt = `${repo}/.helmsman/worktrees/card-1787145163804-0-mt0435su`

  it('隔离区 cwd 归到仓库项目，不用 card- 目录名', () => {
    const id = projectIdForSessionCwd(
      wt,
      'sess-1',
      [{ id: 'helmsman', path: repo }],
      ['helmsman', repo],
    )
    expect(id).toBe('helmsman')
    expect(id.startsWith('card-')).toBe(false)
  })

  it('没有已知项目时也不用隔离区目录名当项目 id', () => {
    const id = projectIdForSessionCwd(wt, 'sess-1', [], null)
    expect(id).toBe('sess-1')
  })
})
