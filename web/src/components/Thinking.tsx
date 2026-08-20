// 职责：思考折叠（Beautiful UI「Thinking」移植，MIT © Shane Levine）——
//   展开式轨迹：shimmer「思考中…」标题 + 左引导线轨迹列表 + 分页签（全部/推理/工具/文本）。
//   运行中默认展开（defaultOpen ?? running），live 标题走 shimmer 文字动画；折叠用 grid-rows 过渡。
import { useMemo, useState, type ReactNode } from 'react';

export type ThinkRowKind = 'think' | 'tool' | 'text';

export interface ThinkRow {
  id: string | number;
  kind: ThinkRowKind;
  /** think/text 行的内容 */
  text?: string;
  /** tool 行：工具名 */
  name?: string;
  /** tool 行：参数（展开显示，mono 截断） */
  args?: string;
  err?: boolean;
  /** tool 行耗时 / 自定义右侧信息 */
  ms?: number;
  meta?: string;
}

const TABS = [
  { id: 'all', label: '全部' },
  { id: 'think', label: '推理' },
  { id: 'tool', label: '工具' },
  { id: 'text', label: '文本' },
] as const;
type TabId = (typeof TABS)[number]['id'];

interface Props {
  rows: ThinkRow[];
  /** 运行中：标题走 shimmer + 默认展开 */
  running?: boolean;
  label?: string;
  defaultOpen?: boolean;
  /** 展开区补充内容（如流式尾巴） */
  children?: ReactNode;
}

export function Thinking({ rows, running = false, label, defaultOpen, children }: Props) {
  const [open, setOpen] = useState(defaultOpen ?? running);
  const [tab, setTab] = useState<TabId>('all');

  const kinds = useMemo(() => {
    const s = new Set<ThinkRowKind>();
    rows.forEach((r) => s.add(r.kind));
    return s;
  }, [rows]);

  const shown = tab === 'all' ? rows : rows.filter((r) => r.kind === tab);
  const text = label ?? (running ? '思考中…' : '思考过程');

  return (
    <div className={'think' + (open ? ' open' : '')}>
      <button
        type="button"
        className="think-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="spark" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.2 9.6 6l4.8 1.6-4.8 1.6L8 14l-1.6-4.8L1.6 7.6 6.4 6z" />
        </svg>
        <span className={'think-label' + (running ? ' live' : '')}>{text}</span>
        {rows.length > 0 ? <span className="think-count">{rows.length}</span> : null}
        <svg
          className="think-chev"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div className="think-body">
        <div className="think-body-inner">
          <div className="think-trace">
            {shown.map((r) => (
              <div key={r.id} className="think-row" data-kind={r.kind}>
                <span className="tdot" />
                {r.kind === 'tool' ? (
                  <>
                    <span className="tname">{r.name}</span>
                    <span className={r.err ? 'err' : 'ok'}>{r.err ? '失败' : '成功'}</span>
                    {r.ms != null ? <span className="tmeta">{r.ms} ms</span> : null}
                  </>
                ) : (
                  <span className="ttxt" title={r.text}>{r.text}</span>
                )}
                {r.meta ? <span className="tmeta">{r.meta}</span> : null}
                {r.kind === 'tool' && r.args ? <div className="targs">{r.args}</div> : null}
              </div>
            ))}
            {children}
            {rows.length === 0 && !children ? <div className="think-empty">（空）</div> : null}
          </div>
          {kinds.size > 1 ? (
            <div className="think-tabs">
              {TABS.filter((t) => t.id === 'all' || kinds.has(t.id as ThinkRowKind)).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={'think-tab' + (tab === t.id ? ' active' : '')}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
