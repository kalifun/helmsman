/**
 * 卡/执行两层测试 —— 平移 crates/taskgraph/tests/cards_executions.rs。
 */
import { describe, expect, it } from 'vitest'
import {
  newProjection,
  ensureProject,
  ensureCard,
  registerSession,
  foldSession,
  finishSession,
  removeProject,
  type CardMeta,
} from '../src/projection.ts'

function meta(id: string, title: string): CardMeta {
  return { id, title, description: '', kind: 'task', milestone: null, criteria: null, created_at: 1 }
}

function foldEv(proj: ReturnType<typeof newProjection>, sid: string, ty: string): void {
  foldSession(proj, sid, { type: ty, seq: 1, time: 1, data: { turn: 1 } })
}

describe('卡/执行两层', () => {
  it('一卡多执行，最新执行决定卡状态', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    ensureCard(p, 'p1', meta('card-1', '任务一'))
    registerSession(p, 's1', 'p1', 'card-1')
    registerSession(p, 's2', 'p1', 'card-1')

    const card = p.projects['p1'].cards['card-1']
    expect(card.exec_order).toEqual(['s1', 's2'])
    expect(card.executions['s1'].status).toBe('Pending')
    expect(card.executions['s2'].status).toBe('Pending')

    // 首代完成 → Done；第二代 Running → 卡状态 = Running（最新执行）
    finishSession(p, 's1', 'end_turn', 10)
    foldEv(p, 's2', 'turn/start')
    expect(card.executions['s1'].status).toBe('Done')
    expect(card.executions['s2'].status).toBe('Running')
  })

  it('会话经 session_card 映射路由到对应执行', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    ensureCard(p, 'p1', meta('card-1', '任务一'))
    ensureCard(p, 'p1', meta('card-2', '任务二'))
    registerSession(p, 's1', 'p1', 'card-1')
    registerSession(p, 's2', 'p1', 'card-2')

    foldEv(p, 's1', 'turn/start')
    foldEv(p, 's2', 'turn/start')

    expect(p.projects['p1'].cards['card-1'].executions['s1'].status).toBe('Running')
    expect(p.projects['p1'].cards['card-2'].executions['s2'].status).toBe('Running')
    // 互不串扰
    expect(p.projects['p1'].cards['card-1'].executions['s2']).toBeUndefined()
  })

  it('registerSession 幂等：重复注册不产生重复执行', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    ensureCard(p, 'p1', meta('card-1', '任务一'))
    registerSession(p, 's1', 'p1', 'card-1')
    registerSession(p, 's1', 'p1', 'card-1')
    expect(p.projects['p1'].cards['card-1'].exec_order).toEqual(['s1'])
  })

  it('removeProject 清掉会话映射', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    ensureCard(p, 'p1', meta('card-1', '任务一'))
    registerSession(p, 's1', 'p1', 'card-1')
    removeProject(p, 'p1')
    expect(p.projects['p1']).toBeUndefined()
    expect(p.sessionCard['s1']).toBeUndefined()
    expect(p.sessionProject['s1']).toBeUndefined()
  })
})
