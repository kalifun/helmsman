/**
 * 简单会话测试（A 组会话层闭环）：独立会话模型 —— register/fold/finish 到 chats，不建卡。
 */
import { describe, expect, it } from 'vitest'
import {
  newProjection, ensureProject, ensureCard, registerSession, foldSession, finishSession,
  type TaskState,
} from '../src/projection.ts'

describe('简单会话（chat）模型', () => {
  it('cardId 空 → 挂项目 chats，不进卡', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    ensureCard(p, 'p1', { id: 'card-1', title: '任务', description: '', kind: 'task', milestone: null, criteria: null, deps: [], created_at: 1 })
    registerSession(p, 'chat-1', 'p1', '')
    registerSession(p, 's1', 'p1', 'card-1')
    expect(p.projects['p1'].chats['chat-1']).toBeDefined()
    expect(p.projects['p1'].cards['card-1'].executions['chat-1']).toBeUndefined()
    expect(p.projects['p1'].cards['card-1'].executions['s1']).toBeDefined()
    expect(p.sessionCard['chat-1']).toBe('')
  })

  it('fold/finish 到 chats（简单会话状态推进）', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    registerSession(p, 'chat-1', 'p1', '')
    foldSession(p, 'chat-1', { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
    expect(p.projects['p1'].chats['chat-1'].status).toBe('Running')
    finishSession(p, 'chat-1', 'end_turn', 10)
    expect(p.projects['p1'].chats['chat-1'].status).toBe('Done')
    expect(p.projects['p1'].chats['chat-1'].turns).toBe(1)
  })

  it('简单会话与卡执行互不串扰', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    ensureCard(p, 'p1', { id: 'card-1', title: '任务', description: '', kind: 'task', milestone: null, criteria: null, deps: [], created_at: 1 })
    registerSession(p, 'chat-1', 'p1', '')
    registerSession(p, 's1', 'p1', 'card-1')
    foldSession(p, 'chat-1', { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
    expect(p.projects['p1'].cards['card-1'].executions['s1'].status).toBe('Pending')
    expect(p.projects['p1'].chats['chat-1'].status).toBe('Running')
  })

  it('提升为任务：会话从 chats 转到卡 executions（保留事件流）', () => {
    const p = newProjection()
    ensureProject(p, 'p1', '项目', '/tmp/x')
    registerSession(p, 'chat-1', 'p1', '')
    foldSession(p, 'chat-1', { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
    const t = p.projects['p1'].chats['chat-1']
    // 模拟 promote：建卡 + 会话挂卡
    const cardId = 'card-promoted'
    ensureCard(p, 'p1', { id: cardId, title: '提升的任务', description: '', kind: 'task', milestone: null, criteria: null, deps: [], created_at: 1 })
    delete p.projects['p1'].chats['chat-1']
    p.projects['p1'].cards[cardId].executions['chat-1'] = t
    p.projects['p1'].cards[cardId].exec_order.push('chat-1')
    p.sessionCard['chat-1'] = cardId
    expect(p.projects['p1'].chats['chat-1']).toBeUndefined()
    expect(p.projects['p1'].cards[cardId].executions['chat-1'].status).toBe('Running') // 事件流保留
    expect(p.projects['p1'].cards[cardId].exec_order).toEqual(['chat-1'])
  })
})
