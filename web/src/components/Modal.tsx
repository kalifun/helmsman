// 职责：Modal —— 遮罩 + 居中模态（ESC 关闭，点击遮罩关闭）。
import { useEffect, type ReactNode } from 'react';

export function Modal({
  open,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={wide ? 'modal-box wide' : 'modal-box'}>{children}</div>
    </div>
  );
}
