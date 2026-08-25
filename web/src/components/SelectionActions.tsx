// 职责：划词操作条（Beautiful UI「Selection Actions」移植，MIT © Shane Levine）——
//   选中一段文字后浮出 Explain / Improve / Shorten / Tone / Grammar，把选区交给 agent。
//   纯 UI：动作经 onAction 上抛，调用方填进 PromptBar（不自动发送）。
import { useEffect, useRef, useState, type ReactNode } from 'react';

export const SELECT_ACTIONS = [
  { id: 'explain', label: '解释' },
  { id: 'improve', label: '改进' },
  { id: 'shorten', label: '缩短' },
  { id: 'tone', label: '语气' },
  { id: 'grammar', label: '语法' },
] as const;

export type SelectActionId = (typeof SELECT_ACTIONS)[number]['id'];

export function promptFromSelection(kind: SelectActionId, text: string): string {
  const q = text.trim();
  switch (kind) {
    case 'explain': return `请解释这段：\n\n> ${q}`;
    case 'improve': return `请改进这段：\n\n> ${q}`;
    case 'shorten': return `请缩短这段，保留要点：\n\n> ${q}`;
    case 'tone': return `请调整这段语气，使其更清晰专业：\n\n> ${q}`;
    case 'grammar': return `请修正这段的语法和用词：\n\n> ${q}`;
  }
}

interface Props {
  children: ReactNode;
  onAction: (kind: SelectActionId, text: string) => void;
  disabled?: boolean;
}

export function SelectionActions({ children, onAction, disabled }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ top: number; left: number; text: string } | null>(null);

  const hide = () => setBar(null);

  useEffect(() => {
    if (disabled) { hide(); return; }
    const root = rootRef.current;
    if (!root) return;

    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode)) {
        hide();
        return;
      }
      const text = sel.toString();
      if (text.trim().length < 2) { hide(); return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      setBar({
        top: rect.top - box.top - 40,
        left: rect.left - box.left + rect.width / 2,
        text,
      });
    };

    const onScroll = () => hide();
    document.addEventListener('mouseup', onUp);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [disabled]);

  return (
    <div className="selact" ref={rootRef}>
      {children}
      {bar && !disabled ? (
        <div
          className="selact-bar"
          style={{ top: Math.max(0, bar.top), left: bar.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {SELECT_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="selact-btn"
              onClick={() => { onAction(a.id, bar.text); hide(); window.getSelection()?.removeAllRanges(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
