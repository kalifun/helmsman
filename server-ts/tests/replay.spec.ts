/**
 * 回放测试 —— 平移 crates/taskgraph/tests/replay.rs。
 * 用真实会话日志折叠，断言确定性 + 状态正确。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newTaskState, foldTask, finishTask } from '../src/projection.ts'

const FIXTURE = readFileSync(join(__dirname, 'fixtures/session-sample.jsonl'), 'utf8')

function foldAll(): { state: ReturnType<typeof newTaskState>; events: number } {
  const state = newTaskState('replay')
  let events = 0
  for (const line of FIXTURE.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const v = JSON.parse(t) as Record<string, unknown>
    if (v.seq === undefined && v.seq0 === undefined) continue // header（无 seq）
    events += 1
    foldTask(state, v)
  }
  return { state, events }
}

describe('replay: 真实会话日志', () => {
  it('38 个真实事件，状态正确', () => {
    const { state, events } = foldAll()
    expect(events).toBe(38)
    // 日志无终态 → 仍 Running（终态靠 ACP）
    expect(state.status).toBe('Running')
    expect(state.steps).toBe(2)
    expect(state.turns).toBe(1)
    expect(state.tool_calls.length).toBeGreaterThan(0)
    const bash = state.tool_calls.find((t) => t.name === 'bash')
    expect(bash).toBeDefined()
    expect(bash!.args.length).toBeGreaterThan(0)
    expect(state.activities.length).toBeGreaterThan(0)
    expect(state.last_seq).toBeGreaterThan(400)
    expect(state.model).toBe('deepseek-v4-flash')
  })

  it('确定性：重放两次状态一致', () => {
    const a = foldAll().state
    const b = foldAll().state
    expect(a.last_seq).toBe(b.last_seq)
    expect(a.activities.length).toBe(b.activities.length)
    expect(a.tool_calls.length).toBe(b.tool_calls.length)
  })

  it('终态由控制通道提供：end_turn → Done', () => {
    const { state } = foldAll()
    finishTask(state, 'end_turn', 1_786_440_325_000)
    expect(state.status).toBe('Done')
    expect(state.finished_at).toBeDefined()
  })
})
