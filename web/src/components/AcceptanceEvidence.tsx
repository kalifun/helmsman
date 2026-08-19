// 职责：便宜验收证据 —— git 改动快照 + 验收命令结果。批复队列与抽屉共用。
export function AcceptanceEvidence({ payload }: { payload: Record<string, unknown> }) {
  const criteria = typeof payload.criteria === 'string' && payload.criteria.trim() ? payload.criteria : null
  const verify = asVerify(payload.verify)
  const diff = asDiff(payload.diff)
  if (!criteria && !verify && !diff) return null

  const verdict = verify?.verified === true
    ? 'pass'
    : verify?.verified === false
      ? 'fail'
      : verify
        ? 'skip'
        : null

  return (
    <div className="ev-block">
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
          {diff.files.length > 0 ? (
            <ul className="ev-files">
              {diff.files.map((f) => <li key={f}>{f}</li>)}
            </ul>
          ) : null}
          {diff.stat ? <pre className="ev-pre">{diff.stat}</pre> : null}
        </div>
      ) : null}
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
