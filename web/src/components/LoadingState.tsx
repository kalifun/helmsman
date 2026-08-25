// 职责：加载状态（Beautiful UI「Loading State」移植，MIT © Shane Levine）——
//   pixel 网格 / dots 脉冲 / drive 扫条 / orbit 双环 / surfer 波浪 + shimmer 文字 + 计时。
import { useEffect, useState } from 'react';

export type LoadingVariant = 'pixel' | 'dots' | 'drive' | 'orbit' | 'surfer';

interface Props {
  label?: string;
  /** 计时起点（epoch ms）；不传则不显示计时 */
  startedAt?: number;
  variant?: LoadingVariant;
}

export function LoadingState({ label = '处理中…', startedAt, variant = 'pixel' }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [startedAt]);

  const secs = startedAt != null ? Math.max(0, (now - startedAt) / 1000) : null;
  const time = secs != null ? <span className="loading-time">{secs.toFixed(1)}s</span> : null;
  const lab = <span className="loading-label">{label}</span>;

  if (variant === 'dots') {
    return (
      <div className="loading" role="status">
        <span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>
        {lab}{time}
      </div>
    );
  }
  if (variant === 'drive') {
    return (
      <div className="loading" role="status">
        <span className="loading-drive" aria-hidden="true"><i /></span>
        {lab}{time}
      </div>
    );
  }
  if (variant === 'orbit') {
    return (
      <div className="loading" role="status">
        <span className="loading-orbit" aria-hidden="true"><i /><i /></span>
        {lab}{time}
      </div>
    );
  }
  if (variant === 'surfer') {
    return (
      <div className="loading" role="status">
        <span className="loading-surfer" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        {lab}{time}
      </div>
    );
  }

  const delays = [90, 180, 270, 0, 90, 180, 90, 180, 270];
  return (
    <div className="loading" role="status">
      <span className="loading-grid" aria-hidden="true">
        {delays.map((d, i) => <i key={i} style={{ animationDelay: `${d}ms` }} />)}
      </span>
      {lab}{time}
    </div>
  );
}
