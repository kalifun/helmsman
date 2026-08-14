// 职责：Skeleton —— 加载占位（shimmer 动画）。
export function Skeleton({ height, width, style }: { height?: number | string; width?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: height ?? 120, width: width ?? '100%', ...style }} />;
}
