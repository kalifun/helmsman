// dsh-cwl 纯函数单元测试：node check.js
import assert from 'node:assert/strict'
import { deriveEpisodes, pickEvictionTarget } from './lib.js'

// --- deriveEpisodes：阶段合并 + 依赖推断 ---
const events = [
  // expl：read a.js + grep（连续探索 → 合并为 expl-1）
  { type: 'assistant/message', seq: 100, data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{"file_path":"/a/b.js"}' }] } } },
  { type: 'tool/result', seq: 101, data: {} },
  { type: 'assistant/message', seq: 102, data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{"file_path":"/a/c.js"}' }, { type: 'tool-call', name: 'grep', arguments: '{"pattern":"TODO"}' }] } } },
  { type: 'tool/result', seq: 103, data: {} },
  { type: 'tool/result', seq: 104, data: {} },
  // act：bash 写 b.js（触碰 /a/b.js → 依赖 expl-1）
  { type: 'assistant/message', seq: 105, data: { message: { content: [{ type: 'tool-call', name: 'bash', arguments: '{"command":"echo x >> /a/b.js"}' }] } } },
  { type: 'tool/result', seq: 106, data: {} },
  // expl：读 b.md（无依赖）
  { type: 'assistant/message', seq: 107, data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{"file_path":"/a/b.md"}' }] } } },
  { type: 'tool/result', seq: 108, data: {} },
]

const eps = deriveEpisodes(events)
const expls = eps.filter((e) => e.type === 'expl')
const acts = eps.filter((e) => e.type === 'act')

// 阶段合并：2 expl + 1 act
assert.equal(expls.length, 2, 'should merge consecutive expl batches')
assert.equal(acts.length, 1, 'should have one act episode')
assert.equal(expls[0].toolNames.join(','), 'read,read,grep', 'expl-1 should contain merged tools')
// 依赖：act-1 触碰 /a/b.js（expl-1 读过）
assert.deepEqual(acts[0].deps, ['expl-1'], 'act should depend on expl that read its touched file')

// --- pickEvictionTarget：依赖保护 + 最新尾巴保护 ---
const surface = [100, 101, 102, 103, 104, 105, 106, 107, 108]
// newestAllowed = 105（保留最新 2 个节点 107,108）→ expl-2（107-108）被保护
// expl-1 被 act-1 依赖 → 保护；act-1（105-106）可驱逐
const t1 = pickEvictionTarget(events, surface, 106)
assert.equal(t1?.label, 'act-1', 'should pick act-1 (expl-1 depended, expl-2 end=108 > 106 protected)')

// 放宽最新尾巴 → expl-2 可驱逐（优先 expl）
const t2 = pickEvictionTarget(events, surface, 108)
assert.equal(t2?.type, 'expl', 'should prefer expl when available')

// 已遮蔽段排除
const t3 = pickEvictionTarget(events, [100, 101, 107, 108], 108)
assert.notEqual(t3?.label, 'act-1', 'evicted act-1 should not be re-picked')

console.log('✓ dsh-cwl 纯函数检查通过：episode 合并 / 依赖推断 / 分级选择 / 遮蔽排除')
