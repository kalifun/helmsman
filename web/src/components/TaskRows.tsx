// 职责：任务行（Beautiful UI「Task Rows」移植，MIT © Shane Levine）——
//   live 状态行：状态图标（完成=勾 / 运行=旋转进度环+数字 / 失败=叉）+ 标题 + 副信息 + 状态 pill + 展开明细。
//   行头点击：有 detail 则展开/收起；无 detail 则触发 onClick（如打开详情抽屉）。
import { useState } from 'react';

export type TaskRowStatus = 'running' | 'failed' | 'completed';

export interface TaskRowDetail {
  label: string;
  value: string;
}

export interface TaskRowItem {
  id: string | number;
  title: string;
  status: TaskRowStatus;
  /** 右侧副信息（如执行次数 / 供应商数） */
  meta?: string;
  /** 状态 pill 文案；缺省按 status 给（运行中 / 失败 / 完成） */
  pill?: string;
  /** 运行环中央数字（如已用步骤数） */
  progress?: number;
  /** 展开明细（行头点击 = 展开/收起） */
  detail?: TaskRowDetail[];
  onClick?: () => void;
}

const PILL_CLS: Record<TaskRowStatus, string> = { running: 'Running', failed: 'Failed', completed: 'Done' };
const PILL_LABEL: Record<TaskRowStatus, string> = { running: '运行中', failed: '失败', completed: '完成' };

function StatusIcon({ status, progress }: { status: TaskRowStatus; progress?: number }) {
  if (status === 'completed') {
    return (
      <span className="taskrow-ic done">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="taskrow-ic fail">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </span>
    );
  }
  return (
    <span className="taskrow-ic run">
      <span className="ring">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="none" stroke="var(--line)" strokeWidth="2" />
          <circle cx="12" cy="12" r="11" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeDasharray="19 50" />
        </svg>
        <b>{progress ?? '…'}</b>
      </span>
    </span>
  );
}

export function TaskRows({ items }: { items: TaskRowItem[] }) {
  return (
    <div className="taskrows">
      {items.map((it) => (
        <TaskRow key={it.id} item={it} />
      ))}
    </div>
  );
}

function TaskRow({ item: it }: { item: TaskRowItem }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!it.detail?.length;
  return (
    <div className={'taskrow' + (open ? ' open' : '')}>
      <button
        type="button"
        className="taskrow-head"
        aria-expanded={hasDetail ? open : undefined}
        onClick={() => (hasDetail ? setOpen((v) => !v) : it.onClick?.())}
      >
        <StatusIcon status={it.status} progress={it.progress} />
        <span className="taskrow-title" title={it.title}>{it.title}</span>
        {it.meta ? <span className="taskrow-meta">{it.meta}</span> : null}
        <span className={'pill pill-' + PILL_CLS[it.status]}>{it.pill ?? PILL_LABEL[it.status]}</span>
        <svg className="taskrow-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {hasDetail ? (
        <div className="taskrow-body">
          <div className="taskrow-body-inner">
            <div className="taskrow-detail">
              <span className="line" />
              <div className="items">
                {it.detail!.map((d) => (
                  <div key={d.label} className="di">
                    <span>{d.label}</span>
                    <b>{d.value}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
