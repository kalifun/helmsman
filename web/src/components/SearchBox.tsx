// 职责：命令搜索（Beautiful UI「Search」移植，MIT © Shane Levine）——
//   输入行（icon + placeholder）+ 结果列表（实时过滤）+ 滑动高亮条（glide）+ 键盘导航（↑↓/Enter）+ 空状态。
//   纯客户端过滤：调用方给 items + filter，组件持有 query 与高亮状态。
import { useRef, useState } from 'react';

export interface SearchItem {
  id: string | number;
  title: string;
  sub?: string;
  onSelect?: () => void;
}

interface Props {
  placeholder?: string;
  /** 菜单模式（默认）需要；bare 模式可不传 */
  items?: SearchItem[];
  filter?: (item: SearchItem, q: string) => boolean;
  emptyText?: string;
  /** 受控模式：外部持有 query（列表过滤需要同步） */
  value?: string;
  onValue?: (q: string) => void;
  /** bare = 纯输入框（不渲染结果列表，结果由调用方在下方列表呈现，完全复用现有渲染） */
  bare?: boolean;
}

export function SearchBox({ placeholder = '搜索…', items = [], filter = () => true, emptyText = '无匹配', value, onValue, bare = false }: Props) {
  const [q0, setQ0] = useState('');
  const [active, setActive] = useState(-1);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);
  const rowsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const q = value ?? q0;
  const setQ = (v: string) => {
    if (onValue) onValue(v);
    else setQ0(v);
  };

  const shown = q.trim() ? items.filter((it) => filter(it, q.trim())) : items;

  // bare 模式：只有输入行，键盘导航/结果列表全部由调用方负责
  if (bare) {
    return (
      <div className="searchbox">
        <div className="searchbox-input">
          <svg className="sic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
          />
        </div>
      </div>
    );
  }

  // 滑动高亮：把 glide 条移动到指定行（读 DOM offsetTop，事件时已就绪）
  const glide = (i: number) => {
    const el = rowsRef.current[i];
    if (el) {
      setHl({ top: el.offsetTop, height: el.offsetHeight });
      setActive(i);
    } else {
      setHl(null);
      setActive(-1);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (shown.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      glide(active < 0 ? 0 : Math.min(active + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      glide(active < 0 ? shown.length - 1 : Math.max(active - 1, 0));
    } else if (e.key === 'Enter' && active >= 0 && shown[active]) {
      shown[active].onSelect?.();
    }
  };

  return (
    <div className="searchbox">
      <div className="searchbox-input">
        <svg className="sic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(-1); setHl(null); }}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </div>
      <div className="searchbox-menu">
        {hl ? <span className="searchbox-glide" style={{ top: hl.top, height: hl.height, opacity: 1 }} /> : null}
        {shown.map((it, i) => (
          <button
            key={it.id}
            type="button"
            ref={(el) => { rowsRef.current[i] = el; }}
            className="searchbox-row"
            onMouseEnter={() => glide(i)}
            onClick={it.onSelect}
          >
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
            {it.sub ? <span className="sub">{it.sub}</span> : null}
          </button>
        ))}
        {q.trim() && shown.length === 0 ? <div className="searchbox-empty">{emptyText}</div> : null}
      </div>
    </div>
  );
}
