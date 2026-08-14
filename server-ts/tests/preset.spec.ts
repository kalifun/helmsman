/**
 * 阶段 2 测试：plan 检测 + 预设快照 + delivery 验收门。
 */
import { describe, expect, it } from 'vitest'
import { newTaskState, detectPlanCompletion, extractPlanText, PLAN_DONE_MARKER } from '../src/projection.ts'

describe('plan 模式：计划完成检测（阶段 2）', () => {
  it('活动含【计划完毕】标记 → 检测为计划完成', () => {
    const t = newTaskState('p1')
    t.activities = [
      { Text: { text: '计划：1) 改 CSS 2) 测字体', at: 1, turn: 1 } },
      { Text: { text: `${PLAN_DONE_MARKER}`, at: 2, turn: 1 } },
    ]
    expect(detectPlanCompletion(t)).toBe(true)
  })

  it('无标记 → 未完成计划', () => {
    const t = newTaskState('p2')
    t.activities = [{ Text: { text: '我先看看代码结构', at: 1, turn: 1 } }]
    expect(detectPlanCompletion(t)).toBe(false)
  })

  it('标记在 Reasoning 里也能检测（思考折叠时输出标记）', () => {
    const t = newTaskState('p3')
    t.activities = [{ Reasoning: { text: `计划完毕标记 ${PLAN_DONE_MARKER}`, at: 1, turn: 1 } }]
    expect(detectPlanCompletion(t)).toBe(true)
  })

  it('空活动 → 未完成', () => {
    const t = newTaskState('p4')
    expect(detectPlanCompletion(t)).toBe(false)
  })
})

describe('plan 模式：计划文本提取（阶段 2 修复）', () => {
  it('只取 Text 活动（Reasoning 不算计划输出）', () => {
    const t = newTaskState('p5')
    t.activities = [
      { Reasoning: { text: 'The user wants a plan first, let me think...', at: 1, turn: 1 } },
      { Text: { text: '## 计划：步骤1 读文件，步骤2 总结', at: 2, turn: 1 } },
      { Text: { text: `${PLAN_DONE_MARKER}`, at: 3, turn: 1 } },
    ]
    const plan = extractPlanText(t)
    expect(plan).toContain('步骤1')
    expect(plan).not.toContain('let me think') // Reasoning 不混入
    expect(plan).not.toContain(PLAN_DONE_MARKER)
  })

  it('无标记时返回全部 Text 尾部', () => {
    const t = newTaskState('p6')
    t.activities = [{ Text: { text: '计划草案：A B C', at: 1, turn: 1 } }]
    expect(extractPlanText(t)).toContain('A B C')
  })
})
