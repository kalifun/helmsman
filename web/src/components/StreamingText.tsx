// 职责：流式文本（Beautiful UI「Streaming Text」移植，MIT © Shane Levine）——
//   流式内容 + 闪烁光标；streaming 结束后显示动作行（复制 / 重试）。
//   纯展示组件：复制/重试经回调上抛（toast 由调用方负责）。
import { useEffect, useState } from 'react';

interface Props {
  text?: string;
  streaming?: boolean;
  onCopy?: (text: string) => void;
  onRetry?: () => void;
  className?: string;
}

export function StreamingText({ text = '', streaming = false, onCopy, onRetry, className = '' }: Props) {
  const [copied, setCopied] = useState(false);

  // 内容变化后重置 copied 标记
  useEffect(() => setCopied(false), [text]);

  const copy = () => {
    onCopy?.(text);
    setCopied(true);
  };

  return (
    <div className={'stext' + (className ? ' ' + className : '')}>
      <p>
        {text}
        {streaming ? <span className="cursor" aria-hidden="true" /> : null}
      </p>
      {!streaming && text ? (
        <div className="stext-actions">
          {onCopy ? (
            <button
              type="button"
              className={'stext-act' + (copied ? ' copied' : '')}
              title={copied ? '已复制' : '复制'}
              onClick={copy}
            >
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="12" height="12" rx="2.5" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          ) : null}
          {onRetry ? (
            <button type="button" className="stext-act" title="重试" onClick={onRetry}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
