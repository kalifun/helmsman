// 职责：EmptyState —— 图标 + 标题 + 引导文案 + 可选动作。
import type { ReactNode } from 'react';
import type { IconName } from './icons';
import { Icon } from './icons';

export function EmptyState({
  icon,
  title,
  desc,
  actions,
  style,
}: {
  icon: IconName;
  title: string;
  desc?: string;
  actions?: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="empty-state" style={style}>
      <Icon name={icon} />
      <div className="t">{title}</div>
      {desc ? <div className="d">{desc}</div> : null}
      {actions ? <div className="a">{actions}</div> : null}
    </div>
  );
}
