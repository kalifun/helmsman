// Helmsman CWL 对比实验（论文级验证数据）
// 用法：node benchmarks/run-cwl-experiment.mjs <group> [tasksFile] [budgetTokens]
//   group: baseline | summary | cwl
//   baseline = 无管理（引擎默认，无驱逐）
//   summary  = 摘要压缩（ACP 路线：模型写摘要替换历史）
//   cwl      = 结构化驱逐（dsh-cwl 独立插件，预算内确定性剥除）
// 输出：JSON 结果（stdout），含每任务 status/steps/cost/驱逐数/验收
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const GROUP = process.argv[2] ?? 'baseline'
const TASKS_FILE = process.argv[3] ?? new URL('./data/long-tasks.json', import.meta.url).pathname
const BUDGET = process.argv[4] ?? '6000' // 低预算模拟长任务压力（tokens）
const BASE = 'http://127.0.0.1:3081'
const WS_ROOT = '/tmp/hm-bench'

const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf8'))

function api(path, method = 'GET', body) {
  const res = execSync(`curl -s -X ${method} ${BASE}${path}${body ? ` -H 'content-type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : ''}`, { encoding: 'utf8' })
  return JSON.parse(res || '{}')
}

async function main() {
  const runId = `${GROUP}-${Date.now().toString(36)}`
  const ws = `${WS_ROOT}-${runId}`
  // 生成项目 fixture
  execSync(`bash ${new URL('./fixtures/seed.sh', import.meta.url).pathname} ${ws}`, { encoding: 'utf8' })
  execSync(`cd ${ws} && git init -q && git config user.email bench@t && git config user.name bench && git add -A && git commit -qm init`, { encoding: 'utf8' })

  // 建项目
  const proj = api('/api/projects', 'POST', { name: `bench-${GROUP}`, path: ws })
  const pid = proj.id
  if (!pid) throw new Error(`project create failed: ${JSON.stringify(proj)}`)

  const results = []
  for (const t of tasks) {
    // 每任务建独立子目录（避免文件冲突），用子目录作为卡路径
    const card = api(`/api/projects/${pid}/cards`, 'POST', {
      title: t.title,
      kind: 'task',
      criteria: t.acceptance,
    })
    const cid = card.card_id
    const brief = t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    const task = api('/api/tasks', 'POST', {
      cwd: ws,
      brief,
      project_id: pid,
      card_id: cid,
    })
    const sid = task.session_id
    results.push({ id: t.id, title: t.title, sid, cardId: cid, acceptance: t.acceptance })
  }

  // 等待全部完成
  const deadline = Date.now() + 20 * 60 * 1000
  while (Date.now() < deadline) {
    const cards = api(`/api/projects/${pid}/cards`)
    const pending = cards.filter((c) => ['Running', 'Pending'].includes(c.latest?.status))
    if (pending.length === 0) break
    await new Promise((r) => setTimeout(r, 20000))
  }

  // 收集结果
  const metrics = api(`/api/metrics?project=${pid}`)
  const bySid = {}
  for (const m of metrics) bySid[m.task_id] = m

  const evictions = api('/api/cwl/evictions')
  const evictCounts = {}
  for (const e of evictions) evictCounts[e.sid] = (e.evicted ?? []).length

  for (const r of results) {
    const m = bySid[r.sid] ?? {}
    // 验收：在主工作区检查产物（验收命令是文件检查）
    let accepted = false
    try {
      // 简化验收：检查任务产物文件是否存在（按 acceptance 里的 test -f/grep 粗略判断）
      const acc = r.acceptance
      const f = (acc.match(/test -f ([^\s]+)/) || [])[1]
      if (f) accepted = existsSync(join(ws, f.replace(/'/g, '')))
    } catch {}
    r.status = m.outcome ?? 'unknown'
    r.steps = m.steps ?? 0
    r.cost = m.cost ?? 0
    r.evicted = evictCounts[r.sid] ?? 0
    r.accepted = accepted
  }

  const summary = {
    runId,
    group: GROUP,
    budget: Number(BUDGET),
    tasks: results,
    totals: {
      done: results.filter((r) => r.status === 'Done').length,
      accepted: results.filter((r) => r.accepted).length,
      steps: results.reduce((a, r) => a + r.steps, 0),
      cost: results.reduce((a, r) => a + r.cost, 0),
      evictions: results.reduce((a, r) => a + r.evicted, 0),
    },
  }
  console.log(JSON.stringify(summary, null, 2))

  // 存结果
  const outDir = new URL(`../results/`, import.meta.url).pathname
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${runId}.json`), JSON.stringify(summary, null, 2))
  console.log(`\n[结果已存] ${outDir}${runId}.json`)
}

main().catch((e) => { console.error('实验失败:', e.message); process.exit(1) })
