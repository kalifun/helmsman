// 职责：看板 —— 五列（Pending/Running/Failed/Done/Cancelled；Running 列含 Waiting 目标契约）。
// M2.3（O1=B）：看板按**资产卡**展示 —— 卡状态 = 最新一次执行的状态；卡上显示里程碑 + 执行次数；
// 点卡 → 详情抽屉（全部执行代次，可 fork）。
// 卡片信息层级：标题 + 里程碑徽章 → 依赖 chips（目标契约）→ 最后活动 → 执行 ×N → 操作行。
// 红线 1：前端不改状态——拖拽/运行/重跑都是发事件（真实契约仅 POST cards/executions；其余目标契约占位）。
// 阻塞（依赖未完成）每次渲染现算（depsUnmet），绝不写状态字段。
import { useMemo, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import {
  useProjection, cardStatus, latestExecution, cardUnmet, activityText, fmtTime,
  type CardState, type TaskState,
} from '../store/projection';
import { Skeleton } from '../components/Skeleton';

const COLS: { key: TaskState['status']; label: string }[] = [
  { key: 'Pending', label: '待办' },
  { key: 'Running', label: '进行中' },
  { key: 'Failed', label: '失败' },
  { key: 'Done', label: '完成' },
  { key: 'Cancelled', label: '已取消' },
];

export function KanbanView({ pid }: { pid: string }) {
  const cards = useProjection((s) => s.cards[pid] || {});
  const conn = useProjection((s) => s.conn);
  const loading = useProjection((s) => s.loading);
  const toast = useUi((s) => s.toast);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);

  const all = useMemo(() => Object.values(cards), [cards]);
  const byId = useMemo(() => cards, [cards]);

  const openDetail = (cardId: string) => {
    useUi.getState().setRoute({ openId: cardId, tab: 'comments' });
    writeHash(pid, 'kanban', cardId, 'comments');
  };

  const runCard = async (c: CardState) => {
    // §2.1 调度门：依赖未完成 → 服务端 409（前端已禁用按钮，双保险）
    if (conn !== 'online') { toast('断连期间禁用控制操作'); return; }
    const sid = await useProjection.getState().forkExecution(c.id, undefined);
    if (sid) toast('已启动执行');
  };

  const retryCard = async (c: CardState) => {
    if (conn !== 'online') { toast('断连期间禁用控制操作'); return; }
    const sid = await useProjection.getState().forkExecution(c.id, undefined);
    if (sid) toast('重跑 = 新执行代次（保留原事件流供 diff）');
  };

  const onDrop = async (c: CardState, target: string) => {
    const st = cardStatus(c);
    if (st === 'Running' || st === 'Waiting') return; // 锁死
    if (conn !== 'online') { toast('断连期间禁用控制操作'); return; }
    // 红线 1：拖拽 = 事件（POST /api/cards/:id/status，手动标记语义）
    const map: Record<string, 'Done' | 'Failed' | 'Pending'> = { done: 'Done', fail: 'Failed', todo: 'Pending' };
    const status = map[target];
    if (!status) return;
    const ok = await useProjection.getState().markCardStatus(c.id, status);
    toast(ok ? `已手动标记「${target}」（事件接口 · 状态可审计）` : '标记失败，见错误横幅');
  };

  if (loading && !all.length) {
    return (
      <div id="kanban">
        {COLS.map((c) => (
          <div key={c.key} className="kcol">
            <div className="kcol-head"><span className="dot {c.key}" />{c.label}<span className="count">—</span></div>
            <div className="kcol-body">
              <Skeleton height={96} style={{ marginBottom: 8 }} />
              <Skeleton height={96} style={{ marginBottom: 8 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div id="kanban">
      {COLS.map((col) => {
        const items = all.filter((c) => {
          const st = cardStatus(c);
          return col.key === 'Running' ? st === 'Running' || st === 'Waiting' : st === col.key;
        });
        const headCount = col.key === 'Running'
          ? all.filter((c) => ['Running', 'Waiting'].includes(cardStatus(c))).length
          : items.length;
        return (
          <div
            key={col.key}
            className={'kcol' + (dropCol === col.key ? ' droptarget' : '')}
            data-col={col.key}
            onDragOver={(e) => { e.preventDefault(); if (dragId) setDropCol(col.key); }}
            onDragLeave={() => setDropCol(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropCol(null);
              const id = dragId || e.dataTransfer.getData('text/plain');
              setDragId(null);
              const c = byId[id];
              if (c) onDrop(c, col.key);
            }}
          >
            <div className="kcol-head">
              <span className={'dot ' + col.key} />
              {col.label}
              <span className="count">{headCount}</span>
            </div>
            <div className="kcol-body">
              {items.length === 0 && <div className="kempty">暂无</div>}
              {items.map((c, k) => {
                const st = cardStatus(c);
                const locked = st === 'Running' || st === 'Waiting';
                const exec = latestExecution(c);
                const unmet = cardUnmet(c, byId);
                const lastAct = exec && exec.activities.length ? exec.activities[exec.activities.length - 1] : null;
                let act: React.ReactNode = null;
                if (st === 'Pending') {
                  act = unmet.length
                    ? <span className="run-state">等上游：{unmet.join('、')}</span>
                    : <button className="btn mini" onClick={(e) => { e.stopPropagation(); void runCard(c); }}>运行</button>;
                } else if (st === 'Running') {
                  act = <span className="run-state">运行中 · 锁死（评论即控制）</span>;
                } else if (st === 'Waiting') {
                  act = <span className="waiting-q">等待批复 · 锁死</span>;
                } else if (st === 'Failed' || st === 'Cancelled') {
                  act = <button className="btn mini ghost" onClick={(e) => { e.stopPropagation(); void retryCard(c); }}>重跑</button>;
                }
                return (
                  <div
                    key={c.id}
                    className={'kcard st-' + st + (locked ? ' locked' : '')}
                    style={{ ['--i' as string]: k }}
                    draggable={!locked}
                    onDragStart={(e) => {
                      if (locked) { e.preventDefault(); return; }
                      setDragId(c.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', c.id);
                      e.currentTarget.classList.add('dragging');
                    }}
                    onDragEnd={(e) => {
                      e.currentTarget.classList.remove('dragging');
                      setDragId(null);
                      setDropCol(null);
                    }}
                    onClick={() => openDetail(c.id)}
                  >
                    <div className="kt">
                      {c.title || c.id.slice(0, 14)}
                      {c.milestone ? <span className="milestone-chip">{c.milestone}</span> : null}
                      {exec?.recovered ? <span className="rec">恢复</span> : null}
                      {locked ? <span className="lock-tag">🔒</span> : null}
                    </div>
                    {unmet.length ? <div className="ksum"><span className="dep blocked">← {unmet.join('、')}</span></div> : null}
                    {lastAct ? (
                      <div className="ksum">
                        <span className="ellip">{fmtTime(exec?.started_at ?? exec?.finished_at)} · {activityText(lastAct).slice(0, 26)}</span>
                      </div>
                    ) : null}
                    <div className="ksum kexec">
                      <span className="exec-count">⚙ 执行 ×{c.execution_count ?? Object.keys(c.executions).length}</span>
                      {exec?.model ? <span className="ellip">{exec.model}</span> : null}
                    </div>
                    <div className="kact">{act}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
