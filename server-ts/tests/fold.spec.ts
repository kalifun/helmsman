/**
 * fold 行为测试 —— 平移 crates/taskgraph/tests/fold_turn_end.rs + fold_comments.rs。
 * 纯逻辑，不依赖 SQLite。
 */
import { describe, expect, it } from 'vitest'
import { newTaskState, foldTask, finishTask, type TaskState } from '../src/projection.ts'

function foldEv(state: TaskState, ty: string, data: Record<string, unknown>): void {
  foldTask(state, { type: ty, seq: 1, time: 1, data })
}

describe('fold: turn/end 终态', () => {
  it('turn/start → Running，completed → Done', () => {
    const s = newTaskState('t1')
    foldEv(s, 'turn/start', { turn: 1 })
    expect(s.status).toBe('Running')
    foldEv(s, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(s.status).toBe('Done')
    expect(s.finished_at).toBeDefined()
  })

  it('cancelled → Cancelled', () => {
    const s = newTaskState('t2')
    foldEv(s, 'turn/start', { turn: 1 })
    foldEv(s, 'turn/end', { turn: 1, reason: { kind: 'cancelled' } })
    expect(s.status).toBe('Cancelled')
  })

  it('未知 reason → Failed', () => {
    const s = newTaskState('t3')
    foldEv(s, 'turn/start', { turn: 1 })
    foldEv(s, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    expect(s.status).toBe('Failed')
  })
})

describe('fold: 评论线程', () => {
  it('user 消息（source.kind=user）进评论', () => {
    const s = newTaskState('c1')
    foldEv(s, 'user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '帮我修 bug' }],
    })
    expect(s.comments).toHaveLength(1)
    expect(s.comments[0]).toMatchObject({ who: 'user', text: '帮我修 bug' })
  })

  it('assistant 消息不进评论（评论只收用户控制通道）', () => {
    const s = newTaskState('c2')
    foldEv(s, 'assistant/message', {
      source: { kind: 'assistant' },
      content: [{ type: 'text', text: '好的' }],
    })
    expect(s.comments).toHaveLength(0)
  })

  it('system-reminder（source 无 kind）不进评论', () => {
    const s = newTaskState('c3')
    foldEv(s, 'user/message', {
      source: {},
      content: [{ type: 'text', text: 'system reminder' }],
    })
    expect(s.comments).toHaveLength(0)
  })

  it('多块 content 文本用换行连接', () => {
    const s = newTaskState('c4')
    foldEv(s, 'user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
    })
    expect(s.comments[0].text).toBe('第一段\n第二段')
  })
})

describe('fold: usage 累积（§6 执行经济学）', () => {
  it('assistant/message.usage 累加到会话级', () => {
    const s = newTaskState('u1')
    foldEv(s, 'assistant/message', { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 500, reasoningTokens: 20 } })
    foldEv(s, 'assistant/message', { usage: { inputTokens: 60, outputTokens: 30, cacheReadTokens: 200, reasoningTokens: 10 } })
    expect(s.usage).toEqual({ inputTokens: 160, outputTokens: 80, cacheReadTokens: 700, reasoningTokens: 30 })
  })
})

describe('finish: 控制通道终态', () => {
  it('end_turn → Done + finished_at', () => {
    const s = newTaskState('f1')
    finishTask(s, 'end_turn', 123456)
    expect(s.status).toBe('Done')
    expect(s.finished_at).toBe(123456)
  })
  it('cancelled → Cancelled', () => {
    const s = newTaskState('f2')
    finishTask(s, 'cancelled', 1)
    expect(s.status).toBe('Cancelled')
  })
  it('其他 → Failed', () => {
    const s = newTaskState('f3')
    finishTask(s, 'error', 1)
    expect(s.status).toBe('Failed')
  })
})

describe('fold: waiting 保护（阶段 2 · plan/acceptance）', () => {
  it('waiting 非空时 turn/end 不覆盖终态', () => {
    const s = newTaskState('w1')
    foldEv(s, 'turn/start', { turn: 1 })
    // 挂 Waiting（模拟 plan 模式：计划已产出待批复）
    s.waiting = { kind: 'plan', reason: '计划待批复', payload: {} }
    foldEv(s, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    // waiting 保护：状态不被 turn/end 覆盖为 Done
    expect(s.status).toBe('Running')
    expect(s.waiting).not.toBeNull()
  })

  it('无 waiting 时 turn/end 正常定终态（回归）', () => {
    const s = newTaskState('w2')
    foldEv(s, 'turn/start', { turn: 1 })
    foldEv(s, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(s.status).toBe('Done')
  })

  it('waiting 清除后 turn/end 恢复定终态（批准放行后）', () => {
    const s = newTaskState('w3')
    foldEv(s, 'turn/start', { turn: 1 })
    s.waiting = { kind: 'plan', reason: 'x', payload: {} }
    foldEv(s, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(s.status).toBe('Running')
    // 批准放行：waiting 清除，新 turn 结束 → 正常定终态
    s.waiting = null
    s.status = 'Running'
    foldEv(s, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(s.status).toBe('Done')
  })
})
