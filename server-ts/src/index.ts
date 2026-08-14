/**
 * Helmsman TS 产品服务（M3 正片等价物）——照 crates/service/src/main.rs 翻译。
 * 常驻进程：spawn dsh（一次）→ ACP 控制 → JSONL 观察（tailer → 投影 + WS 广播）
 * → HTTP/WS（projects/cards/tasks/fs/events）→ 前端 web/ 直接对接。
 * 接口 = Rust 版终版契约（web/src/api/client.ts 是第一个消费者）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readdirSync, renameSync, rmSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import { startEngine } from './engine.ts'
import { Storage } from './storage.ts'
import {
  newProjection,
  ensureProject,
  ensureCard,
  registerSession,
  finishSession,
  removeProject,
  foldTask,
  detectPlanCompletion,
  extractPlanText,
  type CardMeta,
  type CardState,
  type Project,
} from './projection.ts'
import { startTailer } from './observe/tail.ts'
import { recoverStore } from './recovery.ts'
import { retrieve, deriveQueries, makeNote } from './kb.ts'
import { assembleBrief, renderBriefPrompt, extractConclusion, type Brief } from './assembly.ts'
import { compareReport } from './experiment.ts'
import { runAcceptance } from './verify.ts'

const PORT = Number(process.env.HELMSMAN_PORT ?? 3081)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..') // server-ts/src/.. = repo 根
const SESSIONS_ROOT = process.env.HELMSMAN_SESSIONS_ROOT ?? join(REPO, 'dsh/.sessions')
const ARCHIVE_ROOT = join(dirname(SESSIONS_ROOT), '.sessions-archive')
const DB_PATH = process.env.HELMSMAN_DB ?? join(REPO, 'helmsman.db')
const WORKSPACE = process.cwd()

let CARD_SEQ = 0
const genCardId = (): string => `card-${Date.now()}-${CARD_SEQ++}`
const nowMs = (): number => Date.now()

// ---------- 会话目录匹配（照 main.rs） ----------

const sessionDirKey = (cwd: string): string => `--${cwd.replace(/\/+$/, '').replace(/\//g, '-')}--`

function sessionCwd(dir: string): string | undefined {
  try {
    const line = readFirstLine(join(dir, 'session.jsonl'))
    if (!line) return undefined
    const v = JSON.parse(line) as { cwd?: string }
    return typeof v.cwd === 'string' ? v.cwd.replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

function readFirstLine(file: string): string | undefined {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(65536)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const s = buf.subarray(0, n).toString('utf8')
    const i = s.indexOf('\n')
    return i >= 0 ? s.slice(0, i).trim() : s.trim()
  } finally {
    closeSync(fd)
  }
}

function findSessionDirs(root: string, cwd: string): string[] {
  const norm = cwd.replace(/\/+$/, '')
  const key = sessionDirKey(norm)
  const out: string[] = []
  let entries: Array<{ name: string; isDir: boolean }> = []
  try {
    entries = readdirSync(root, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDir) continue
    const p = join(root, e.name)
    const c = sessionCwd(p)
    if (c === norm) {
      out.push(p)
      continue
    }
    if (e.name.startsWith(key)) out.push(p)
  }
  return out
}

function archiveSessionDirs(cwd: string): number {
  try {
    mkdirSync(ARCHIVE_ROOT, { recursive: true })
  } catch {
    return 0
  }
  let n = 0
  for (const d of findSessionDirs(SESSIONS_ROOT, cwd)) {
    try {
      renameSync(d, join(ARCHIVE_ROOT, basename(d)))
      n += 1
    } catch {
      /* ignore */
    }
  }
  return n
}

function purgeSessionDirs(cwd: string): number {
  let n = 0
  for (const d of findSessionDirs(SESSIONS_ROOT, cwd)) {
    try {
      rmSync(d, { recursive: true, force: true })
      n += 1
    } catch {
      /* ignore */
    }
  }
  return n
}

function restoreSessionDirs(cwd: string): number {
  let n = 0
  for (const d of findSessionDirs(ARCHIVE_ROOT, cwd)) {
    try {
      renameSync(d, join(SESSIONS_ROOT, basename(d)))
      n += 1
    } catch {
      /* ignore */
    }
  }
  return n
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  const engine = await startEngine({ sessionsRoot: SESSIONS_ROOT, workspace: WORKSPACE })
  const storage = new Storage(DB_PATH)
  const proj = newProjection()
  const cardOfSession = new Map<string, { projectId: string; meta: CardMeta; executionCreatedAt: number }>()

  // 启动：灌持久化项目元数据
  for (const m of storage.loadProjects()) ensureProject(proj, m.id, m.name, m.path)

  // 种子项目（当前工作区）：仅首次自动注册；用户 purge/归档后不再自动回来。
  const seedHelmsman = !storage.projectExists('helmsman') && !storage.isDeleted('helmsman')
  if (seedHelmsman) {
    ensureProject(proj, 'helmsman', 'helmsman', WORKSPACE)
    storage.upsertProject('helmsman', 'helmsman', WORKSPACE, '{}')
  }

  // 恢复：从 SQLite 构建 session → 卡映射
  for (const card of storage.loadAllCards()) {
    for (const ex of storage.loadExecutions(card.id)) {
      cardOfSession.set(ex.id, {
        projectId: card.project_id,
        meta: {
          id: card.id,
          title: card.title,
          description: card.description,
          kind: card.kind,
          milestone: card.milestone,
          criteria: card.criteria,
          created_at: card.created_at,
        },
        executionCreatedAt: ex.created_at,
      })
    }
  }

  const { restored, offsets } = recoverStore(SESSIONS_ROOT, proj, seedHelmsman ? ['helmsman', WORKSPACE] : null, cardOfSession)
  // 恢复的卡/执行写快照（重放即权威投影；隐式卡借此落库）
  for (const [pid, p] of Object.entries(proj.projects)) {
    // 兜底：恢复出的项目若不在 SQLite（旧日志 cwd 项目），先注册（FK 依赖）
    if (!storage.projectExists(pid)) storage.upsertProject(pid, p.name, p.path, '{}')
    for (const [cardId, c] of Object.entries(p.cards)) {
      storage.upsertCard({
        id: cardId,
        project_id: pid,
        title: c.title,
        description: c.description,
        kind: c.kind,
        milestone: c.milestone,
        criteria: null,
        created_at: c.created_at,
      })
      for (const [sid, t] of Object.entries(c.executions)) {
        if (storage.getExecutionBySession(sid)) continue
        storage.upsertExecution({
          id: sid,
          card_id: cardId,
          status: t.status,
          preset_json: '{}',
          deps_json: '[]',
          forked_from: null,
          started_at: t.started_at ?? null,
          finished_at: t.finished_at ?? null,
          created_at: c.created_at,
        })
      }
    }
  }
  console.log(`[recover] restored ${restored} sessions from logs`)

  // 既有项目补种子 Profile（老库无 profiles 表数据时）
  for (const pid of Object.keys(proj.projects)) storage.seedProfiles(pid)

  // 观察通道：tailer → fold + WS 广播（wsClients/broadcast 在 HTTP/WS 节定义）
  startTailer(SESSIONS_ROOT, offsets, (te) => {
    // fold 到投影（按 session 路由）
    const cardId = proj.sessionCard[te.sessionId]
    const pid = proj.sessionProject[te.sessionId]
    if (cardId && pid) {
      const card = proj.projects[pid]?.cards[cardId]
      const t = card?.executions[te.sessionId]
      if (t) {
        foldTask(t, te.event)
        broadcast(te.event)
      }
    }
  })

  // ---------- HTTP/WS ----------
  const server = createServer((req, res) => {
    void handle(req, res)
  })

  // 最小 WebSocket 服务端：握手 + 文本帧发送（服务端 → 客户端单向，够事件广播用）。
  // wsClients: ws 存 socket（帧直写 socket，绕过 http 层）；sse 存 res。
  const wsClients = new Map<import('node:net').Socket | import('node:http').ServerResponse, 'ws' | 'sse'>()
  const broadcast = (ev: Record<string, unknown>): void => {
    const text = JSON.stringify(ev)
    for (const [target, kind] of wsClients) {
      try {
        if (kind === 'ws') (target as import('node:net').Socket).write(wsTextFrame(text))
        else (target as import('node:http').ServerResponse).write(`data: ${text}\n\n`)
      } catch {
        wsClients.delete(target)
      }
    }
  }

  const acp = engine.acp

  // 执行启动共路：session_new → 注册到卡 → 快照 Pending → 后台跑
  // brief=true 装配知识库简报；false = 裸跑（对照实验 B 组）；presetId 按 dsh preset 组装；presetSnapshot 落快照
  async function startExecution(
    projectId: string,
    cardId: string,
    forkedFrom: string | null,
    opts: { brief?: boolean; groupTag?: string; criteria?: string | null; presetId?: string | null; presetSnapshot?: string | null } = {},
  ): Promise<string> {
    const p = proj.projects[projectId]
    const c = p?.cards[cardId]
    if (!p || !c) throw new HttpError(404, `card '${cardId}' not found`)
    const sid = await acp.sessionNew(p.path, opts.presetId ?? undefined)
    registerSession(proj, sid, projectId, cardId)
    // 预设快照进投影（§2.6：执行契约，随任务生命周期延续，前端可见）
    if (opts.presetSnapshot) {
      try {
        const snap = JSON.parse(opts.presetSnapshot) as { id: string; name: string; mode: string; setting: string; approval: string; sandbox: string }
        const t = proj.projects[projectId]?.cards[cardId]?.executions[sid]
        if (t) t.preset = snap
      } catch { /* 忽略坏快照 */ }
    }
    const created = nowMs()
    storage.upsertExecution({
      id: sid,
      card_id: cardId,
      status: 'Pending',
      preset_json: opts.presetSnapshot ?? '{}',
      deps_json: '[]',
      forked_from: forkedFrom,
      started_at: null,
      finished_at: null,
      created_at: created,
    })
    // 简报装配（M4 §4）：任务定义 + 知识库命中 → 首条 prompt；裸跑则只有任务定义
    // 前缀分区（§6 路径 2）：项目稳定知识块（human-approved，固定跨任务）→ 缓存命中 + 知识可用
    let brief: Brief = { taskTitle: c.title, taskDescription: c.description, kbHits: [] }
    const stableNotes: Array<{ title: string; content: string[] }> = []
    if (opts.brief !== false) {
      const notes = storage.listNotes(projectId)
      // 稳定块 = 信任级最高的条目（human-approved > agent-generated > unverified），跨任务固定 → 稳定前缀
      const trustRank = { 'human-approved': 3, 'agent-generated': 2, unverified: 1 } as const
      const ranked = [...notes].sort((a, b) => (trustRank[b.trust] ?? 0) - (trustRank[a.trust] ?? 0))
      for (const n of ranked) {
        if (stableNotes.length < 5) {
          stableNotes.push({ title: n.title, content: n.content })
        }
      }
      brief = assembleBrief({
        taskTitle: c.title,
        taskDescription: c.description,
        notes,
      })
    }
    const prompt = opts.brief === false
      ? `${c.title}\n\n${c.description}`.trim()
      : renderBriefPrompt(brief, stableNotes)
    // 阶段 2：三轴驱动行为（§2.5）—— 解析 preset 快照
    let presetMode: 'normal' | 'plan' | 'goal' = 'normal'
    let presetSetting: 'light' | 'balanced' | 'delivery' = 'balanced'
    let presetApproval: 'ask' | 'auto' | 'yolo' = 'ask'
    if (opts.presetSnapshot) {
      try {
        const snap = JSON.parse(opts.presetSnapshot) as { mode?: string; setting?: string; approval?: string }
        if (snap.mode === 'plan' || snap.mode === 'goal') presetMode = snap.mode
        if (snap.setting === 'light' || snap.setting === 'delivery') presetSetting = snap.setting
        if (snap.approval === 'auto' || snap.approval === 'yolo') presetApproval = snap.approval
      } catch { /* 快照解析失败按默认 */ }
    }
    // plan 模式：注入"先产计划"指令（计划 = 提交物，批复后才执行，§2.1）
    let finalPrompt = prompt
    if (presetMode === 'plan') {
      finalPrompt = `${prompt}\n\n【协作方式：计划模式】请先产出一份计划（步骤/涉及文件/风险），
用一行 "【计划完毕】" 结尾。产出计划后停下等待批复，不要开始执行。`
    }
    const groupTag = opts.groupTag
    void acp
      .sessionPrompt(sid, finalPrompt)
      .then(async (stopReason) => {
        const at = nowMs()
        finishSession(proj, sid, stopReason, at)
        const t = proj.projects[proj.sessionProject[sid]]?.cards[proj.sessionCard[sid]]?.executions[sid]
        if (t) {
          storage.upsertExecution({
            id: sid,
            card_id: cardId,
            status: t.status,
            preset_json: opts.presetSnapshot ?? '{}',
            deps_json: '[]',
            forked_from: forkedFrom,
            started_at: t.started_at ?? null,
            finished_at: t.finished_at ?? null,
            created_at: created,
          })
          // 阶段 2 · plan 模式：检测 agent 是否产出计划（【计划完毕】标记）→ 挂 Waiting{plan} 等批复
          if (presetMode === 'plan' && t.status === 'Done' && t.waiting === null && detectPlanCompletion(t)) {
              const planText = extractPlanText(t)
              t.waiting = {
                kind: 'plan',
                reason: `计划模式：agent 已产出计划（见计划内容），请审阅后批准执行或要求修改`,
                payload: { mode: 'plan', plan: planText },
              }
              // 计划等待不是终态——重置为 Running（等待批复中），批准后继续执行
              t.status = 'Running'
              storage.upsertExecution({
                id: sid,
                card_id: cardId,
                status: 'Running',
                preset_json: opts.presetSnapshot ?? '{}',
                deps_json: '[]',
                forked_from: forkedFrom,
                started_at: t.started_at ?? null,
                finished_at: null,
                created_at: created,
              })
              storage.insertApproval({
                id: 0,
                project_id: projectId,
                execution_id: sid,
                kind: 'plan',
                payload: { mode: 'plan', plan: planText },
                reason: '计划模式：agent 已产出计划，请审阅',
                outcome: null,
                comment: null,
                created_at: at,
                decided_at: null,
                suspended_at: null,
              })
              // 计划已产出 → 跳过知识沉淀与验收（执行尚未发生）
              return
            }
          // 知识沉淀（M4 §3.3）：Done 且 agent 有结论 → agent-generated 入库（裸跑对照组不沉淀，防 KB 污染）
          if (opts.brief !== false) {
            const conclusion = extractConclusion({
              taskTitle: c.title,
              comments: t.comments.map((cm) => ({ who: cm.who, text: cm.text })),
              activities: t.activities,
              turns: t.turns,
              status: t.status,
            })
            if (conclusion) {
              const note = makeNote({
                projectId,
                title: conclusion.title,
                content: conclusion.content,
                tags: ['auto'],
                keywords: conclusion.keywords,
                summary: conclusion.summary,
                sourceKind: 'task',
                sourceRef: cardId,
                trust: 'agent-generated',
              })
              storage.upsertNote(note)
            }
          }
          // 验收门（§3.3）：任务 Done 且有验收标准 → 独立执行验收（不信任 agent 自评）
          let verified: boolean | undefined
          if (t.status === 'Done' && opts.criteria) {
            const vr = await runAcceptance(p.path, opts.criteria)
            verified = vr.verified ?? undefined
            if (vr.error) console.error(`[verify] ${sid}: ${vr.error}`)
          }
          // 阶段 2 · delivery 设定：强制验收门 —— Done 但无验收标准 → 挂 Waiting{acceptance}
          // （§2.2 交付档：强制验收清单缺失阻止；§3 验收门基于外部信号）
          if (presetSetting === 'delivery' && t.status === 'Done' && t.waiting === null && !opts.criteria) {
            t.waiting = { kind: 'acceptance', reason: '交付设定：任务完成，请验收（通过则 merge 知识，打回则重做）', payload: { setting: 'delivery' } }
            storage.insertApproval({
              id: 0,
              project_id: projectId,
              execution_id: sid,
              kind: 'acceptance',
              payload: { setting: 'delivery' },
              reason: '交付设定：任务完成，请验收',
              outcome: null,
              comment: null,
              created_at: at,
              decided_at: null,
              suspended_at: null,
            })
          }
          // 度量闭环（M4 §5.2）：简报命中清单 + 回合数 + 成本 + 验收 + 实验组落库
          const u = t.usage
          const cost =
            (u.inputTokens / 1e6) * 2.0 +
            (u.outputTokens / 1e6) * 8.0 +
            (u.cacheReadTokens / 1e6) * 0.2 +
            (u.reasoningTokens / 1e6) * 8.0
          const cacheHit = u.inputTokens + u.cacheReadTokens > 0
            ? u.cacheReadTokens / (u.inputTokens + u.cacheReadTokens)
            : 0
          storage.insertMetric({
            project_id: projectId,
            task_id: sid,
            brief_snapshot: brief.kbHits.map((h) => ({ id: h.id, title: h.title, score: h.score })),
            outcome: t.status,
            cited_entries: [],
            turns: t.turns,
            steps: t.steps,
            group_tag: groupTag,
            verified,
            cost: Math.round(cost * 10000) / 10000,
            cache_hit: Math.round(cacheHit * 10000) / 10000,
            in_tokens: u.inputTokens,
            cache_tokens: u.cacheReadTokens,
            out_tokens: u.outputTokens,
            reason_tokens: u.reasoningTokens,
            created_at: at,
          })
        }
      })
      .catch((err) => {
        finishSession(proj, sid, 'error', nowMs())
        console.error(`[task] ${sid} failed:`, err)
      })
    return sid
  }

  class HttpError extends Error {
    constructor(public status: number, message: string) {
      super(message)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method ?? 'GET'
    const send = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    const readBody = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? (JSON.parse(text) as Record<string, unknown>) : {}
    }
    try {
      // WS 握手（/api/events）—— 保持连接，不发 end()；之后只写帧。
      if (path === '/api/events' && (req.headers.upgrade ?? '').toLowerCase() === 'websocket') {
        const key = req.headers['sec-websocket-key']
        if (key) {
          const accept = createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64')
          res.writeHead(101, {
            Upgrade: 'websocket',
            Connection: 'Upgrade',
            'Sec-WebSocket-Accept': accept,
          })
          res.flushHeaders()
          const socket = req.socket
          wsClients.set(socket, 'ws')
          socket.on('close', () => wsClients.delete(socket))
          return
        }
      }
      // SSE 兜底（同路由，EventSource 用）
      if (path === '/api/events' && method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        wsClients.set(res, 'sse')
        req.on('close', () => wsClients.delete(res))
        return
      }

      // ---------- 项目 ----------
      if (method === 'GET' && path === '/api/projects') {
        const out = Object.entries(proj.projects)
          .map(([id, p]) => ({ id, name: p.name, path: p.path, card_count: Object.keys(p.cards).length, counts: cardStatusCounts(p) }))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
        send(200, out)
        return
      }
      if (method === 'POST' && path === '/api/projects') {
        const body = await readBody()
        const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
        if (!rawPath) throw new HttpError(400, 'empty path')
        const pathNorm = rawPath.replace(/\/+$/, '')
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : basename(pathNorm) || pathNorm
        const base = basename(pathNorm) || pathNorm
        const id = (base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').split('-').filter(Boolean).join('-')) || 'project'
        // 仅移除可恢复：重新导入同目录 → 移回归档会话 + 取消归档 + 立即恢复
        const archived = storage.findArchivedProject(pathNorm)
        let isRestored = false
        if (archived) {
          restoreSessionDirs(pathNorm)
          storage.unarchiveProject(archived.id)
          isRestored = true
        }
        const projectId = archived?.id ?? id
        ensureProject(proj, projectId, name, pathNorm)
        storage.upsertProject(projectId, name, pathNorm, '{}')
        storage.seedProfiles(projectId) // 种子内置 4 个 Profile（首个 = 项目默认，§2.6）
        const p = proj.projects[projectId]
        send(201, { id: p.id, name: p.name, path: p.path, card_count: Object.keys(p.cards).length, restored: isRestored })
        return
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/)
      if (projectMatch && method === 'DELETE') {
        const pid = decodeURIComponent(projectMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, `project '${pid}' not found`)
        const body = await readBody()
        const mode = body.mode === 'purge' ? 'purge' : 'archive'
        const removedSessions = mode === 'purge' ? purgeSessionDirs(p.path) : archiveSessionDirs(p.path)
        removeProject(proj, pid)
        if (mode === 'purge') {
          storage.purgeProject(pid)
          storage.markDeleted(pid)
        } else {
          storage.archiveProject(pid)
        }
        send(200, { ok: true, mode, sessions: removedSessions })
        return
      }
      if (projectMatch && method === 'GET') {
        const pid = decodeURIComponent(projectMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, 'project not found')
        send(200, { id: p.id, name: p.name, path: p.path, cards: p.cards })
        return
      }

      // ---------- 卡 ----------
      const cardsMatch = path.match(/^\/api\/projects\/([^/]+)\/cards$/)
      if (cardsMatch && method === 'GET') {
        const pid = decodeURIComponent(cardsMatch[1])
        const p = proj.projects[pid]
        if (!p) throw new HttpError(404, 'project not found')
        const out = Object.entries(p.cards)
          .map(([id, c]) => {
            const latest = latestExecution(c)
            return {
              id,
              title: c.title,
              description: c.description,
              kind: c.kind,
              milestone: c.milestone,
              execution_count: c.exec_order.length,
              created_at: c.created_at,
              latest: latest
                ? { session_id: latest.id, status: latest.status, started_at: latest.started_at ?? null, finished_at: latest.finished_at ?? null }
                : null,
            }
          })
          .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
        send(200, out)
        return
      }
      if (cardsMatch && method === 'POST') {
        const pid = decodeURIComponent(cardsMatch[1])
        const body = await readBody()
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (!title) throw new HttpError(400, 'empty title')
        if (!proj.projects[pid]) throw new HttpError(404, `project '${pid}' not found; create it via POST /api/projects first`)
        const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'task'
        const cardId = genCardId()
        const created = nowMs()
        const criteria = typeof body.acceptance === 'string' && body.acceptance.trim() ? body.acceptance.trim() : null
        const meta: CardMeta = {
          id: cardId,
          title,
          description: typeof body.description === 'string' ? body.description : '',
          kind,
          milestone: typeof body.milestone === 'string' ? body.milestone : null,
          criteria,
          created_at: created,
        }
        ensureCard(proj, pid, meta)
        storage.upsertCard({ ...meta, project_id: pid })
        // brief=false = 裸跑（对照实验 B 组）；group 标记实验组
        const brief = body.brief !== false
        const groupTag = typeof body.group === 'string' && body.group ? body.group : undefined
        // 预设 Profile（§2.6）：preset_id 选择三轴 Profile；缺省 = 项目默认；快照落 executions.preset_json
        storage.seedProfiles(pid)
        const presetReq = typeof body.preset_id === 'string' && body.preset_id.trim()
          ? body.preset_id.trim()
          : typeof body.preset === 'string' && body.preset.trim() ? body.preset.trim() : ''
        const profile = presetReq ? storage.getProfile(pid, presetReq) : storage.defaultProfile(pid)
        if (presetReq && !profile) throw new HttpError(404, `profile '${presetReq}' not found`)
        const presetSnapshot = profile
          ? { id: profile.id, name: profile.name, mode: profile.mode, setting: profile.setting, approval: profile.approval, sandbox: profile.sandbox }
          : null
        const sid = await startExecution(pid, cardId, null, {
          brief, groupTag, criteria,
          // 注意：Profile 是三轴语义（协作方式/执行设定/审批/沙箱），不是 dsh 引擎 preset——
          // 不把 profile.id 透传给 _meta.agentPreset（引擎 preset 是独立的"工具集定制"，P0 不同步）
          presetSnapshot: presetSnapshot ? JSON.stringify(presetSnapshot) : null,
        })
        send(201, { card_id: cardId, session_id: sid, preset: presetSnapshot })
        return
      }
      const cardMatch = path.match(/^\/api\/cards\/([^/]+)$/)
      if (cardMatch && method === 'GET') {
        const cardId = decodeURIComponent(cardMatch[1])
        for (const [pid, p] of Object.entries(proj.projects)) {
          const c = p.cards[cardId]
          if (c) {
            send(200, { ...c, project_id: pid })
            return
          }
        }
        throw new HttpError(404, `card '${cardId}' not found`)
      }
      const execMatch = path.match(/^\/api\/cards\/([^/]+)\/executions$/)
      if (execMatch && method === 'POST') {
        const cardId = decodeURIComponent(execMatch[1])
        const body = await readBody()
        const entry = Object.entries(proj.projects).find(([, p]) => p.cards[cardId])
        if (!entry) throw new HttpError(404, `card '${cardId}' not found`)
        const [pid, p] = entry
        const c = p.cards[cardId]
        const from = typeof body.from_execution_id === 'string' && body.from_execution_id.trim()
          ? body.from_execution_id.trim()
          : null
        if (from && !c.executions[from]) throw new HttpError(400, `from_execution_id '${from}' not in card '${cardId}'`)
        const sid = await startExecution(pid, cardId, from)
        send(201, { card_id: cardId, session_id: sid, forked_from: from })
        return
      }

      // ---------- 任务（兼容旧接口 + 评论/取消） ----------
      const tasksMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/)
      if (tasksMatch && method === 'POST') {
        const pid = decodeURIComponent(tasksMatch[1])
        const body = await readBody()
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        const title = prompt.split('\n')[0]?.trim() || prompt
        if (!proj.projects[pid]) throw new HttpError(404, `project '${pid}' not found; create it via POST /api/projects first`)
        const cardId = genCardId()
        const created = nowMs()
        const meta: CardMeta = { id: cardId, title, description: '', kind: 'task', milestone: null, criteria: null, created_at: created }
        ensureCard(proj, pid, meta)
        storage.upsertCard({ ...meta, project_id: pid })
        const sid = await startExecution(pid, cardId, null)
        send(201, { session_id: sid, card_id: cardId })
        return
      }
      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/)
      if (taskMatch && method === 'GET') {
        const sid = decodeURIComponent(taskMatch[1])
        const cardId = proj.sessionCard[sid]
        const pid = proj.sessionProject[sid]
        const t = pid ? proj.projects[pid]?.cards[cardId]?.executions[sid] : undefined
        if (!t) throw new HttpError(404, 'task not found')
        send(200, t)
        return
      }
      const commentMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments$/)
      if (commentMatch && method === 'POST') {
        const sid = decodeURIComponent(commentMatch[1])
        const body = await readBody()
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) throw new HttpError(400, 'empty comment')
        if (!proj.sessionCard[sid]) throw new HttpError(404, 'task not found')
        void acp.sessionPrompt(sid, text).catch((e) => console.error(`[comment] ${sid} failed:`, e))
        send(200, { ok: true })
        return
      }
      const cancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/)
      if (cancelMatch && method === 'POST') {
        const sid = decodeURIComponent(cancelMatch[1])
        await acp.sessionCancel(sid)
        send(200, { ok: true })
        return
      }

      // ---------- 批复队列（P0：Waiting 状态机） ----------
      // POST /api/tasks/:sid/waiting —— 触发 Waiting{kind}（任务停在等待批复，原会话挂起）
      const waitingMatch = path.match(/^\/api\/tasks\/([^/]+)\/waiting$/)
      if (waitingMatch && method === 'POST') {
        const sid = decodeURIComponent(waitingMatch[1])
        const body = await readBody()
        const kind = body.kind === 'plan' || body.kind === 'permission' || body.kind === 'acceptance' || body.kind === 'cost'
          ? body.kind
          : 'permission'
        const reason = typeof body.reason === 'string' ? body.reason : ''
        const pid = proj.sessionProject[sid]
        const cardId = proj.sessionCard[sid]
        const t = pid ? proj.projects[pid]?.cards[cardId]?.executions[sid] : undefined
        if (!t || !pid) throw new HttpError(404, 'task not found')
        t.waiting = { kind, reason, payload: typeof body.payload === 'object' && body.payload !== null ? body.payload as Record<string, unknown> : {} }
        t.status = 'Running' // Waiting 是派生状态，底层仍挂起（前端 effectiveStatus 映射为 Waiting）
        const aid = storage.insertApproval({
          id: 0,
          project_id: pid,
          execution_id: sid,
          kind,
          payload: typeof body.payload === 'object' && body.payload !== null ? body.payload as Record<string, unknown> : {},
          reason: reason || null,
          outcome: null,
          comment: null,
          created_at: nowMs(),
          decided_at: null,
          suspended_at: null,
        })
        send(201, { approval_id: aid, kind, reason })
        return
      }

      // ---------- 预设 Profile（P0 §2.6：三轴组合 = 命名 Profile，项目级） ----------
      // GET /api/projects/:pid/presets —— Profile 列表（含三轴明细 + 默认标记）
      const listProfilesMatch = path.match(/^\/api\/projects\/([^/]+)\/presets$/)
      if (listProfilesMatch && method === 'GET') {
        const pid = decodeURIComponent(listProfilesMatch[1])
        if (!proj.projects[pid]) throw new HttpError(404, 'project not found')
        storage.seedProfiles(pid)
        send(200, storage.listProfiles(pid))
        return
      }
      // POST /api/projects/:pid/presets —— 自定义 Profile（复制内置/现有，改三轴存新）
      if (listProfilesMatch && method === 'POST') {
        const pid = decodeURIComponent(listProfilesMatch[1])
        if (!proj.projects[pid]) throw new HttpError(404, 'project not found')
        const body = await readBody()
        const id = typeof body.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(body.id) ? body.id : null
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
        if (!id || !name) throw new HttpError(400, 'id (小写连字符) 和 name 必填')
        const mode = body.mode === 'normal' || body.mode === 'plan' || body.mode === 'goal' ? body.mode : 'normal'
        const setting = body.setting === 'light' || body.setting === 'balanced' || body.setting === 'delivery' ? body.setting : 'balanced'
        const approval = body.approval === 'ask' || body.approval === 'auto' || body.approval === 'yolo' ? body.approval : 'ask'
        const sandbox = body.sandbox === 'read-only' || body.sandbox === 'workspace-write' || body.sandbox === 'danger-full-access' ? body.sandbox : 'workspace-write'
        storage.seedProfiles(pid)
        const existing = storage.getProfile(pid, id)
        if (existing?.is_builtin) throw new HttpError(409, `内置 Profile '${id}' 不可覆盖；请用新 id 自定义`)
        storage.upsertProfile(pid, {
          id, name, is_builtin: false,
          mode, setting, approval, sandbox,
          is_default: existing?.is_default ?? false,
        })
        send(201, storage.getProfile(pid, id))
        return
      }
      // POST /api/projects/:pid/presets/:id/default —— 设项目默认
      const defaultProfileMatch = path.match(/^\/api\/projects\/([^/]+)\/presets\/([^/]+)\/default$/)
      if (defaultProfileMatch && method === 'POST') {
        const pid = decodeURIComponent(defaultProfileMatch[1])
        const id = decodeURIComponent(defaultProfileMatch[2])
        if (!storage.setDefaultProfile(pid, id)) throw new HttpError(404, `profile '${id}' not found`)
        send(200, { ok: true, default: id })
        return
      }

      // GET /api/approvals?project= —— 批复队列（待批复 + 等待原因）
      if (method === 'GET' && path === '/api/approvals') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        const pending = storage.listPendingApprovals(projectId)
        // 附带任务标题/卡归属（队列展示需要）
        const enriched = pending.map((a) => {
          const t = proj.projects[a.project_id]?.cards[proj.sessionCard[a.execution_id]]?.executions[a.execution_id]
          return {
            ...a,
            task_title: t?.title ?? a.execution_id,
            card_id: proj.sessionCard[a.execution_id] ?? null,
            waiting: t?.waiting ?? null,
          }
        })
        send(200, enriched)
        return
      }

      // POST /api/approvals/:id —— 决策：approve/reject（决策必须带评论送达 agent）
      const approvalMatch = path.match(/^\/api\/approvals\/(\d+)$/)
      if (approvalMatch && method === 'POST') {
        const id = Number(approvalMatch[1])
        const body = await readBody()
        const outcome = body.outcome === 'approved' ? 'approved' : body.outcome === 'rejected' ? 'rejected' : null
        if (!outcome) throw new HttpError(400, 'outcome must be approved|rejected')
        const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
        const appr = storage.getApproval(id)
        if (!appr) throw new HttpError(404, `approval ${id} not found`)
        if (!storage.decideApproval(id, outcome, comment)) throw new HttpError(409, 'already decided')
        // 决策送达 agent：评论回灌 + 放行（Waiting 清除，任务可继续）
        const sid = appr.execution_id
        const t = proj.projects[appr.project_id]?.cards[proj.sessionCard[sid]]?.executions[sid]
        if (t) t.waiting = null
        const steer = outcome === 'approved'
          ? `[批复] 已批准（${appr.kind}）：${comment || '继续执行'}`
          : `[批复] 已拒绝（${appr.kind}）：${comment || '请调整方案'}`
        void acp.sessionPrompt(sid, steer).catch((e) => console.error(`[approval] steer ${sid} failed:`, e))
        send(200, { ok: true, outcome, id })
        return
      }

      // ---------- 知识库（M4） ----------
      if (method === 'GET' && path === '/api/kb/notes') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        send(200, storage.listNotes(projectId))
        return
      }
      if (method === 'GET' && path === '/api/kb/search') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        const q = url.searchParams.get('q') ?? ''
        const notes = storage.listNotes(projectId)
        const hits = q ? retrieve(notes, deriveQueries(q), { limit: 8 }) : []
        send(200, hits.map((h) => ({ note: h.note, score: Math.round(h.score * 100) / 100 })))
        return
      }
      if (method === 'POST' && path === '/api/kb/notes') {
        const body = await readBody()
        const projectId = typeof body.project === 'string' ? body.project : 'helmsman'
        if (!proj.projects[projectId]) throw new HttpError(404, `project '${projectId}' not found`)
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : ''
        if (!title) throw new HttpError(400, 'empty title')
        const note = makeNote({
          projectId,
          title,
          content: Array.isArray(body.content) ? (body.content as unknown[]).filter((x): x is string => typeof x === 'string') : [String(body.content ?? '')],
          tags: Array.isArray(body.tags) ? (body.tags as unknown[]).filter((x): x is string => typeof x === 'string') : [],
          keywords: [],
          summary: typeof body.summary === 'string' ? body.summary : '',
          sourceKind: 'human',
          sourceRef: 'manual',
          trust: 'human-approved',
        })
        storage.upsertNote(note)
        send(201, note)
        return
      }
      const noteMatch = path.match(/^\/api\/kb\/notes\/([^/]+)$/)
      if (noteMatch && method === 'DELETE') {
        storage.deleteNote(decodeURIComponent(noteMatch[1]))
        send(200, { ok: true })
        return
      }

      // ---------- 度量（M4 §5.2） ----------
      if (method === 'GET' && path === '/api/metrics') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        send(200, storage.listMetrics(projectId))
        return
      }

      // ---------- 对照实验（§6C 实验 A） ----------
      if (method === 'POST' && path === '/api/experiments/run') {
        const body = (await readBody()) as {
          project_id?: unknown
          tasks?: unknown
          brief?: unknown
          name?: unknown
        }
        const projectId = typeof body.project_id === 'string' ? body.project_id : 'helmsman'
        if (!proj.projects[projectId]) throw new HttpError(404, `project '${projectId}' not found`)
        if (!Array.isArray(body.tasks) || body.tasks.length === 0) throw new HttpError(400, 'tasks required')
        const brief = body.brief !== false
        const group = brief ? 'A' : 'B'
        const name = typeof body.name === 'string' && body.name ? body.name : brief ? 'A 带装配' : 'B 裸跑'
        const created: Array<{ card_id: string; session_id: string; title: string }> = []
        for (const t of body.tasks as Array<{ title?: unknown; description?: unknown; acceptance?: unknown }>) {
          const title = typeof t?.title === 'string' ? t.title.trim() : ''
          if (!title) continue
          const cardId = genCardId()
          const criteria = typeof t?.acceptance === 'string' && t.acceptance.trim() ? t.acceptance.trim() : null
          const meta: CardMeta = {
            id: cardId,
            title,
            description: typeof t?.description === 'string' ? t.description : '',
            kind: 'task',
            milestone: null,
            criteria,
            created_at: nowMs(),
          }
          ensureCard(proj, projectId, meta)
          storage.upsertCard({ ...meta, project_id: projectId })
          const sid = await startExecution(projectId, cardId, null, { brief, groupTag: `${group}:${name}`, criteria })
          created.push({ card_id: cardId, session_id: sid, title })
        }
        send(201, { group, name, created })
        return
      }
      if (method === 'GET' && path === '/api/experiments/compare') {
        const projectId = url.searchParams.get('project') ?? 'helmsman'
        const all = storage.listMetrics(projectId)
        // 按 group_tag 前缀分组（A/B）
        const aRows = all.filter((m) => m.group_tag?.startsWith('A'))
        const bRows = all.filter((m) => m.group_tag?.startsWith('B'))
        send(200, compareReport(aRows, bRows))
        return
      }

      // ---------- fs ----------
      if (method === 'POST' && path === '/api/fs/pick') {
        try {
          const out = execSync('osascript -e \'POSIX path of (choose folder with prompt "选择项目目录")\'', {
            encoding: 'utf8',
            timeout: 60000,
          }).trim()
          send(200, out ? { cancelled: false, path: out } : { cancelled: true })
        } catch {
          send(200, { cancelled: true })
        }
        return
      }
      if (method === 'GET' && path === '/api/fs/list') {
        const home = homedir()
        const raw = url.searchParams.get('path') || home
        const canon = resolve(raw)
        const entries: Array<{ name: string; path: string; is_dir: boolean; is_symlink: boolean }> = []
        let dirEntries: Array<{ name: string; isDir: boolean; isSymlink: boolean }> = []
        try {
          dirEntries = readdirSync(canon, { withFileTypes: true }).map((e) => ({
            name: e.name,
            isDir: e.isDirectory(),
            isSymlink: e.isSymbolicLink(),
          }))
        } catch {
          /* ignore */
        }
        for (const e of dirEntries) {
          if (e.name.startsWith('.')) continue
          entries.push({ name: e.name, path: join(canon, e.name), is_dir: e.isDir, is_symlink: e.isSymlink })
        }
        entries.sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || (a.name < b.name ? -1 : 1))
        send(200, { path: canon, parent: dirname(canon), entries })
        return
      }
      if (method === 'GET' && path === '/api/fs/find') {
        const name = url.searchParams.get('name') ?? ''
        if (!name) throw new HttpError(400, 'empty name')
        const max = Math.min(Math.max(Number(url.searchParams.get('max') ?? 5), 1), 20)
        const home = homedir()
        const found: Array<{ name: string; path: string }> = []
        let visited = 0
        const queue: Array<[string, number]> = [[home, 0]]
        while (queue.length > 0 && found.length < max && visited < 30000) {
          const [dir, depth] = queue.shift()!
          visited += 1
          let children: Array<{ name: string; isDir: boolean; isSymlink: boolean }> = []
          try {
            children = readdirSync(dir, { withFileTypes: true }).map((e) => ({
              name: e.name,
              isDir: e.isDirectory(),
              isSymlink: e.isSymbolicLink(),
            }))
          } catch {
            continue
          }
          for (const e of children) {
            if (e.name.startsWith('.')) continue
            if (e.isSymlink) continue
            if (!e.isDir) continue
            if (e.name === name && found.length < max) found.push({ name: e.name, path: join(dir, e.name) })
            if (depth < 4 && found.length < max) queue.push([join(dir, e.name), depth + 1])
          }
        }
        send(200, { name, matches: found, truncated: visited >= 30000 })
        return
      }

      send(404, { error: 'not found' })
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: err.message })
      else {
        console.error('[http] error:', err)
        send(500, { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  // ---------- 启动 ----------
  server.listen(PORT, () => {
    console.log(`[http] helmsman-ts serving on http://127.0.0.1:${PORT}`)
  })

  const shutdown = async (): Promise<void> => {
    console.log('[http] shutting down')
    server.close()
    await engine.dispose()
    storage.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

/** 卡状态计数（按最新执行聚合，枚举固定顺序） */
function cardStatusCounts(p: Project): number[] {
  const c = [0, 0, 0, 0, 0] // Pending, Running, Done, Failed, Cancelled
  for (const card of Object.values(p.cards)) {
    const t = latestExecution(card)
    const i = t ? ['Pending', 'Running', 'Done', 'Failed'].indexOf(t.status) : 0
    c[i >= 0 ? i : 4] += 1
  }
  return c
}

function latestExecution(card: CardState): CardState['executions'][string] | null {
  const order = card.exec_order.length ? card.exec_order : Object.keys(card.executions)
  const sid = order[order.length - 1]
  return (sid && card.executions[sid]) || null
}

/** 构造一个 WebSocket 文本帧（服务端 → 客户端，未掩码）。 */
function wsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

void main()
