// 职责：知识块卡（Beautiful UI「Context Cards」移植，MIT © Shane Levine）——
//   标题栏（列表 icon + 标题 + 字符数）+ 内容摘要（默认 3 行截断）+ 来源 chip（扩展名/来源类型着色）+ 相关度/徽标。
// 来源色：pdf→红 / csv→绿 / md·task→蓝 / human→绿 / chat→灰；走既有语义 token（--red/--green/--blue/--gray）。
export type ChunkBadgeTone = 'ok' | 'info' | 'warn' | 'muted';

export interface ChunkBadge {
  label: string;
  tone: ChunkBadgeTone;
}

export interface ContextChunk {
  id: string | number;
  title: string;
  content?: string;
  /** 字符数（显示在标题栏右侧；不传则不显示） */
  chars?: number;
  sourceKind?: string;
  sourceRef?: string;
  /** 相关度 0-1（显示为百分比） */
  score?: number;
  badges?: ChunkBadge[];
  /** 内容是否 3 行截断（默认 true） */
  clamp?: boolean;
}

const KIND_EXT: Record<string, { label: string; cls: string }> = {
  pdf: { label: 'PDF', cls: 'pdf' },
  csv: { label: 'CSV', cls: 'csv' },
  md: { label: 'MD', cls: 'md' },
  markdown: { label: 'MD', cls: 'md' },
  task: { label: '任务', cls: 'task' },
  human: { label: '人工', cls: 'human' },
  chat: { label: '会话', cls: 'chat' },
};

const BADGE_TONE: Record<ChunkBadgeTone, string> = {
  ok: 'human-approved',   // 绿
  info: 'agent-generated', // 蓝
  warn: 'unverified',     // 灰
  muted: 'unverified',
};

export interface ContextCardsProps {
  chunks: ContextChunk[];
  title?: string;
  /** 头部计数文案；缺省显示 chunks.length */
  countLabel?: string;
  empty?: string;
}

export function ContextCards({ chunks, title = '知识块', countLabel, empty }: ContextCardsProps) {
  return (
    <div className="ctx">
      <div className="ctx-head">
        <span className="t">{title}</span>
        <span className="ctx-count">{countLabel ?? chunks.length}</span>
      </div>
      {chunks.length === 0 && empty ? <div className="ph-empty">{empty}</div> : null}
      {chunks.map((c) => {
        const ext = c.sourceKind ? KIND_EXT[c.sourceKind.toLowerCase()] : undefined;
        return (
          <div key={c.id} className="ctx-card">
            <div className="ctx-bar">
              <svg className="bar-ic" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h7" />
              </svg>
              <span className="bt" title={c.title}>{c.title}</span>
              {c.chars != null ? <span className="bc">{c.chars.toLocaleString()} 字符</span> : null}
            </div>
            {c.content ? <div className={'ctx-body' + (c.clamp === false ? '' : ' clamp')}>{c.content}</div> : null}
            <div className="ctx-foot">
              {ext || c.sourceRef ? (
                <span className="ctx-src" title={c.sourceRef}>
                  {ext ? <span className={'ext ' + ext.cls}>{ext.label}</span> : null}
                  {c.sourceRef ? <span className="ref">{c.sourceRef}</span> : null}
                </span>
              ) : null}
              {c.badges && c.badges.length > 0 ? (
                <span className="ctx-badges">
                  {c.badges.map((b) => (
                    <span key={b.label} className={'trust ' + BADGE_TONE[b.tone]}>{b.label}</span>
                  ))}
                </span>
              ) : null}
              {c.score != null ? <span className="ctx-score">{Math.round(c.score * 100)}%</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
