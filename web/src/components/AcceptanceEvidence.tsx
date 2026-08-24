// 职责：便宜验收证据 —— git 改动快照 + 验收命令结果。批复队列与抽屉共用。
// diff.stat（git diff --stat）解析为 DiffTable（Beautiful UI 移植）：文件 | 行数 | +增 | -删。
import { DiffTable, parseDiffStat } from './DiffTable'
export function AcceptanceEvidence({ payload }: { payload: Record<string, unknown> }) {
  const criteria = typeof payload.criteria === 'string' && payload.criteria.trim() ? payload.criteria : null
  const verify = asVerify(payload.verify)
  const diff = asDiff(payload.diff)
  const worktree = asWorktree(payload.worktree)
  const mergeErr = payload.merge && typeof payload.merge === 'object'
    ? String((payload.merge as { error?: unknown }).error ?? '')
    : ''
  if (!criteria && !verify && !diff && !worktree && !mergeErr) return null

  const verdict = verify?.verified === true
    ? 'pass'
    : verify?.verified === false
      ? 'fail'
      : verify
        ? 'skip'
        : null

  return (
    <div className="ev-block">
      {worktree ? (
        <div className="ev-section">
          <div className="ev-head">
            <span>隔离工作区</span>
            <span className="tag">{worktree.branch}</span>
          </div>
          <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)' }}>{worktree.path}</div>
        </div>
      ) : null}
      {mergeErr ? <div className="ev-err">{mergeErr}</div> : null}
      {verify || criteria ? (
        <div className="ev-section">
          <div className="ev-head">
            <span>验收命令</span>
            {verdict === 'pass' ? <span className="tag ev-pass">通过</span> : null}
            {verdict === 'fail' ? <span className="tag ev-fail">未通过</span> : null}
            {verdict === 'skip' ? <span className="tag">未判定</span> : null}
            {verify && verify.durationMs >= 0 ? <span className="muted">{verify.durationMs}ms</span> : null}
            {verify?.exitCode != null ? <span className="muted">exit {verify.exitCode}</span> : null}
          </div>
          {criteria ? <pre className="ev-pre">{criteria}</pre> : null}
          {verify?.error ? <div className="ev-err">{verify.error}</div> : null}
          {verify?.outputTail ? (
            <details className="appr-plan">
              <summary>命令输出（末尾）</summary>
              <pre className="ev-pre">{verify.outputTail}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {diff ? (
        <div className="ev-section">
          <div className="ev-head">
            <span>工作区改动</span>
            {diff.error ? <span className="tag ev-fail">无法取 diff</span> : null}
            {!diff.error && diff.dirty ? <span className="tag">{diff.files.length} 个文件</span> : null}
            {!diff.error && !diff.dirty ? <span className="tag ev-pass">干净</span> : null}
          </div>
          {diff.error ? <div className="ev-err">{diff.error}</div> : null}
          {!diff.error && diff.stat ? renderDiffStat(diff.stat) : null}
          {!diff.error && diff.files.length > 0 ? (
            <ul className="ev-files">
              {diff.files.map((f) => <li key={f}>{f}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** diffstat → DiffTable（解析失败回退原始文本） */
function renderDiffStat(stat: string) {
  const parsed = parseDiffStat(stat)
  if (parsed.rows.length === 0) return <pre className="ev-pre">{stat}</pre>
  return (
    <div style={{ marginTop: 8 }}>
      <DiffTable
        columns={[
          { key: 'file', label: '文件', width: '52%' },
          { key: 'count', label: '行数', width: '16%' },
          { key: 'add', label: '+ 增', width: '16%' },
          { key: 'del', label: '- 删', width: '16%' },
        ]}
        rows={parsed.rows}
        footer={parsed.footer}
      />
    </div>
  )
}

function asVerify(v: unknown): {
  verified: boolean | null
  exitCode: number | null
  durationMs: number
  outputTail: string
  error?: string
} | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!('verified' in o) && !('outputTail' in o)) return null
  return {
    verified: o.verified === true ? true : o.verified === false ? false : null,
    exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0,
    outputTail: typeof o.outputTail === 'string' ? o.outputTail : '',
    error: typeof o.error === 'string' ? o.error : undefined,
  }
}

function asWorktree(v: unknown): { path: string; branch: string } | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.branch !== 'string' || typeof o.path !== 'string') return null
  return { path: o.path, branch: o.branch }
}

function asDiff(v: unknown): {
  dirty: boolean
  files: string[]
  stat: string
  error?: string
} | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.files) && typeof o.stat !== 'string') return null
  return {
    dirty: o.dirty === true,
    files: Array.isArray(o.files) ? o.files.filter((x): x is string => typeof x === 'string') : [],
    stat: typeof o.stat === 'string' ? o.stat : '',
    error: typeof o.error === 'string' ? o.error : undefined,
  }
}
