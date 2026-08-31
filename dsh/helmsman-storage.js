import Database from "better-sqlite3";
const now = () => Date.now();
class Storage {
  db;
  constructor(path) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
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
        criteria_json TEXT NOT NULL DEFAULT '[]',  -- \u9700\u6C42\u5951\u7EA6\uFF1A\u9A8C\u6536\u6807\u51C6\uFF08'[]'=\u65E0\uFF0C\u517C\u5BB9\u65E7\u5E93 NOT NULL\uFF09
        deps_json     TEXT NOT NULL DEFAULT '[]',  -- \u4F9D\u8D56\u5951\u7EA6\uFF1A\u5361 id \u6570\u7EC4\uFF08\u76EE\u6807\u5951\u7EA6 taskgraph\uFF09
        budget        REAL,                         -- \u6267\u884C\u9884\u7B97\uFF08\xA5\uFF0Copt-in\uFF1BWaiting{cost}\uFF09
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

      -- P1 \u7B56\u7565\u5B66\u4E60\uFF08O6\uFF1A\u6BCF\u6B21\u6279\u590D\u53EF\u6C89\u6DC0\u7B56\u7565\u539F\u5B50\uFF1B\u547D\u4EE4\u6A21\u5F0F\u7EA7\u767D\u540D\u5355\u7B49\u5F15\u64CE\u7F1D\uFF0C\u5148\u843D\u6279\u590D\u7B56\u7565\uFF09
      CREATE TABLE IF NOT EXISTS policies (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,              -- \u6279\u590D\u7C7B\u578B\uFF1Acheckpoint | calibrate | plan | acceptance | permission
        scope       TEXT NOT NULL,              -- \u5361\u7C7B\u578B\uFF1Arequirement | bug | task | global
        outcome     TEXT NOT NULL,              -- approved | rejected
        count       INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE (project_id, kind, scope, outcome)
      );
      CREATE INDEX IF NOT EXISTS idx_policies_project ON policies(project_id);

      -- A \u7EC4\u4F1A\u8BDD\u5C42\u95ED\u73AF\uFF1A\u7B80\u5355\u4F1A\u8BDD\uFF08chat\uFF09\u6301\u4E45\u5316\u6807\u8BB0\uFF08\u91CD\u542F\u540E\u6062\u590D\u4E3A\u72EC\u7ACB\u4F1A\u8BDD\uFF0C\u4E0D\u5EFA\u9690\u5F0F\u5361\uFF09
      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id  TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      -- M4 \u77E5\u8BC6\u5E93\uFF08architecture \xA74 kb_notes\uFF1B\u53CC\u65F6\u6001 + \u4FE1\u4EFB\u5206\u7EA7 + \u51FA\u5904\uFF09
      CREATE TABLE IF NOT EXISTS kb_notes (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        content_json  TEXT NOT NULL,            -- string[]\uFF08\u7ED3\u6784\u5316\u884C\uFF09
        tags_json     TEXT NOT NULL DEFAULT '[]',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        summary       TEXT NOT NULL DEFAULT '',
        anti_patterns_json TEXT NOT NULL DEFAULT '[]',  -- \u53CD\u6A21\u5F0F\uFF08WikiSkill\u542F\u793A\uFF1A\u5751/\u7981\u5FCC\uFF09
        applicability TEXT NOT NULL DEFAULT '',         -- \u9002\u7528\u6761\u4EF6\uFF08\u4EC0\u4E48\u65F6\u5019\u8BE5\u7528\u8FD9\u6761\u77E5\u8BC6\uFF09
        links_json    TEXT NOT NULL DEFAULT '[]',
        source_kind   TEXT NOT NULL,            -- 'task' | 'subagent' | 'human' | 'project'
        source_ref    TEXT NOT NULL,            -- \u5361/\u4F1A\u8BDD/\u9879\u76EE id
        valid_from    INTEGER NOT NULL,
        valid_until   INTEGER,                  -- NULL = \u5F53\u524D\u6709\u6548
        invalidated_by TEXT,
        version       INTEGER NOT NULL DEFAULT 1,
        trust         TEXT NOT NULL DEFAULT 'unverified',  -- human-approved | agent-generated | unverified
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_project ON kb_notes(project_id);
      CREATE INDEX IF NOT EXISTS idx_kb_valid ON kb_notes(project_id, valid_until);

      -- M4 \u5EA6\u91CF\u95ED\u73AF\uFF08\xA75.2\uFF1A\u7B80\u62A5\u547D\u4E2D\u7387 / \u5F15\u7528\u951A\u70B9 / \u5BF9\u7167\u5B9E\u9A8C\u7EC4\uFF09
      CREATE TABLE IF NOT EXISTS metrics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    TEXT NOT NULL,
        task_id       TEXT NOT NULL,
        brief_snapshot_json TEXT NOT NULL DEFAULT '[]',
        outcome       TEXT NOT NULL DEFAULT '',
        cited_entries_json TEXT NOT NULL DEFAULT '[]',
        turns         INTEGER NOT NULL DEFAULT 0,
        steps         INTEGER NOT NULL DEFAULT 0,
        group_tag     TEXT,                       -- \u5BF9\u7167\u5B9E\u9A8C\u7EC4\uFF08'A'=\u5E26\u88C5\u914D / 'B'=\u88F8\u8DD1\uFF09
        verified      INTEGER,                    -- \u9A8C\u6536\u7ED3\u679C\uFF081=\u901A\u8FC7 / 0=\u5931\u8D25 / NULL=\u65E0\u9A8C\u6536\u6807\u51C6\uFF09
        cost          REAL NOT NULL DEFAULT 0,
        cache_hit     REAL NOT NULL DEFAULT 0,
        in_tokens     INTEGER NOT NULL DEFAULT 0,  -- \u8F93\u5165 token\uFF08\u5168\u4EF7\u90E8\u5206\uFF09
        cache_tokens  INTEGER NOT NULL DEFAULT 0,  -- \u7F13\u5B58\u547D\u4E2D\u8F93\u5165 token\uFF081/50 \u4EF7\uFF09
        out_tokens    INTEGER NOT NULL DEFAULT 0,  -- \u8F93\u51FA token
        reason_tokens INTEGER NOT NULL DEFAULT 0,  -- \u63A8\u7406 token
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_project ON metrics(project_id);

      -- P0 \u6279\u590D\u961F\u5217\uFF08architecture \xA74 approvals\uFF1B\u4E00\u7B49\u8868\u9762 + \u552F\u4E00\u4E8B\u5B9E\u6765\u6E90\uFF09
      CREATE TABLE IF NOT EXISTS approvals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL,
        execution_id TEXT NOT NULL,          -- = \u4F1A\u8BDD id\uFF08D1.2\uFF09
        kind        TEXT NOT NULL,           -- 'plan' | 'permission' | 'acceptance' | 'cost'
        payload_json TEXT NOT NULL DEFAULT '{}',
        reason      TEXT,                    -- \u7B49\u5F85\u539F\u56E0\uFF08agent \u505C\u4E0B\u65F6\u8BF4\u660E\uFF09
        outcome     TEXT,                    -- 'approved' | 'rejected' | 'suspended' | NULL=\u5F85\u6279\u590D
        comment     TEXT,                    -- \u6279\u590D\u51B3\u7B56\u5FC5\u987B\u643A\u5E26\u8BC4\u8BBA\u9001\u8FBE agent
        created_at  INTEGER NOT NULL,
        decided_at  INTEGER,
        suspended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(project_id, outcome);

      -- P0 \u9884\u8BBE Profile\uFF08\xA72.6\uFF1A\u4E09\u8F74\u7EC4\u5408\u6536\u655B\u4E3A\u547D\u540D Profile\uFF1B\u9879\u76EE\u7EA7\u7BA1\u7406\uFF09
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
    `);
    const cols = this.db.prepare(`SELECT name FROM pragma_table_info('metrics')`).all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("turns")) this.db.exec(`ALTER TABLE metrics ADD COLUMN turns INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("steps")) this.db.exec(`ALTER TABLE metrics ADD COLUMN steps INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("group_tag")) this.db.exec(`ALTER TABLE metrics ADD COLUMN group_tag TEXT`);
    if (!have.has("in_tokens")) this.db.exec(`ALTER TABLE metrics ADD COLUMN in_tokens INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("cache_tokens")) this.db.exec(`ALTER TABLE metrics ADD COLUMN cache_tokens INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("out_tokens")) this.db.exec(`ALTER TABLE metrics ADD COLUMN out_tokens INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("reason_tokens")) this.db.exec(`ALTER TABLE metrics ADD COLUMN reason_tokens INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("verified")) this.db.exec(`ALTER TABLE metrics ADD COLUMN verified INTEGER`);
    const cardCols = this.db.prepare(`SELECT name FROM pragma_table_info('cards')`).all();
    if (!cardCols.some((c) => c.name === "deps_json")) {
      this.db.exec(`ALTER TABLE cards ADD COLUMN deps_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!cardCols.some((c) => c.name === "budget")) {
      this.db.exec(`ALTER TABLE cards ADD COLUMN budget REAL`);
    }
    const exCols = this.db.prepare(`SELECT name FROM pragma_table_info('executions')`).all();
    if (!exCols.some((c) => c.name === "worktree_path")) {
      this.db.exec(`ALTER TABLE executions ADD COLUMN worktree_path TEXT`);
      this.db.exec(`ALTER TABLE executions ADD COLUMN worktree_branch TEXT`);
    }
    // WikiSkill 启示：知识条目补反模式 + 适用条件（老库 ALTER 迁移）
    const kbCols = this.db.prepare(`SELECT name FROM pragma_table_info('kb_notes')`).all();
    const kbHave = new Set(kbCols.map((c) => c.name));
    if (!kbHave.has("anti_patterns_json")) {
      this.db.exec(`ALTER TABLE kb_notes ADD COLUMN anti_patterns_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!kbHave.has("applicability")) {
      this.db.exec(`ALTER TABLE kb_notes ADD COLUMN applicability TEXT NOT NULL DEFAULT ''`);
    }
  }
  // ---------- 项目 ----------
  upsertProject(id, name, path, configJson) {
    const t = now();
    this.db.prepare(
      `INSERT INTO projects (id, name, path, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, updated_at=excluded.updated_at`
    ).run(id, name, path, configJson, t, t);
  }
  loadProjects() {
    return this.db.prepare("SELECT id, name, path, config_json, archived FROM projects WHERE archived = 0 ORDER BY updated_at DESC").all().map((r) => rowToProjectMeta(r));
  }
  archiveProject(id) {
    this.db.prepare("UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?").run(now(), id);
  }
  unarchiveProject(id) {
    this.db.prepare("UPDATE projects SET archived = 0, updated_at = ? WHERE id = ?").run(now(), id);
  }
  purgeProject(id) {
    for (const table of ["approvals", "metrics", "policies", "kb_notes", "profiles", "chat_sessions", "cards"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
    }
    this.db.prepare("DELETE FROM executions WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?)").run(id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
  markDeleted(id) {
    this.db.prepare("INSERT OR REPLACE INTO deleted_projects (id, deleted_at) VALUES (?, ?)").run(id, now());
  }
  isDeleted(id) {
    return this.db.prepare("SELECT 1 FROM deleted_projects WHERE id = ?").get(id) !== void 0;
  }
  projectExists(id) {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !== void 0;
  }
  findArchivedProject(path) {
    const row = this.db.prepare("SELECT id, name, path, config_json, archived FROM projects WHERE archived = 1 AND path = ?").get(path);
    return row ? rowToProjectMeta(row) : void 0;
  }
  deleteProject(id) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
  // ---------- 卡片快照 ----------
  upsertCard(c) {
    const t = now();
    this.db.prepare(
      `INSERT INTO cards (id, project_id, title, description, kind, milestone, criteria_json, deps_json, budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, description=excluded.description, kind=excluded.kind,
           milestone=excluded.milestone, criteria_json=excluded.criteria_json,
           deps_json=excluded.deps_json, budget=excluded.budget, updated_at=excluded.updated_at`
    ).run(c.id, c.project_id, c.title, c.description, c.kind, c.milestone, c.criteria ?? "[]", JSON.stringify(c.deps ?? []), c.budget ?? null, c.created_at, t);
  }
  loadCards(projectId) {
    return this.db.prepare("SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, budget, created_at FROM cards WHERE project_id = ? ORDER BY created_at DESC").all(projectId).map((r) => rowToCard(r));
  }
  loadAllCards() {
    return this.db.prepare("SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, budget, created_at FROM cards").all().map((r) => rowToCard(r));
  }
  getCard(id) {
    const row = this.db.prepare("SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, budget, created_at FROM cards WHERE id = ?").get(id);
    return row ? rowToCard(row) : void 0;
  }
  // ---------- 执行快照 ----------
  upsertExecution(e) {
    const t = now();
    this.db.prepare(
      `INSERT INTO executions (id, card_id, session_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           card_id=excluded.card_id, session_id=excluded.session_id, status=excluded.status,
           preset_json=excluded.preset_json, deps_json=excluded.deps_json,
           forked_from=excluded.forked_from, started_at=excluded.started_at,
           finished_at=excluded.finished_at, updated_at=excluded.updated_at`
    ).run(e.id, e.card_id, e.id, e.status, e.preset_json, e.deps_json, e.forked_from, e.started_at, e.finished_at, e.created_at, t);
  }
  loadExecutions(cardId) {
    return this.db.prepare(
      "SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, worktree_path, worktree_branch FROM executions WHERE card_id = ? ORDER BY created_at"
    ).all(cardId).map((r) => rowToExecution(r));
  }
  loadAllExecutions() {
    return this.db.prepare(
      "SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, worktree_path, worktree_branch FROM executions"
    ).all().map((r) => rowToExecution(r));
  }
  getExecutionBySession(sessionId) {
    const row = this.db.prepare(
      "SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, worktree_path, worktree_branch FROM executions WHERE session_id = ?"
    ).get(sessionId);
    return row ? rowToExecution(row) : void 0;
  }
  setExecutionWorktree(id, path, branch) {
    this.db.prepare("UPDATE executions SET worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?").run(path, branch, now(), id);
  }
  // ---------- 设置 ----------
  setConfig(projectId, key, value) {
    this.db.prepare(
      "INSERT INTO settings (project_id, key, value) VALUES (?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value=excluded.value"
    ).run(projectId, key, value);
  }
  getConfig(projectId, key) {
    const row = this.db.prepare("SELECT value FROM settings WHERE project_id = ? AND key = ?").get(projectId, key);
    return row?.value;
  }
  projectConfig(id) {
    const row = this.db.prepare("SELECT config_json FROM projects WHERE id = ?").get(id);
    return row?.config_json;
  }
  // ---------- 知识库（M4） ----------
  upsertNote(n) {
    const t = Date.now();
    this.db.prepare(
      `INSERT INTO kb_notes (id, project_id, title, content_json, tags_json, keywords_json, summary,
           anti_patterns_json, applicability, links_json, source_kind, source_ref, valid_from, valid_until, invalidated_by, version, trust, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, content_json=excluded.content_json, tags_json=excluded.tags_json,
           keywords_json=excluded.keywords_json, summary=excluded.summary,
           anti_patterns_json=excluded.anti_patterns_json, applicability=excluded.applicability,
           links_json=excluded.links_json,
           valid_until=excluded.valid_until, invalidated_by=excluded.invalidated_by,
           version=excluded.version, trust=excluded.trust, updated_at=excluded.updated_at`
    ).run(
      n.id,
      n.project_id,
      n.title,
      JSON.stringify(n.content),
      JSON.stringify(n.tags),
      JSON.stringify(n.keywords),
      n.summary,
      JSON.stringify(n.antiPatterns ?? []),
      n.applicability ?? '',
      JSON.stringify(n.links),
      n.source.kind,
      n.source.ref,
      n.validFrom,
      n.validUntil ?? null,
      n.invalidatedBy ?? null,
      n.version,
      n.trust,
      n.createdAt,
      t
    );
  }
  /** 当前有效的笔记（双时态过滤）。 */
  listNotes(projectId) {
    const rows = this.db.prepare("SELECT * FROM kb_notes WHERE project_id = ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY created_at DESC").all(projectId, Date.now());
    return rows.map(rowToNote);
  }
  /** 全部笔记（含失效，审计/演化用）。 */
  listAllNotes(projectId) {
    const rows = this.db.prepare("SELECT * FROM kb_notes WHERE project_id = ? ORDER BY created_at DESC").all(projectId);
    return rows.map(rowToNote);
  }
  getNote(id) {
    const row = this.db.prepare("SELECT * FROM kb_notes WHERE id = ?").get(id);
    return row ? rowToNote(row) : void 0;
  }
  /** 边失效：把 id 标记为被 newNoteId 推翻。 */
  invalidateNote(id, newNoteId, at) {
    this.db.prepare("UPDATE kb_notes SET valid_until = ?, invalidated_by = ?, updated_at = ? WHERE id = ? AND valid_until IS NULL").run(at, newNoteId, at, id);
  }
  deleteNote(id) {
    this.db.prepare("DELETE FROM kb_notes WHERE id = ?").run(id);
  }
  // ---------- 度量（M4 §5.2） ----------
  insertMetric(m) {
    this.db.prepare(
      `INSERT INTO metrics (project_id, task_id, brief_snapshot_json, outcome, cited_entries_json, turns, steps, group_tag, verified, cost, cache_hit, in_tokens, cache_tokens, out_tokens, reason_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      m.project_id,
      m.task_id,
      JSON.stringify(m.brief_snapshot),
      m.outcome,
      JSON.stringify(m.cited_entries),
      m.turns,
      m.steps,
      m.group_tag ?? null,
      m.verified === void 0 ? null : m.verified ? 1 : 0,
      m.cost,
      m.cache_hit,
      m.in_tokens,
      m.cache_tokens,
      m.out_tokens,
      m.reason_tokens,
      m.created_at
    );
  }
  listMetrics(projectId) {
    const rows = this.db.prepare("SELECT * FROM metrics WHERE project_id = ? ORDER BY created_at DESC LIMIT 200").all(projectId);
    return rows.map(rowToMetric);
  }
  // ---------- 批复队列（P0：一等表面 + 唯一事实来源） ----------
  insertApproval(a) {
    const info = this.db.prepare(
      `INSERT INTO approvals (project_id, execution_id, kind, payload_json, reason, outcome, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(a.project_id, a.execution_id, a.kind, JSON.stringify(a.payload), a.reason ?? null, a.outcome ?? null, a.comment ?? null, a.created_at);
    return Number(info.lastInsertRowid);
  }
  /** 待批复队列（按项目；含等待原因与挂起标记）。 */
  listSuspendedApprovals(projectId) {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE project_id = ? AND outcome = 'suspended' ORDER BY suspended_at").all(projectId);
    return rows.map(rowToApproval);
  }
  /** 恢复挂起批复（O5：原会话从 Waiting 点继续，模式不丢） */
  resumeApproval(id) {
    const info = this.db.prepare("UPDATE approvals SET outcome = NULL, decided_at = NULL, suspended_at = NULL WHERE id = ? AND outcome = ?").run(id, "suspended");
    return info.changes > 0;
  }
  /** 批量恢复（O5：恢复 = 全部挂起项重新进队列） */
  resumeAllApprovals(projectId) {
    const info = this.db.prepare("UPDATE approvals SET outcome = NULL, decided_at = NULL, suspended_at = NULL WHERE project_id = ? AND outcome = ?").run(projectId, "suspended");
    return info.changes;
  }
  listPendingApprovals(projectId) {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE project_id = ? AND outcome IS NULL ORDER BY created_at").all(projectId);
    return rows.map(rowToApproval);
  }
  /** 全量批复（含已决策，审计）。 */
  listApprovals(projectId, limit = 100) {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit);
    return rows.map(rowToApproval);
  }
  getApproval(id) {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? rowToApproval(row) : void 0;
  }
  /** 决策批复：approve/reject + 评论；返回是否成功（已决策的不再改）。 */
  decideApproval(id, outcome, comment) {
    const info = this.db.prepare(
      `UPDATE approvals SET outcome = ?, comment = ?, decided_at = ? WHERE id = ? AND outcome IS NULL`
    ).run(outcome, comment, Date.now(), id);
    return info.changes > 0;
  }
  /** 挂起：超时自动挂起（O5：默认 30 分钟，危险操作永不自动放行）。 */
  suspendApproval(id) {
    const info = this.db.prepare("UPDATE approvals SET outcome = ?, suspended_at = ? WHERE id = ? AND outcome IS NULL").run("suspended", Date.now(), id);
    return info.changes > 0;
  }
  // ---------- 策略学习（P1 O6：批复 → 策略原子，规则可查看可删除） ----------
  /** 学习一条策略：同 (kind, scope, outcome) 累计 count；返回最新规则。 */
  learnPolicy(projectId, kind, scope, outcome) {
    const t = Date.now();
    this.db.prepare(
      `INSERT INTO policies (project_id, kind, scope, outcome, count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(project_id, kind, scope, outcome) DO UPDATE SET
           count = count + 1, updated_at = excluded.updated_at`
    ).run(projectId, kind, scope, outcome, t, t);
    return this.getPolicy(projectId, kind, scope, outcome);
  }
  getPolicy(projectId, kind, scope, outcome) {
    const row = this.db.prepare("SELECT * FROM policies WHERE project_id = ? AND kind = ? AND scope = ? AND outcome = ?").get(projectId, kind, scope, outcome);
    return row ? rowToPolicy(row) : void 0;
  }
  listPolicies(projectId) {
    const rows = this.db.prepare("SELECT * FROM policies WHERE project_id = ? ORDER BY updated_at DESC").all(projectId);
    return rows.map(rowToPolicy);
  }
  deletePolicy(id) {
    const info = this.db.prepare("DELETE FROM policies WHERE id = ?").run(id);
    return info.changes > 0;
  }
  // ---------- 简单会话（A 组：chat 持久化标记） ----------
  registerChat(sessionId, projectId) {
    this.db.prepare("INSERT OR IGNORE INTO chat_sessions (session_id, project_id, created_at) VALUES (?, ?, ?)").run(sessionId, projectId, Date.now());
  }
  isChat(sessionId) {
    return !!this.db.prepare("SELECT 1 FROM chat_sessions WHERE session_id = ?").get(sessionId);
  }
  /** 提升为任务后删除 chat 标记（会话转卡执行） */
  unregisterChat(sessionId) {
    this.db.prepare("DELETE FROM chat_sessions WHERE session_id = ?").run(sessionId);
  }
  listChats(projectId) {
    const rows = this.db.prepare("SELECT session_id FROM chat_sessions WHERE project_id = ?").all(projectId);
    return rows.map((r) => r.session_id);
  }
  // ---------- 预设 Profile（P0 §2.6） ----------
  /** 种子内置 4 个 Profile（幂等）；首个成为项目默认。返回是否首次种子。 */
  seedProfiles(projectId) {
    const existing = this.db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE project_id = ?").get(projectId);
    if (existing.n > 0) return false;
    const t = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO profiles (id, project_id, name, is_builtin, mode, setting, approval, sandbox, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    BUILTIN_PROFILES.forEach((p, i) => {
      insert.run(p.id, projectId, p.name, 1, p.mode, p.setting, p.approval, p.sandbox, i === 0 ? 1 : 0, t, t);
    });
    return true;
  }
  listProfiles(projectId) {
    const rows = this.db.prepare("SELECT * FROM profiles WHERE project_id = ? ORDER BY is_default DESC, is_builtin DESC, created_at").all(projectId);
    return rows.map(rowToProfile);
  }
  getProfile(projectId, id) {
    const row = this.db.prepare("SELECT * FROM profiles WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? rowToProfile(row) : void 0;
  }
  defaultProfile(projectId) {
    const row = this.db.prepare("SELECT * FROM profiles WHERE project_id = ? AND is_default = 1").get(projectId);
    return row ? rowToProfile(row) : void 0;
  }
  /** 自定义 Profile（复制现有改三轴）；内置不可直接覆盖。 */
  upsertProfile(projectId, p) {
    const t = Date.now();
    this.db.prepare(
      `INSERT INTO profiles (id, project_id, name, is_builtin, mode, setting, approval, sandbox, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, id) DO UPDATE SET
           name=excluded.name, mode=excluded.mode, setting=excluded.setting,
           approval=excluded.approval, sandbox=excluded.sandbox, updated_at=excluded.updated_at
           WHERE profiles.is_builtin = 0`
    ).run(p.id, projectId, p.name, p.is_builtin ? 1 : 0, p.mode, p.setting, p.approval, p.sandbox, p.is_default ? 1 : 0, t, t);
  }
  /** 设项目默认（清旧默认，设新默认）。 */
  setDefaultProfile(projectId, id) {
    const p = this.getProfile(projectId, id);
    if (!p) return false;
    this.db.prepare("UPDATE profiles SET is_default = 0 WHERE project_id = ?").run(projectId);
    this.db.prepare("UPDATE profiles SET is_default = 1 WHERE project_id = ? AND id = ?").run(projectId, id);
    return true;
  }
  removeProfile(projectId, id) {
    const p = this.getProfile(projectId, id);
    if (!p || p.is_builtin) return false;
    const wasDefault = p.is_default;
    const info = this.db.prepare("DELETE FROM profiles WHERE project_id = ? AND id = ?").run(projectId, id);
    if (info.changes === 0) return false;
    if (wasDefault) {
      const rest = this.listProfiles(projectId);
      const next = rest.find((x) => x.id === BUILTIN_PROFILES[0].id) ?? rest.find((x) => x.is_builtin) ?? rest[0];
      if (next) this.setDefaultProfile(projectId, next.id);
    }
    return true;
  }
  close() {
    this.db.close();
  }
}
function rowToProjectMeta(r) {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    config_json: r.config_json,
    archived: r.archived !== 0
  };
}
function rowToCard(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    description: r.description ?? "",
    kind: r.kind ?? "task",
    milestone: r.milestone ?? null,
    criteria: r.criteria_json && r.criteria_json !== "[]" ? r.criteria_json : null,
    deps: parseIdArray(r.deps_json),
    budget: r.budget == null ? null : r.budget,
    created_at: r.created_at
  };
}
function parseIdArray(json) {
  if (typeof json !== "string") return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function rowToExecution(r) {
  return {
    id: r.id,
    card_id: r.card_id,
    status: r.status,
    preset_json: r.preset_json ?? "{}",
    deps_json: r.deps_json ?? "[]",
    forked_from: r.forked_from ?? null,
    started_at: r.started_at ?? null,
    finished_at: r.finished_at ?? null,
    created_at: r.created_at,
    worktree_path: r.worktree_path ?? null,
    worktree_branch: r.worktree_branch ?? null
  };
}
function rowToNote(r) {
  const parse = (s) => {
    if (typeof s !== "string") return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    content: parse(r.content_json),
    tags: parse(r.tags_json),
    keywords: parse(r.keywords_json),
    summary: r.summary ?? "",
    antiPatterns: parse(r.anti_patterns_json),
    applicability: r.applicability ?? "",
    links: parse(r.links_json),
    source: { kind: r.source_kind, ref: r.source_ref },
    validFrom: r.valid_from,
    validUntil: r.valid_until ?? null,
    invalidatedBy: r.invalidated_by ?? void 0,
    version: r.version ?? 1,
    trust: r.trust ?? "unverified",
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
function rowToMetric(r) {
  const parseArr = (s) => {
    if (typeof s !== "string") return [];
    try {
      return JSON.parse(s);
    } catch {
      return [];
    }
  };
  const parseCited = (s) => {
    if (typeof s !== "string") return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    project_id: r.project_id,
    task_id: r.task_id,
    brief_snapshot: parseArr(r.brief_snapshot_json),
    outcome: r.outcome ?? "",
    cited_entries: parseCited(r.cited_entries_json),
    turns: r.turns ?? 0,
    steps: r.steps ?? 0,
    group_tag: r.group_tag ?? void 0,
    verified: r.verified === void 0 || r.verified === null ? void 0 : r.verified !== 0,
    cost: r.cost ?? 0,
    cache_hit: r.cache_hit ?? 0,
    in_tokens: r.in_tokens ?? 0,
    cache_tokens: r.cache_tokens ?? 0,
    out_tokens: r.out_tokens ?? 0,
    reason_tokens: r.reason_tokens ?? 0,
    created_at: r.created_at
  };
}
function rowToApproval(r) {
  let payload = {};
  try {
    payload = JSON.parse(r.payload_json ?? "{}");
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    project_id: r.project_id,
    execution_id: r.execution_id,
    kind: r.kind,
    payload,
    reason: r.reason ?? null,
    outcome: r.outcome ?? null,
    comment: r.comment ?? null,
    created_at: r.created_at,
    decided_at: r.decided_at ?? null,
    suspended_at: r.suspended_at ?? null
  };
}
const BUILTIN_PROFILES = [
  { id: "standard", name: "\u6807\u51C6", is_builtin: true, mode: "normal", setting: "balanced", approval: "ask", sandbox: "workspace-write" },
  { id: "cautious", name: "\u8C28\u614E", is_builtin: true, mode: "plan", setting: "balanced", approval: "ask", sandbox: "read-only" },
  { id: "surfing", name: "\u51B2\u6D6A", is_builtin: true, mode: "normal", setting: "light", approval: "auto", sandbox: "workspace-write" },
  { id: "delivery", name: "\u4EA4\u4ED8", is_builtin: true, mode: "normal", setting: "delivery", approval: "auto", sandbox: "workspace-write" }
];
function rowToProfile(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    is_builtin: r.is_builtin !== 0,
    mode: r.mode,
    setting: r.setting,
    approval: r.approval,
    sandbox: r.sandbox,
    is_default: r.is_default !== 0,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}
function rowToPolicy(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    kind: r.kind,
    scope: r.scope,
    outcome: r.outcome,
    count: r.count,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}
function policySuggestion(storage, projectId, kind, cardKind) {
  const scopes = [cardKind || "task", "global"];
  let best = null;
  for (const scope of scopes) {
    for (const outcome of ["approved", "rejected"]) {
      const p = storage.getPolicy(projectId, kind, scope, outcome);
      if (p && p.count >= 2 && (!best || p.count > best.count)) {
        best = { scope: p.scope, outcome: p.outcome, count: p.count };
      }
    }
  }
  return best;
}
export {
  BUILTIN_PROFILES,
  Storage,
  parseIdArray,
  policySuggestion
};
