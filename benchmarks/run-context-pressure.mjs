// 对话累积压力测试：同一会话连续多轮，观察上下文增长与 CWL 驱逐
// 用法：node benchmarks/run-context-pressure.mjs [group] [rounds]
//   group: baseline（无驱逐）| cwl（分级驱逐）
//   rounds: 对话轮数（默认 12）
// 输出：每轮 token 用量 + 驱逐次数 + 最终状态
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const GROUP = process.argv[2] ?? 'cwl'
const ROUNDS = Number(process.argv[3] ?? 12)
const BASE = 'http://127.0.0.1:3081'
const WS = '/tmp/hm-pressure'

function api(path, method = 'GET', body) {
  const cmd = `curl -s -X ${method} ${BASE}${path}${body ? ` -H 'content-type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : ''}`
  return JSON.parse(execSync(cmd, { encoding: 'utf8' }) || '{}')
}

async function main() {
  const ws = `${WS}-${GROUP}-${Date.now().toString(36)}`
  execSync(`bash ${join(process.cwd(), 'benchmarks/fixtures/seed.sh')} ${ws}`)
  execSync(`cd ${ws} && git init -q && git config user.email p@t && git config user.name p && git add -A && git commit -qm init`)
  const proj = api('/api/projects', 'POST', { name: `pressure-${GROUP}`, path: ws })
  const pid = proj.id
  // 建简单会话（chat，不走卡执行；POST /api/projects/:pid/chats）
  const chat = api(`/api/projects/${pid}/chats`, 'POST') ?? {}
  const sid = chat.session_id ?? chat.sid ?? chat.id
  if (!sid) { console.error('chat create failed:', JSON.stringify(chat)); process.exit(1) }

  const rows = []
  for (let i = 1; i <= ROUNDS; i++) {
    // 每轮发消息让 agent 读文件+写小改动（产生上下文）
    const msg = `第${i}轮：读取 data/items.json，把第${(i % 3) + 1}条的价格加 ${i} 写到 data/round-${i}.txt，并简述当前进度。`
    // POST /api/chats/:sid 异步发消息 → 轮询 GET 等该轮完成
    api(`/api/chats/${sid}`, 'POST', { text: msg })
    const deadline = Date.now() + 180000
    let st = api(`/api/chats/${sid}`)
    while (Date.now() < deadline && ['Running', 'Pending'].includes(st?.status)) {
      await new Promise((r) => setTimeout(r, 10000))
      st = api(`/api/chats/${sid}`)
    }
    rows.push({
      round: i,
      status: st.status ?? '?',
      tokens: (st.usage?.inputTokens ?? 0) + (st.usage?.outputTokens ?? 0) + (st.usage?.cacheReadTokens ?? 0),
      steps: st.steps ?? 0,
      cost: st.cost ?? 0,
    })
    console.log(`轮${i}: status=${rows[i-1].status} tokens≈${rows[i-1].tokens} steps=${rows[i-1].steps}`)
  }

  // 驱逐统计
  const evictions = api('/api/cwl/evictions')
  const ev = evictions.filter((e) => e.sid === sid).flatMap((e) => e.evicted ?? [])
  // 会话最终完整 usage（真实对比指标：input/cacheRead/output/reasoning）
  const final = api(`/api/chats/${sid}`)
  const summary = {
    group: GROUP, rounds: ROUNDS, ws,
    rows,
    evictions: ev.length,
    totalTokens: rows.reduce((a, r) => a + r.tokens, 0),
    finalStatus: rows[rows.length - 1]?.status,
    finalUsage: final?.usage ?? null,
    finalSteps: final?.steps ?? null,
    finalTurns: final?.turns ?? null,
  }
  console.log(JSON.stringify(summary, null, 2))
  const outDir = join(process.cwd(), 'results')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `pressure-${GROUP}-${Date.now().toString(36)}.json`), JSON.stringify(summary, null, 2))
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
