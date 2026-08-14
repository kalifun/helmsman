/**
 * SQLite 持久化层（TS 版）——照 crates/storage/src/lib.rs 翻译。
 * 职责：项目元数据 / 卡/执行快照 / 项目设置的落盘与恢复。
 * 权威数据仍是 dsh 会话日志（.sessions/*.jsonl，启动重放）；本层解决「纯注册项目重启丢失」
 * 与「项目设置持久化」，为 kb_notes/metrics/events 预留表。
 */
import Database from 'better-sqlite3'

export interface ProjectMeta {
  id: string
  name: string
  path: string
  config_json: string
  archived: boolean
}

export interface CardSnapshot {
  id: string
  project_id: string
  title: string
  description: string
  kind: string
  milestone: string | null
  /** 需求契约：验收标准（可判定断言，D1.5/D1.7）——实验任务集的验收命令 */
  criteria: string | null
  /** 依赖契约（目标契约 taskgraph）：完成本卡前需先完成的卡 id（同项目内） */
  deps: string[]
  created_at: number
}

export interface ExecutionSnapshot {
  id: string // = session_id
  card_id: string
  status: string
  preset_json: string
  deps_json: string
  forked_from: string | null
  started_at: number | null
  finished_at: number | null
  created_at: number
}

const now = (): number => Date.now()

export class Storage {
  private db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        path        TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status      TEXT NOT NULL,
        title       TEXT,
        model       TEXT,
        turns       INTEGER NOT NULL DEFAULT 0,
        steps       INTEGER NOT NULL DEFAULT 0,
        last_seq    INTEGER NOT NULL DEFAULT 0,
        recovered   INTEGER NOT NULL DEFAULT 0,
        started_at  INTEGER,
        finished_at INTEGER,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

      CREATE TABLE IF NOT EXISTS cards (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        kind          TEXT NOT NULL DEFAULT 'task',
        milestone     TEXT,
        criteria_json TEXT NOT NULL DEFAULT '[]',  -- 需求契约：验收标准（'[]'=无，兼容旧库 NOT NULL）
        deps_json     TEXT NOT NULL DEFAULT '[]',  -- 依赖契约：卡 id 数组（目标契约 taskgraph）
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id);

      CREATE TABLE IF NOT EXISTS executions (
        id          TEXT PRIMARY KEY,
        card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        session_id  TEXT,
        status      TEXT NOT NULL DEFAULT 'Pending',
        preset_json TEXT NOT NULL DEFAULT '{}',
        deps_json   TEXT NOT NULL DEFAULT '[]',
        forked_from TEXT,
        started_at  INTEGER,
        finished_at INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_executions_card ON executions(card_id);

      CREATE TABLE IF NOT EXISTS deleted_projects (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
      );

      -- M4 知识库（architecture §4 kb_notes；双时态 + 信任分级 + 出处）
      CREATE TABLE IF NOT EXISTS kb_notes (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        content_json  TEXT NOT NULL,            -- string[]（结构化行）
        tags_json     TEXT NOT NULL DEFAULT '[]',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        summary       TEXT NOT NULL DEFAULT '',
        links_json    TEXT NOT NULL DEFAULT '[]',
        source_kind   TEXT NOT NULL,            -- 'task' | 'subagent' | 'human' | 'project'
        source_ref    TEXT NOT NULL,            -- 卡/会话/项目 id
        valid_from    INTEGER NOT NULL,
        valid_until   INTEGER,                  -- NULL = 当前有效
        invalidated_by TEXT,
        version       INTEGER NOT NULL DEFAULT 1,
        trust         TEXT NOT NULL DEFAULT 'unverified',  -- human-approved | agent-generated | unverified
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_project ON kb_notes(project_id);
      CREATE INDEX IF NOT EXISTS idx_kb_valid ON kb_notes(project_id, valid_until);

      -- M4 度量闭环（§5.2：简报命中率 / 引用锚点 / 对照实验组）
      CREATE TABLE IF NOT EXISTS metrics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    TEXT NOT NULL,
        task_id       TEXT NOT NULL,
        brief_snapshot_json TEXT NOT NULL DEFAULT '[]',
        outcome       TEXT NOT NULL DEFAULT '',
        cited_entries_json TEXT NOT NULL DEFAULT '[]',
        turns         INTEGER NOT NULL DEFAULT 0,
        steps         INTEGER NOT NULL DEFAULT 0,
        group_tag     TEXT,                       -- 对照实验组（'A'=带装配 / 'B'=裸跑）
        verified      INTEGER,                    -- 验收结果（1=通过 / 0=失败 / NULL=无验收标准）
        cost          REAL NOT NULL DEFAULT 0,
        cache_hit     REAL NOT NULL DEFAULT 0,
        in_tokens     INTEGER NOT NULL DEFAULT 0,  -- 输入 token（全价部分）
        cache_tokens  INTEGER NOT NULL DEFAULT 0,  -- 缓存命中输入 token（1/50 价）
        out_tokens    INTEGER NOT NULL DEFAULT 0,  -- 输出 token
        reason_tokens INTEGER NOT NULL DEFAULT 0,  -- 推理 token
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_project ON metrics(project_id);

      -- P0 批复队列（architecture §4 approvals；一等表面 + 唯一事实来源）
      CREATE TABLE IF NOT EXISTS approvals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL,
        execution_id TEXT NOT NULL,          -- = 会话 id（D1.2）
        kind        TEXT NOT NULL,           -- 'plan' | 'permission' | 'acceptance' | 'cost'
        payload_json TEXT NOT NULL DEFAULT '{}',
        reason      TEXT,                    -- 等待原因（agent 停下时说明）
        outcome     TEXT,                    -- 'approved' | 'rejected' | 'suspended' | NULL=待批复
        comment     TEXT,                    -- 批复决策必须携带评论送达 agent
        created_at  INTEGER NOT NULL,
        decided_at  INTEGER,
        suspended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(project_id, outcome);

      -- P0 预设 Profile（§2.6：三轴组合收敛为命名 Profile；项目级管理）
      CREATE TABLE IF NOT EXISTS profiles (
        id          TEXT NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        is_builtin  INTEGER NOT NULL DEFAULT 0,
        mode        TEXT NOT NULL DEFAULT 'normal',    -- normal | plan | goal
        setting     TEXT NOT NULL DEFAULT 'balanced',  -- light | balanced | delivery
        approval    TEXT NOT NULL DEFAULT 'ask',       -- ask | auto | yolo
        sandbox     TEXT NOT NULL DEFAULT 'workspace-write',
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (project_id, id)
      );
    `)
    // 幂等迁移：老库补 turns/steps/group_tag/verified 列（§5.2 对照实验需要）
    const cols = this.db.prepare(`SELECT name FROM pragma_table_info('metrics')`).all() as Array<{ name: string }>
    const have = new Set(cols.map((c) => c.name))
    if (!have.has('turns')) this.db.exec(`ALTER TABLE metrics ADD COLUMN turns INTEGER NOT NULL DEFAULT 0`)
    if (!have.has('steps')) this.db.exec(`ALTER TABLE metrics ADD COLUMN steps INTEGER NOT NULL DEFAULT 0`)
    if (!have.has('group_tag')) this.db.exec(`ALTER TABLE metrics ADD COLUMN group_tag TEXT`)
    if (!have.has('in_tokens')) this.db.exec(`ALTER TABLE metrics ADD COLUMN in_tokens INTEGER NOT NULL DEFAULT 0`)
    if (!have.has('cache_tokens')) this.db.exec(`ALTER TABLE metrics ADD COLUMN cache_tokens INTEGER NOT NULL DEFAULT 0`)
    if (!have.has('out_tokens')) this.db.exec(`ALTER TABLE metrics ADD COLUMN out_tokens INTEGER NOT NULL DEFAULT 0`)
    if (!have.has('reason_tokens')) this.db.exec(`ALTER TABLE metrics ADD COLUMN reason_tokens INTEGER NOT NULL DEFAULT 0`)
    if (!have.has('verified')) this.db.exec(`ALTER TABLE metrics ADD COLUMN verified INTEGER`)
    // 迁移：老库 cards 补 deps_json 列（依赖契约）
    const cardCols = this.db.prepare(`SELECT name FROM pragma_table_info('cards')`).all() as Array<{ name: string }>
    if (!cardCols.some((c) => c.name === 'deps_json')) {
      this.db.exec(`ALTER TABLE cards ADD COLUMN deps_json TEXT NOT NULL DEFAULT '[]'`)
    }
  }

  // ---------- 项目 ----------

  upsertProject(id: string, name: string, path: string, configJson: string): void {
    const t = now()
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, updated_at=excluded.updated_at`,
      )
      .run(id, name, path, configJson, t, t)
  }

  loadProjects(): ProjectMeta[] {
    return this.db
      .prepare('SELECT id, name, path, config_json, archived FROM projects WHERE archived = 0 ORDER BY updated_at DESC')
      .all()
      .map((r) => rowToProjectMeta(r as Record<string, unknown>))
  }

  archiveProject(id: string): void {
    this.db.prepare('UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?').run(now(), id)
  }

  unarchiveProject(id: string): void {
    this.db.prepare('UPDATE projects SET archived = 0, updated_at = ? WHERE id = ?').run(now(), id)
  }

  purgeProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  markDeleted(id: string): void {
    this.db.prepare('INSERT OR REPLACE INTO deleted_projects (id, deleted_at) VALUES (?, ?)').run(id, now())
  }

  isDeleted(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM deleted_projects WHERE id = ?').get(id) !== undefined
  }

  projectExists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined
  }

  findArchivedProject(path: string): ProjectMeta | undefined {
    const row = this.db
      .prepare('SELECT id, name, path, config_json, archived FROM projects WHERE archived = 1 AND path = ?')
      .get(path) as Record<string, unknown> | undefined
    return row ? rowToProjectMeta(row) : undefined
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  // ---------- 卡片快照 ----------

  upsertCard(c: CardSnapshot): void {
    const t = now()
    this.db
      .prepare(
        `INSERT INTO cards (id, project_id, title, description, kind, milestone, criteria_json, deps_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, description=excluded.description, kind=excluded.kind,
           milestone=excluded.milestone, criteria_json=excluded.criteria_json,
           deps_json=excluded.deps_json, updated_at=excluded.updated_at`,
      )
      .run(c.id, c.project_id, c.title, c.description, c.kind, c.milestone, c.criteria ?? '[]', JSON.stringify(c.deps ?? []), c.created_at, t)
  }

  loadCards(projectId: string): CardSnapshot[] {
    return this.db
      .prepare('SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, created_at FROM cards WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId)
      .map((r) => rowToCard(r as Record<string, unknown>))
  }

  loadAllCards(): CardSnapshot[] {
    return this.db
      .prepare('SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, created_at FROM cards')
      .all()
      .map((r) => rowToCard(r as Record<string, unknown>))
  }

  getCard(id: string): CardSnapshot | undefined {
    const row = this.db
      .prepare('SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, created_at FROM cards WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? rowToCard(row) : undefined
  }

  // ---------- 执行快照 ----------

  upsertExecution(e: ExecutionSnapshot): void {
    const t = now()
    this.db
      .prepare(
        `INSERT INTO executions (id, card_id, session_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           card_id=excluded.card_id, session_id=excluded.session_id, status=excluded.status,
           preset_json=excluded.preset_json, deps_json=excluded.deps_json,
           forked_from=excluded.forked_from, started_at=excluded.started_at,
           finished_at=excluded.finished_at, updated_at=excluded.updated_at`,
      )
      .run(e.id, e.card_id, e.id, e.status, e.preset_json, e.deps_json, e.forked_from, e.started_at, e.finished_at, e.created_at, t)
  }

  loadExecutions(cardId: string): ExecutionSnapshot[] {
    return this.db
      .prepare(
        'SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at FROM executions WHERE card_id = ? ORDER BY created_at',
      )
      .all(cardId)
      .map((r) => rowToExecution(r as Record<string, unknown>))
  }

  loadAllExecutions(): ExecutionSnapshot[] {
    return this.db
      .prepare(
        'SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at FROM executions',
      )
      .all()
      .map((r) => rowToExecution(r as Record<string, unknown>))
  }

  getExecutionBySession(sessionId: string): ExecutionSnapshot | undefined {
    const row = this.db
      .prepare(
        'SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at FROM executions WHERE session_id = ?',
      )
      .get(sessionId) as Record<string, unknown> | undefined
    return row ? rowToExecution(row) : undefined
  }

  // ---------- 设置 ----------

  setConfig(projectId: string, key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (project_id, key, value) VALUES (?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value=excluded.value',
      )
      .run(projectId, key, value)
  }

  getConfig(projectId: string, key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE project_id = ? AND key = ?').get(projectId, key) as
      | { value: string }
      | undefined
    return row?.value
  }

  projectConfig(id: string): string | undefined {
    const row = this.db.prepare('SELECT config_json FROM projects WHERE id = ?').get(id) as { config_json: string } | undefined
    return row?.config_json
  }

  // ---------- 知识库（M4） ----------

  upsertNote(n: KbNote): void {
    const t = Date.now()
    this.db
      .prepare(
        `INSERT INTO kb_notes (id, project_id, title, content_json, tags_json, keywords_json, summary,
           links_json, source_kind, source_ref, valid_from, valid_until, invalidated_by, version, trust, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, content_json=excluded.content_json, tags_json=excluded.tags_json,
           keywords_json=excluded.keywords_json, summary=excluded.summary, links_json=excluded.links_json,
           valid_until=excluded.valid_until, invalidated_by=excluded.invalidated_by,
           version=excluded.version, trust=excluded.trust, updated_at=excluded.updated_at`,
      )
      .run(
        n.id, n.project_id, n.title, JSON.stringify(n.content), JSON.stringify(n.tags),
        JSON.stringify(n.keywords), n.summary, JSON.stringify(n.links),
        n.source.kind, n.source.ref, n.validFrom, n.validUntil ?? null, n.invalidatedBy ?? null,
        n.version, n.trust, n.createdAt, t,
      )
  }

  /** 当前有效的笔记（双时态过滤）。 */
  listNotes(projectId: string): KbNote[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_notes WHERE project_id = ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY created_at DESC')
      .all(projectId, Date.now()) as Array<Record<string, unknown>>
    return rows.map(rowToNote)
  }

  /** 全部笔记（含失效，审计/演化用）。 */
  listAllNotes(projectId: string): KbNote[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_notes WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToNote)
  }

  getNote(id: string): KbNote | undefined {
    const row = this.db.prepare('SELECT * FROM kb_notes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToNote(row) : undefined
  }

  /** 边失效：把 id 标记为被 newNoteId 推翻。 */
  invalidateNote(id: string, newNoteId: string, at: number): void {
    this.db
      .prepare('UPDATE kb_notes SET valid_until = ?, invalidated_by = ?, updated_at = ? WHERE id = ? AND valid_until IS NULL')
      .run(at, newNoteId, at, id)
  }

  deleteNote(id: string): void {
    this.db.prepare('DELETE FROM kb_notes WHERE id = ?').run(id)
  }

  // ---------- 度量（M4 §5.2） ----------

  insertMetric(m: MetricRow): void {
    this.db
      .prepare(
        `INSERT INTO metrics (project_id, task_id, brief_snapshot_json, outcome, cited_entries_json, turns, steps, group_tag, verified, cost, cache_hit, in_tokens, cache_tokens, out_tokens, reason_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.project_id, m.task_id, JSON.stringify(m.brief_snapshot), m.outcome,
        JSON.stringify(m.cited_entries), m.turns, m.steps, m.group_tag ?? null,
        m.verified === undefined ? null : m.verified ? 1 : 0,
        m.cost, m.cache_hit, m.in_tokens, m.cache_tokens, m.out_tokens, m.reason_tokens, m.created_at,
      )
  }

  listMetrics(projectId: string): MetricRow[] {
    const rows = this.db
      .prepare('SELECT * FROM metrics WHERE project_id = ? ORDER BY created_at DESC LIMIT 200')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToMetric)
  }

  // ---------- 批复队列（P0：一等表面 + 唯一事实来源） ----------

  insertApproval(a: ApprovalRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO approvals (project_id, execution_id, kind, payload_json, reason, outcome, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.project_id, a.execution_id, a.kind, JSON.stringify(a.payload), a.reason ?? null, a.outcome ?? null, a.comment ?? null, a.created_at)
    return Number(info.lastInsertRowid)
  }

  /** 待批复队列（按项目；含等待原因与挂起标记）。 */
  listPendingApprovals(projectId: string): ApprovalRow[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals WHERE project_id = ? AND outcome IS NULL ORDER BY created_at')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToApproval)
  }

  /** 全量批复（含已决策，审计）。 */
  listApprovals(projectId: string, limit = 100): ApprovalRow[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectId, limit) as Array<Record<string, unknown>>
    return rows.map(rowToApproval)
  }

  getApproval(id: number): ApprovalRow | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToApproval(row) : undefined
  }

  /** 决策批复：approve/reject + 评论；返回是否成功（已决策的不再改）。 */
  decideApproval(id: number, outcome: 'approved' | 'rejected', comment: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE approvals SET outcome = ?, comment = ?, decided_at = ? WHERE id = ? AND outcome IS NULL`,
      )
      .run(outcome, comment, Date.now(), id)
    return info.changes > 0
  }

  /** 挂起：超时自动挂起（O5：默认 30 分钟，危险操作永不自动放行）。 */
  suspendApproval(id: number): boolean {
    const info = this.db
      .prepare('UPDATE approvals SET outcome = ?, suspended_at = ? WHERE id = ? AND outcome IS NULL')
      .run('suspended', Date.now(), id)
    return info.changes > 0
  }

  // ---------- 预设 Profile（P0 §2.6） ----------

  /** 种子内置 4 个 Profile（幂等）；首个成为项目默认。返回是否首次种子。 */
  seedProfiles(projectId: string): boolean {
    const existing = this.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE project_id = ?').get(projectId) as { n: number }
    if (existing.n > 0) return false
    const t = Date.now()
    const insert = this.db.prepare(
      `INSERT INTO profiles (id, project_id, name, is_builtin, mode, setting, approval, sandbox, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    BUILTIN_PROFILES.forEach((p, i) => {
      insert.run(p.id, projectId, p.name, 1, p.mode, p.setting, p.approval, p.sandbox, i === 0 ? 1 : 0, t, t)
    })
    return true
  }

  listProfiles(projectId: string): Profile[] {
    const rows = this.db
      .prepare('SELECT * FROM profiles WHERE project_id = ? ORDER BY is_default DESC, is_builtin DESC, created_at')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToProfile)
  }

  getProfile(projectId: string, id: string): Profile | undefined {
    const row = this.db
      .prepare('SELECT * FROM profiles WHERE project_id = ? AND id = ?')
      .get(projectId, id) as Record<string, unknown> | undefined
    return row ? rowToProfile(row) : undefined
  }

  defaultProfile(projectId: string): Profile | undefined {
    const row = this.db
      .prepare('SELECT * FROM profiles WHERE project_id = ? AND is_default = 1')
      .get(projectId) as Record<string, unknown> | undefined
    return row ? rowToProfile(row) : undefined
  }

  /** 自定义 Profile（复制现有改三轴）；内置不可直接覆盖。 */
  upsertProfile(projectId: string, p: Omit<Profile, 'project_id' | 'created_at' | 'updated_at'>): void {
    const t = Date.now()
    this.db
      .prepare(
        `INSERT INTO profiles (id, project_id, name, is_builtin, mode, setting, approval, sandbox, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, id) DO UPDATE SET
           name=excluded.name, mode=excluded.mode, setting=excluded.setting,
           approval=excluded.approval, sandbox=excluded.sandbox, updated_at=excluded.updated_at
           WHERE profiles.is_builtin = 0`,
      )
      .run(p.id, projectId, p.name, p.is_builtin ? 1 : 0, p.mode, p.setting, p.approval, p.sandbox, p.is_default ? 1 : 0, t, t)
  }

  /** 设项目默认（清旧默认，设新默认）。 */
  setDefaultProfile(projectId: string, id: string): boolean {
    const p = this.getProfile(projectId, id)
    if (!p) return false
    this.db.prepare('UPDATE profiles SET is_default = 0 WHERE project_id = ?').run(projectId)
    this.db.prepare('UPDATE profiles SET is_default = 1 WHERE project_id = ? AND id = ?').run(projectId, id)
    return true
  }

  removeProfile(projectId: string, id: string): boolean {
    const p = this.getProfile(projectId, id)
    if (!p || p.is_builtin) return false // 内置不可删
    const info = this.db.prepare('DELETE FROM profiles WHERE project_id = ? AND id = ?').run(projectId, id)
    return info.changes > 0
  }

  close(): void {
    this.db.close()
  }
}

function rowToProjectMeta(r: Record<string, unknown>): ProjectMeta {
  return {
    id: r.id as string,
    name: r.name as string,
    path: r.path as string,
    config_json: r.config_json as string,
    archived: (r.archived as number) !== 0,
  }
}

function rowToCard(r: Record<string, unknown>): CardSnapshot {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    title: r.title as string,
    description: (r.description as string) ?? '',
    kind: (r.kind as string) ?? 'task',
    milestone: (r.milestone as string | null) ?? null,
    criteria: (r.criteria_json as string | null) && r.criteria_json !== '[]' ? (r.criteria_json as string) : null,
    deps: parseIdArray(r.deps_json),
    created_at: r.created_at as number,
  }
}

/** 解析 JSON 数组（'[]' 或非法 → 空数组；卡依赖 id 列表） */
export function parseIdArray(json: unknown): string[] {
  if (typeof json !== 'string') return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

function rowToExecution(r: Record<string, unknown>): ExecutionSnapshot {
  return {
    id: r.id as string,
    card_id: r.card_id as string,
    status: r.status as string,
    preset_json: (r.preset_json as string) ?? '{}',
    deps_json: (r.deps_json as string) ?? '[]',
    forked_from: (r.forked_from as string | null) ?? null,
    started_at: (r.started_at as number | null) ?? null,
    finished_at: (r.finished_at as number | null) ?? null,
    created_at: r.created_at as number,
  }
}

// ---------- M4 知识库 / 度量类型 ----------

export type KbTrust = 'human-approved' | 'agent-generated' | 'unverified'

export interface KbNote {
  id: string
  project_id: string
  title: string
  content: string[]
  tags: string[]
  keywords: string[]
  summary: string
  links: string[]
  source: { kind: 'task' | 'subagent' | 'human' | 'project'; ref: string }
  validFrom: number
  validUntil: number | null
  invalidatedBy?: string
  version: number
  trust: KbTrust
  createdAt: number
  updatedAt: number
}

export interface MetricRow {
  project_id: string
  task_id: string
  brief_snapshot: Array<{ id: string; title: string; score: number }>
  outcome: string
  cited_entries: string[]
  turns: number
  steps: number
  group_tag?: string
  /** 验收结果：true=通过 / false=失败 / undefined=无验收标准 */
  verified?: boolean
  cost: number
  cache_hit: number
  in_tokens: number
  cache_tokens: number
  out_tokens: number
  reason_tokens: number
  created_at: number
}

function rowToNote(r: Record<string, unknown>): KbNote {
  const parse = (s: unknown): string[] => {
    if (typeof s !== 'string') return []
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    title: r.title as string,
    content: parse(r.content_json),
    tags: parse(r.tags_json),
    keywords: parse(r.keywords_json),
    summary: (r.summary as string) ?? '',
    links: parse(r.links_json),
    source: { kind: r.source_kind as KbNote['source']['kind'], ref: r.source_ref as string },
    validFrom: r.valid_from as number,
    validUntil: (r.valid_until as number | null) ?? null,
    invalidatedBy: (r.invalidated_by as string | undefined) ?? undefined,
    version: (r.version as number) ?? 1,
    trust: (r.trust as KbTrust) ?? 'unverified',
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }
}

function rowToMetric(r: Record<string, unknown>): MetricRow {
  const parseArr = (s: unknown): Array<{ id: string; title: string; score: number }> => {
    if (typeof s !== 'string') return []
    try {
      return JSON.parse(s) as Array<{ id: string; title: string; score: number }>
    } catch {
      return []
    }
  }
  const parseCited = (s: unknown): string[] => {
    if (typeof s !== 'string') return []
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return {
    project_id: r.project_id as string,
    task_id: r.task_id as string,
    brief_snapshot: parseArr(r.brief_snapshot_json),
    outcome: (r.outcome as string) ?? '',
    cited_entries: parseCited(r.cited_entries_json),
    turns: (r.turns as number) ?? 0,
    steps: (r.steps as number) ?? 0,
    group_tag: (r.group_tag as string | undefined) ?? undefined,
    verified: r.verified === undefined || r.verified === null ? undefined : (r.verified as number) !== 0,
    cost: (r.cost as number) ?? 0,
    cache_hit: (r.cache_hit as number) ?? 0,
    in_tokens: (r.in_tokens as number) ?? 0,
    cache_tokens: (r.cache_tokens as number) ?? 0,
    out_tokens: (r.out_tokens as number) ?? 0,
    reason_tokens: (r.reason_tokens as number) ?? 0,
    created_at: r.created_at as number,
  }
}

// ---------- 批复队列类型 ----------

export type ApprovalKind = 'plan' | 'permission' | 'acceptance' | 'cost' | 'calibrate'
export type ApprovalOutcome = 'approved' | 'rejected' | 'suspended' | null

export interface ApprovalRow {
  id: number
  project_id: string
  execution_id: string
  kind: ApprovalKind
  payload: Record<string, unknown>
  reason: string | null
  outcome: ApprovalOutcome
  comment: string | null
  created_at: number
  decided_at: number | null
  suspended_at: number | null
}

function rowToApproval(r: Record<string, unknown>): ApprovalRow {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse((r.payload_json as string) ?? '{}') as Record<string, unknown>
  } catch {
    payload = {}
  }
  return {
    id: r.id as number,
    project_id: r.project_id as string,
    execution_id: r.execution_id as string,
    kind: r.kind as ApprovalKind,
    payload,
    reason: (r.reason as string | null) ?? null,
    outcome: (r.outcome as ApprovalOutcome) ?? null,
    comment: (r.comment as string | null) ?? null,
    created_at: r.created_at as number,
    decided_at: (r.decided_at as number | null) ?? null,
    suspended_at: (r.suspended_at as number | null) ?? null,
  }
}

// ---------- 预设 Profile（§2.6：三轴组合 = 命名 Profile） ----------

export type ProfileMode = 'normal' | 'plan' | 'goal'
export type ProfileSetting = 'light' | 'balanced' | 'delivery'
export type ProfileApproval = 'ask' | 'auto' | 'yolo'
export type ProfileSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface Profile {
  id: string
  project_id: string
  name: string
  is_builtin: boolean
  mode: ProfileMode
  setting: ProfileSetting
  approval: ProfileApproval
  sandbox: ProfileSandbox
  is_default: boolean
  created_at: number
  updated_at: number
}

/** 内置 4 个 Profile（每项目种子；§2.6 标准/谨慎/冲浪/交付）。 */
export const BUILTIN_PROFILES: Array<Omit<Profile, 'project_id' | 'is_default' | 'created_at' | 'updated_at'>> = [
  { id: 'standard', name: '标准', is_builtin: true, mode: 'normal', setting: 'balanced', approval: 'ask', sandbox: 'workspace-write' },
  { id: 'cautious', name: '谨慎', is_builtin: true, mode: 'plan', setting: 'balanced', approval: 'ask', sandbox: 'read-only' },
  { id: 'surfing', name: '冲浪', is_builtin: true, mode: 'normal', setting: 'light', approval: 'auto', sandbox: 'workspace-write' },
  { id: 'delivery', name: '交付', is_builtin: true, mode: 'normal', setting: 'delivery', approval: 'auto', sandbox: 'workspace-write' },
]

function rowToProfile(r: Record<string, unknown>): Profile {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    name: r.name as string,
    is_builtin: (r.is_builtin as number) !== 0,
    mode: r.mode as ProfileMode,
    setting: r.setting as ProfileSetting,
    approval: r.approval as ProfileApproval,
    sandbox: r.sandbox as ProfileSandbox,
    is_default: (r.is_default as number) !== 0,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
  }
}
