// 职责：Toast 容器 —— 顶部居中非阻塞通知（3s 自动消失，原型 .toast 行为）。
import { useUi } from '../store/ui';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div id="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" onClick={() => dismiss(t.id)}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
