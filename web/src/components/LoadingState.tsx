// 职责：加载状态（Beautiful UI「Loading State」移植，MIT © Shane Levine）——
//   像素网格逐格点亮 + shimmer 文字 + mono 计时（startedAt 起算）。
//   variant=dots：三点脉冲（轻量变体）。
import { useEffect, useState } from 'react';

interface Props {
  label?: string;
  /** 计时起点（epoch ms）；不传则不显示计时 */
  startedAt?: number;
  variant?: 'pixel' | 'dots';
}

export function LoadingState({ label = '处理中…', startedAt, variant = 'pixel' }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [startedAt]);

  const secs = startedAt != null ? Math.max(0, (now - startedAt) / 1000) : null;

  if (variant === 'dots') {
    return (
      <div className="loading" role="status">
        <span className="loading-label">{label}</span>
        {secs != null ? <span className="loading-time">{secs.toFixed(1)}s</span> : null}
      </div>
    );
  }

  // 3×3 像素网格：阶梯延迟逐格点亮（顺序 = 行扫描）
  const delays = [90, 180, 270, 0, 90, 180, 90, 180, 270];
  return (
    <div className="loading" role="status">
      <span className="loading-grid" aria-hidden="true">
        {delays.map((d, i) => <i key={i} style={{ animationDelay: `${d}ms` }} />)}
      </span>
      <span className="loading-label">{label}</span>
      {secs != null ? <span className="loading-time">{secs.toFixed(1)}s</span> : null}
    </div>
  );
}
