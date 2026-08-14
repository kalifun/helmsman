// 职责：状态 pill（粉彩底 + 深色字，圆点 + 文字）—— 语义色只表达状态。
import type { TaskStatus } from '../store/projection';

export const ST_LABEL: Record<TaskStatus, string> = {
  Pending: '待办',
  Running: '运行中',
  Done: '完成',
  Failed: '失败',
  Cancelled: '已取消',
};

export function StatusPill({ status, label }: { status: TaskStatus; label?: string }) {
  return <span className={'pill pill-' + status}>{label ?? ST_LABEL[status]}</span>;
}
