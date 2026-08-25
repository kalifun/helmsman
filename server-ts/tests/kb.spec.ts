/**
 * M4 知识库测试：沉淀质量门槛 + 检索 + 实验聚合。
 */
import { describe, expect, it, vi } from 'vitest'
import { extractConclusion, assembleBrief, renderBriefPrompt, selectStableNotes } from '../src/assembly.ts'
import { deriveQueries, retrieve, retrieveHybrid, makeNote, detectCitedEntries, scoreNoteDebt, debtDemoteWeight, withStableTag } from '../src/kb.ts'
import { compareGroup, compareReport } from '../src/experiment.ts'
import type { MetricRow } from '../src/storage.ts'

describe('沉淀质量门槛（§6D/§6E）', () => {
  const base = {
    taskTitle: '测试任务',
    comments: [] as Array<{ who: string; text: string }>,
    turns: 1,
    status: 'Done' as const,
  }

  it('泛化总结不沉淀', () => {
    const r = extractConclusion({ ...base, activities: [{ Text: { text: '这个项目是一个天气卡片应用，功能完整，运行正常。' } }] })
    expect(r).toBeNull()
  })

  it('含文件名的具体结论沉淀', () => {
    const r = extractConclusion({ ...base, activities: [{ Text: { text: 'transfer.go 第 42 行的锁顺序与 handle.go 相反，按资源 ID 排序加锁可修复。' } }] })
    expect(r).not.toBeNull()
    expect(r!.content.length).toBeGreaterThan(0)
  })

  it('含色值/行号的具体结论沉淀', () => {
    const r = extractConclusion({ ...base, activities: [{ Text: { text: '.sun-scene（116 行）背景 #2b1b40。卡片兜底背景色 #141a30（第 86 行）。' } }] })
    expect(r).not.toBeNull()
  })

  it('失败任务不沉淀', () => {
    const r = extractConclusion({ ...base, status: 'Failed', activities: [{ Text: { text: 'transfer.go 第 42 行有 bug' } }] })
    expect(r).toBeNull()
  })
})

describe('检索', () => {
  const notes = [
    makeNote({ projectId: 'p', title: 'transfer.go 锁竞态', content: ['按资源 ID 排序加锁'], tags: ['并发'], keywords: ['transfer.go'], summary: '', sourceKind: 'human', sourceRef: 'x', trust: 'human-approved' }),
    makeNote({ projectId: 'p', title: 'weather 卡片', content: ['单文件应用'], tags: ['前端'], keywords: ['weather'], summary: '', sourceKind: 'human', sourceRef: 'y', trust: 'agent-generated' }),
  ]

  it('查询 transfer.go 命中锁竞态笔记', () => {
    const hits = retrieve(notes, deriveQueries('修复 transfer.go 锁竞态'))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].note.title).toContain('transfer.go')
  })

  it('无关查询不命中（低于阈值）', () => {
    const hits = retrieve(notes, deriveQueries('数据库连接池配置'))
    expect(hits.length).toBe(0)
  })

  it('债务降权后浅笔记排到后面', () => {
    const hits = retrieve(notes, deriveQueries('修 transfer.go 和 weather'), {
      demote: { [notes[1].id]: 0.3 },
    })
    expect(hits[0].note.title).toContain('transfer.go')
  })

  it('unused / toxic 权重为 0 时不再命中', () => {
    const hits = retrieve(notes, deriveQueries('修复 transfer.go 锁竞态'), {
      demote: { [notes[0].id]: 0 },
    })
    expect(hits.every((h) => h.note.id !== notes[0].id)).toBe(true)
  })
})

describe('知识债务', () => {
  it('工具参数命中文件名锚点 → 记引用', () => {
    const cited = detectCitedEntries(
      [{ id: 'n1', title: 'transfer.go 锁竞态', keywords: ['transfer.go'] }],
      'Read path=/repo/transfer.go offset=40',
    )
    expect(cited).toEqual(['n1'])
  })

  it('仅思考文本不算引用', () => {
    const cited = detectCitedEntries(
      [{ id: 'n1', title: 'transfer.go 锁竞态', keywords: ['transfer.go'] }],
      '',
    )
    expect(cited).toEqual([])
  })

  it('注入两次从未引用 → unused；引用后失败过半 → toxic', () => {
    const unused = scoreNoteDebt('n1', [
      { brief_snapshot: [{ id: 'n1' }], cited_entries: [], outcome: 'Done' },
      { brief_snapshot: [{ id: 'n1' }], cited_entries: [], outcome: 'Done' },
    ])
    expect(unused.status).toBe('unused')
    expect(debtDemoteWeight(unused.status)).toBe(0)

    const toxic = scoreNoteDebt('n1', [
      { brief_snapshot: [{ id: 'n1' }], cited_entries: ['n1'], outcome: 'Failed' },
      { brief_snapshot: [{ id: 'n1' }], cited_entries: ['n1'], outcome: 'Done', verified: false },
    ])
    expect(toxic.status).toBe('toxic')
    expect(debtDemoteWeight(toxic.status)).toBe(0)
  })
})

describe('装配', () => {
  it('简报命中进入 kbHits，渲染含稳定块', async () => {
    const notes = [makeNote({ projectId: 'p', title: 'transfer.go 锁竞态', content: ['按资源 ID 排序加锁'], tags: [], keywords: ['transfer.go'], summary: '', sourceKind: 'human', sourceRef: 'x', trust: 'human-approved' })]
    const brief = await assembleBrief({ taskTitle: '修 transfer.go', taskDescription: '', notes }, { embedNotes: async () => null })
    expect(brief.kbHits.length).toBeGreaterThan(0)
    const prompt = renderBriefPrompt(brief, [{ title: 'transfer.go 锁竞态', content: ['按资源 ID 排序加锁'] }])
    expect(prompt).toContain('项目稳定知识')
    expect(prompt).toContain('任务：修 transfer.go')
  })

  it('稳定块只收 #stable，不按信任级自动塞', () => {
    const approved = makeNote({ projectId: 'p', title: '旧实验结论', content: ['不该进每张卡'], tags: [], keywords: [], summary: '', sourceKind: 'human', sourceRef: 'x', trust: 'human-approved' })
    const pinned = makeNote({ projectId: 'p', title: '项目约定', content: ['用 pnpm'], tags: ['stable'], keywords: [], summary: '', sourceKind: 'human', sourceRef: 'y', trust: 'unverified' })
    expect(selectStableNotes([approved, pinned])).toEqual([{ title: '项目约定', content: ['用 pnpm'] }])
    expect(selectStableNotes([approved])).toEqual([])
    expect(selectStableNotes([{ ...approved, tags: withStableTag(approved.tags, true) }])).toEqual([
      { title: '旧实验结论', content: ['不该进每张卡'] },
    ])
  })

  it('前缀分区：同项目两任务稳定前缀一致', () => {
    const stable = [{ title: '知识A', content: ['事实1'] }]
    const b1 = renderBriefPrompt({ taskTitle: '任务1', taskDescription: '', kbHits: [{ id: 'a', title: 'a', score: 0.5, trust: 'human-approved' }] }, stable)
    const b2 = renderBriefPrompt({ taskTitle: '任务2', taskDescription: '', kbHits: [{ id: 'b', title: 'b', score: 0.5, trust: 'human-approved' }] }, stable)
    expect(b1.split('任务：')[0]).toBe(b2.split('任务：')[0])
  })
})

describe('实验聚合', () => {
  function metric(partial: Partial<MetricRow>): MetricRow {
    return {
      project_id: 'p', task_id: 't', brief_snapshot: [], outcome: 'Done', cited_entries: [],
      turns: 1, steps: 5, cost: 0.01, cache_hit: 0.5, in_tokens: 1000, cache_tokens: 5000,
      out_tokens: 500, reason_tokens: 200, created_at: 1, ...partial,
    }
  }

  it('验收通过率：只算有验收的任务', () => {
    const rows = [
      metric({ verified: true }),
      metric({ verified: false }),
      metric({}), // 无验收 → 不进分母
    ]
    const g = compareGroup(rows, 'A', 'A 组')
    expect(g.verifiedTasks).toBe(2)
    expect(g.verifyRate).toBe(0.5)
  })

  it('verdict：带装配验收更高 → 判定装配可能有效', () => {
    const a = [metric({ verified: true }), metric({ verified: true })]
    const b = [metric({ verified: false }), metric({ verified: false })]
    const r = compareReport(a, b)
    expect(r.verdict).toContain('装配可能有效')
  })

  it('成本拆分：cache 成本远低于全价输入', () => {
    const rows = [metric({ in_tokens: 1000, cache_tokens: 500000 })]
    const g = compareGroup(rows, 'A', 'A')
    // 500K cache token × 0.2元/M = 0.1；1K 全价 × 2元/M = 0.002
    expect(g.avgCacheCost).toBeGreaterThan(g.avgInputCost)
  })
})

describe('ACP 预设透传（P0 预设落地）', () => {
  it('sessionNew 带 preset → 请求含 _meta.agentPreset', async () => {
    // 用 Object.create 绕过构造函数（避免真实 spawn 子进程）
    const { AcpClient } = await import('../src/acp-client.ts')
    const callSpy = vi.fn(async () => ({ sessionId: 's1' }))
    const acp = Object.create(AcpClient.prototype) as InstanceType<typeof AcpClient>
    ;(acp as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call = callSpy
    ;(acp as unknown as { nextId: number }).nextId = 1
    await acp.sessionNew('/tmp/x', 'code-concise')
    const [, params] = callSpy.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(params).toMatchObject({ _meta: { agentPreset: 'code-concise' } })
    // 无 preset 时不带 _meta
    callSpy.mockClear()
    await acp.sessionNew('/tmp/x')
    const [, params2] = callSpy.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(params2._meta).toBeUndefined()
  })
})

describe('混合检索（P2 向量：规则 + 语义融合）', () => {
  const N = (id: string, title: string, content: string[] = []): ReturnType<typeof makeNote> =>
    ({ ...makeNote({ projectId: 'p', title, content, tags: [], keywords: [], summary: '', sourceKind: 'human', sourceRef: 'x', trust: 'human-approved' }), id })

  it('语义通道：词未命中但语义相关也能召回（fake embedder）', async () => {
    const notes = [
      N('n1', '冷链乳制品安全校验', ['冷链路运输中必须验证乳制品温度']),
      N('n2', '登录页表单校验', ['邮箱和密码非空校验']),
    ]
    // fake embedder：手工向量，query 与 n1 语义近、与 n2 远
    const embedNotes = async (ns: typeof notes) => ns.map((n) => {
      const v = new Float32Array(4)
      v[0] = 1
      v[1] = n.title.includes('冷链') || n.content.join('').includes('冷链路') ? 1 : 0
      v[2] = n.title.includes('登录') ? 1 : 0
      return v
    })
    const embedQuery = async () => { const v = new Float32Array(4); v[0] = 1; v[1] = 1; return [v] }
    const hits = await retrieveHybrid(notes, deriveQueries('cold chain dairy verification'), 'cold chain dairy verification', { limit: 5, embedNotes, embedQuery })
    // 语义上 n1（冷链）应该排在最前，即使关键词 'cold chain' 完全没命中中文笔记
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].note.id).toBe('n1')
  })

  it('embedder 不可用（返回 null）→ 降级纯规则，不抛错', async () => {
    const notes = [N('n1', 'transfer.go 锁竞态', ['按资源 ID 排序加锁'])]
    const hits = await retrieveHybrid(notes, deriveQueries('修 transfer.go'), '修 transfer.go', { limit: 5, embedNotes: async () => null })
    expect(hits.length).toBeGreaterThan(0) // 规则通道仍命中
    expect(hits[0].note.id).toBe('n1')
  })

  it('规则命中条目融合语义分：命中且相关 > 命中但无关', async () => {
    const notes = [
      N('n1', 'transfer.go 锁竞态', ['transfer.go 里按资源 ID 排序加锁']),
      N('n2', 'transfer.go 迁移', ['transfer.go 里的表结构迁移脚本']),
    ]
    // query 与 n1 语义更近
    const embedNotes = async (ns: typeof notes) => ns.map((n) => {
      const v = new Float32Array(4)
      v[0] = 1
      v[1] = n.title.includes('锁') || n.content.join('').includes('锁') ? 1 : 0
      return v
    })
    const embedQuery = async () => { const v = new Float32Array(4); v[0] = 1; v[1] = 1; return [v] }
    const hits = await retrieveHybrid(notes, deriveQueries('修 transfer.go 的锁'), '修 transfer.go 的锁', { limit: 5, embedNotes, embedQuery })
    expect(hits[0].note.id).toBe('n1')
  })
})
