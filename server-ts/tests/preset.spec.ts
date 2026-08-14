/**
 * 阶段 2 测试：plan 检测 + 预设快照 + delivery 验收门。
 */
import { describe, expect, it } from 'vitest'
import { newTaskState, detectPlanCompletion, extractPlanText, detectMarker, extractMarkerText, PLAN_DONE_MARKER, CALIBRATE_DONE_MARKER } from '../src/projection.ts'

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

  it('G5 回归：标记只在 Reasoning（思考讨论标记字符串）→ 不检测（假阳性）', () => {
    const t = newTaskState('p3')
    t.activities = [
      { Reasoning: { text: `the instruction says end with ${PLAN_DONE_MARKER} but I have no proposal yet`, at: 1, turn: 1 } },
      { Text: { text: '探索完成，发现需求不明确，需要澄清……', at: 2, turn: 1 } },
    ]
    expect(detectPlanCompletion(t)).toBe(false)
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

describe('D1.7 需求校准：验收标准提案检测与提取', () => {
  it('检测【验收标准完毕】标记', () => {
    const t = newTaskState('c1')
    t.activities = [
      { Text: { text: '验收标准：1) npm test 通过 2) 边界覆盖', at: 1, turn: 1 } },
      { Text: { text: `${CALIBRATE_DONE_MARKER}`, at: 2, turn: 1 } },
    ]
    expect(detectMarker(t, CALIBRATE_DONE_MARKER)).toBe(true)
    expect(detectPlanCompletion(t)).toBe(false) // 与 plan 标记互不干扰
  })

  it('提取提案只取 Text（Reasoning 不混入）且不含标记', () => {
    const t = newTaskState('c2')
    t.activities = [
      { Reasoning: { text: '让我想想怎么断言...', at: 1, turn: 1 } },
      { Text: { text: '## 验收标准\n- node -e "..." 通过\n- 空输入返回 400', at: 2, turn: 1 } },
      { Text: { text: `${CALIBRATE_DONE_MARKER}`, at: 3, turn: 1 } },
    ]
    const prop = extractMarkerText(t, CALIBRATE_DONE_MARKER)
    expect(prop).toContain('node -e')
    expect(prop).toContain('空输入')
    expect(prop).not.toContain('让我想想')
    expect(prop).not.toContain(CALIBRATE_DONE_MARKER)
  })

  it('plan 提取与 calibrate 提取互不干扰', () => {
    const t = newTaskState('c3')
    t.activities = [{ Text: { text: `计划 ${PLAN_DONE_MARKER} 验收 ${CALIBRATE_DONE_MARKER}`, at: 1, turn: 1 } }]
    expect(extractPlanText(t)).toContain('计划')
    expect(extractPlanText(t)).not.toContain('验收')
    expect(extractMarkerText(t, CALIBRATE_DONE_MARKER)).toContain('验收')
  })

  it('G4 回归：探索中间文本不污染提案（只取最后连续 Text 产出段）', () => {
    const t = newTaskState('c4')
    t.activities = [
      { Text: { text: '我先看看项目结构，了解一下现有代码……', at: 1, turn: 1 } },
      { ToolStart: { name: 'bash', at: 2, turn: 1 } },
      { Text: { text: '## 验收标准\n- node -e 断言通过\n- 边界覆盖', at: 3, turn: 2 } },
      { Text: { text: `${CALIBRATE_DONE_MARKER}`, at: 4, turn: 2 } },
    ]
    const prop = extractMarkerText(t, CALIBRATE_DONE_MARKER)
    expect(prop).toContain('node -e')
    expect(prop).not.toContain('项目结构') // 探索文本被 Tool 活动中断，不混入
  })

  it('G4 回归：标记在提案末尾（同一条 Text）也能提取', () => {
    const t = newTaskState('c5')
    t.activities = [
      { Text: { text: '探索中……', at: 1, turn: 1 } },
      { ToolStart: { name: 'read', at: 2, turn: 1 } },
      { Text: { text: `验收标准：npm test 通过 ${CALIBRATE_DONE_MARKER}`, at: 3, turn: 2 } },
    ]
    const prop = extractMarkerText(t, CALIBRATE_DONE_MARKER)
    expect(prop).toContain('npm test')
    expect(prop).not.toContain('探索中')
    expect(prop).not.toContain(CALIBRATE_DONE_MARKER)
  })
})
