// 职责：对话面板（Beautiful UI「Chat」移植，MIT © Shane Levine）——
//   顶栏分页签 + 消息流 + 底部 composer。推理/工具/流式由调用方塞进 children。
import type { ReactNode, Ref } from 'react';

export interface ChatTab {
  id: string;
  label: string;
}

interface Props {
  tabs?: ChatTab[];
  tab?: string;
  onTab?: (id: string) => void;
  children: ReactNode;
  footer: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
}

export function ChatPanel({ tabs, tab, onTab, children, footer, bodyRef }: Props) {
  return (
    <div className="chatpanel">
      {tabs && tabs.length > 0 ? (
        <div className="chatpanel-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={'chatpanel-tab' + (t.id === tab ? ' active' : '')}
              onClick={() => onTab?.(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="chatpanel-body" ref={bodyRef}>{children}</div>
      <div className="chatpanel-foot">{footer}</div>
    </div>
  );
}
