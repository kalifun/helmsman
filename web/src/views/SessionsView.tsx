// 职责：会话记录 —— 项目下全部执行（= 会话）清单，解决"黑盒"：卡标题/状态/时间/模型/回合/成本一眼可见，
// 点击打开详情抽屉（默认轨迹页签）。M2.3：执行挂卡下（1 卡 N 执行），清单平铺全部执行代次。
import { useUi, writeHash } from '../store/ui';
import { useProjection, statusCounts, estCost, relTime, activityText, type TaskState } from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/icons';

export function SessionsView({ pid }: { pid: string }) {
  const cards = useProjection((s) => s.cards[pid] || {});
  const usage = useProjection((s) => s.usage);

  // 平铺全部执行（会话），带卡归属
  const rows: { t: TaskState; cardId: string; cardTitle: string }[] = [];
  Object.values(cards).forEach((c) => {
    Object.values(c.executions).forEach((t) => rows.push({ t, cardId: c.id, cardTitle: c.title }));
  });
  const list = rows.sort((a, b) => (b.t.started_at ?? 0) - (a.t.started_at ?? 0));
  const counts = statusCounts(list.map((r) => r.t));

  const open = (row: { t: TaskState; cardId: string }) => {
    useUi.getState().setRoute({ openId: row.cardId, tab: 'trajectory' });
    writeHash(pid, 'sessions', row.cardId, 'trajectory');
  };

  return (
    <div id="chatview" style={{ overflowY: 'auto', padding: '24px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div className="ph-head">
          <h1>会话记录</h1>
          <div className="ph-path">本项目的全部执行（1 卡 N 执行 · 会话即执行） · {list.length} 次</div>
          <div className="ph-status">
            {(['Running', 'Failed', 'Pending', 'Done', 'Cancelled'] as const)
              .filter((k) => counts[k] > 0)
              .map((k) => <StatusPill key={k} status={k} label={(k === 'Running' ? '运行中 ' : k === 'Failed' ? '失败 ' : k === 'Pending' ? '待办 ' : k === 'Done' ? '完成 ' : '已取消 ') + counts[k]} />)}
          </div>
        </div>

        <div className="home-sec" style={{ marginTop: 20 }}>
          {list.length === 0 ? (
            <EmptyState icon="chat" title="还没有会话" desc="建一张卡（看板「+ 建卡」）即创建首代执行，引擎自动执行；可 fork 更多代次" />
          ) : (
            list.map((row, i) => {
              const { t } = row;
              const cost = estCost(usage[t.id]);
              const lastAct = t.activities.length ? activityText(t.activities[t.activities.length - 1]).slice(0, 42) : '';
              return (
                <div key={t.id} className="home-item" style={{ ['--i' as string]: i, cursor: 'pointer' }} onClick={() => open(row)}>
                  <StatusPill status={t.status} />
                  <span className="at" style={{ flex: '0 1 auto', maxWidth: 260 }}>{row.cardTitle || t.title || t.id.slice(0, 16)}</span>
                  <span className="aq" style={{ flex: 1 }}>
                    {t.id.slice(0, 8)} · {t.model || '-'} · {t.turns} 回合 · {relTime(t.started_at)}
                    {lastAct ? ' · ' + lastAct : ''}
                  </span>
                  {cost != null ? <span className="aq" style={{ flexShrink: 0 }}>¥{cost.toFixed(4)}</span> : null}
                  <Icon name="side" size="sm" style={{ transform: 'rotate(180deg)', color: 'var(--text3)' }} />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
