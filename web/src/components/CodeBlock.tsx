// 职责：代码块（Beautiful UI「Code Block」移植，MIT © Shane Levine）——
//   带行号的 listing；若内容是 unified diff（或 fence 语言为 diff）可切 Code / Diff。
//   纯展示；复制走 clipboard，失败由调用方 toast（onCopyError）。
import { useEffect, useMemo, useRef, useState } from 'react';

export type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export function parseFenceInfo(info: string): { lang: string; filename?: string } {
  const s = info.trim();
  if (!s) return { lang: '' };
  const named = /^([\w+-]+)[:\s]+(.+)$/.exec(s);
  if (named) return { lang: named[1], filename: named[2] };
  if (s.includes('/') || (s.includes('.') && !/^(tsx|jsx|css|html|diff|toml|yaml|yml|json|bash)$/i.test(s))) {
    const ext = s.split('.').pop() || '';
    return { lang: ext, filename: s };
  }
  return { lang: s };
}

export function looksLikeDiff(src: string): boolean {
  return /^(diff --git |@@ |\+\+\+ )/m.test(src);
}

export function parseUnifiedDiff(src: string): { lines: DiffLine[]; filename?: string } {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let filename: string | undefined;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      out.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('--- ')) {
      filename = line.slice(4).replace(/^[ab]\//, '');
      out.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+++ ')) {
      const f = line.slice(4).replace(/^[ab]\//, '');
      if (f !== '/dev/null') filename = f;
      out.push({ kind: 'meta', text: line });
      continue;
    }
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
      continue;
    }
    if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
      continue;
    }
    if (line.startsWith('\\')) {
      out.push({ kind: 'meta', text: line });
      continue;
    }
    const text = line.startsWith(' ') ? line.slice(1) : line;
    out.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
  }
  return { lines: out, filename };
}

interface Props {
  code: string;
  info?: string;
  onCopyError?: () => void;
}

export function CodeBlock({ code, info = '', onCopyError }: Props) {
  const { lang, filename: infoName } = useMemo(() => parseFenceInfo(info), [info]);
  const isDiff = lang.toLowerCase() === 'diff' || looksLikeDiff(code);
  const parsed = useMemo(() => (isDiff ? parseUnifiedDiff(code) : null), [isDiff, code]);
  const filename = infoName || parsed?.filename;
  const [view, setView] = useState<'code' | 'diff'>(isDiff ? 'diff' : 'code');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => { if (timerRef.current != null) window.clearTimeout(timerRef.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      onCopyError?.();
    }
  };

  const listing = code.replace(/\n$/, '').split('\n');
  const showToggle = isDiff;

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-file">{filename || lang || 'code'}</span>
        <span className="codeblock-actions">
          {showToggle ? (
            <span className="codeblock-tabs">
              <button type="button" className={view === 'code' ? 'on' : ''} onClick={() => setView('code')}>Code</button>
              <button type="button" className={view === 'diff' ? 'on' : ''} onClick={() => setView('diff')}>Diff</button>
            </span>
          ) : null}
          <button type="button" className={'codeblock-copy' + (copied ? ' on' : '')} onClick={() => void copy()}>
            {copied ? '已复制' : '复制'}
          </button>
        </span>
      </div>
      {view === 'diff' && parsed ? (
        <div className="codeblock-body" role="table">
          {parsed.lines.map((ln, i) => (
            <div key={i} className={'codeblock-line ' + ln.kind}>
              <span className="n old">{ln.oldNo ?? ''}</span>
              <span className="n new">{ln.newNo ?? ''}</span>
              <span className="pref">{ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ln.kind === 'hunk' ? '@' : ' '}</span>
              <span className="tx">{ln.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="codeblock-body" role="table">
          {listing.map((ln, i) => (
            <div key={i} className="codeblock-line ctx">
              <span className="n">{i + 1}</span>
              <span className="tx">{ln}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
