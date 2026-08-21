// 职责：工具调用折叠条（Beautiful UI「Tool Chips」移植，MIT © Shane Levine）——
//   折叠头 "N 次工具调用 · M 条消息" + 展开 chips（工具名 + 成败 + 耗时）。
//   用于把一串工具调用压成一行小条，会话里不打断阅读流。
import { useState } from 'react';

export interface ToolChip {
  id: string | number;
  name: string;
  ok?: boolean;
  ms?: number;
}

interface Props {
  calls: ToolChip[];
  /** 关联消息数（"· N 条消息"），不传则只显示调用数 */
  messages?: number;
  defaultOpen?: boolean;
}

export function ToolChips({ calls, messages, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const okCount = calls.filter((c) => c.ok !== false).length;

  return (
    <div className={'toolchips' + (open ? ' open' : '')}>
      <button
        type="button"
        className="toolchips-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span><b>{calls.length}</b> 次工具调用</span>
        {messages != null ? <span>· {messages} 条消息</span> : null}
        <span className="toolchip-count">{okCount}/{calls.length} 成功</span>
      </button>
      <div className="toolchips-body">
        <div className="toolchips-body-inner">
          {calls.length ? (
            <div className="toolchips-list">
              {calls.map((c) => (
                <span key={c.id} className="toolchip" title={c.name}>
                  <span className="tn">{c.name}</span>
                  <span className={c.ok === false ? 'err' : 'ok'}>{c.ok === false ? '失败' : '成功'}</span>
                  {c.ms != null ? <span className="ms">{c.ms} ms</span> : null}
                </span>
              ))}
            </div>
          ) : (
            <div className="think-empty">（空）</div>
          )}
        </div>
      </div>
    </div>
  );
}
