// 职责：会话记录 —— 项目下全部执行（= 会话）清单，解决"黑盒"：卡标题/状态/时间/模型/回合/成本一眼可见，
// 点击打开详情抽屉（默认轨迹页签）。M2.3：执行挂卡下（1 卡 N 执行），清单平铺全部执行代次。
// 顶部 SearchBox + Filter Table（Beautiful UI 移植）：关键词过滤后，状态 chips 重组表格。
import { useState } from 'react';
import { useUi, writeHash, openSession } from '../store/ui';
import { useProjection, effectiveStatus, estCost, relTime, activityText, type TaskState } from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { EmptyState } from '../components/EmptyState';
import { SearchBox } from '../components/SearchBox';
import { FilterTable } from '../components/FilterTable';

type Row = { t: TaskState; cardId: string | null; cardTitle: string };

const CHIPS = [
  { id: 'all', label: '全部' },
  { id: 'Running', label: '运行中' },
  { id: 'Waiting', label: '待批复' },
  { id: 'Pending', label: '待办' },
  { id: 'Failed', label: '失败' },
  { id: 'Done', label: '完成' },
  { id: 'Cancelled', label: '已取消' },
];

export function SessionsView({ pid }: { pid: string }) {
  const cards = useProjection((s) => s.cards[pid] || {});
  const chats = useProjection((s) => s.chats[pid] || {});
  const usage = useProjection((s) => s.usage);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');

  // 平铺全部会话：卡执行 + 简单会话（独立，不进看板）
  const rows: Row[] = [];
  Object.values(cards).forEach((c) => {
    Object.values(c.executions).forEach((t) => rows.push({ t, cardId: c.id, cardTitle: c.title }));
  });
  Object.values(chats).forEach((t) => rows.push({ t, cardId: null, cardTitle: '简单会话' }));
  const list = rows.sort((a, b) => (b.t.started_at ?? 0) - (a.t.started_at ?? 0));

  const match = (row: Row, query: string): boolean => {
    const { t } = row;
    const hay = [
      row.cardTitle, t.title, t.model, effectiveStatus(t), t.id,
      t.activities.length ? activityText(t.activities[t.activities.length - 1]) : '',
    ].filter(Boolean).join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).every((k) => hay.includes(k));
  };

  const searched = q.trim() ? list.filter((row) => match(row, q.trim())) : list;

  const open = (row: Row) => {
    if (!row.cardId) {
      openSession(pid, row.t.id, 'sessions', null);
      return;
    }
    useUi.getState().setRoute({ openId: row.cardId, tab: 'trajectory' });
    writeHash(pid, 'sessions', row.cardId, 'trajectory');
  };

  return (
    <div id="chatview" style={{ overflowY: 'auto', padding: '24px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div className="ph-head">
          <h1>会话记录</h1>
          <div className="ph-path">本项目的全部执行（1 卡 N 执行 · 会话即执行） · {list.length} 次</div>
        </div>

        <div style={{ marginTop: 16 }}>
          <SearchBox
            bare
            placeholder="搜索会话（标题 / 模型 / 状态 / 会话 id）…"
            value={q}
            onValue={(v) => { setQ(v); setChip('all'); }}
          />
        </div>

        <div className="home-sec" style={{ marginTop: 16, padding: 0, overflow: 'hidden' }}>
          {list.length === 0 ? (
            <div style={{ padding: 16 }}>
              <EmptyState icon="chat" title="还没有会话" desc="建一张卡（看板「+ 建卡」）即创建首代执行，引擎自动执行；可 fork 更多代次" />
            </div>
          ) : (
            <FilterTable
              chips={CHIPS}
              value={chip}
              onChange={setChip}
              chipOf={(row) => effectiveStatus(row.t)}
              rows={searched}
              rowKey={(row) => row.t.id}
              onRow={open}
              empty={<EmptyState icon="search" title="没有匹配的会话" desc="换一个关键词或状态试试" />}
              columns={[
                {
                  key: 'name',
                  label: '任务',
                  cell: (row) => (
                    <span className="ftable-name">{row.cardTitle || row.t.title || row.t.id.slice(0, 16)}</span>
                  ),
                },
                {
                  key: 'when',
                  label: '时间',
                  width: '18%',
                  cell: (row) => relTime(row.t.started_at),
                },
                {
                  key: 'st',
                  label: '状态',
                  width: '16%',
                  cell: (row) => <StatusPill status={effectiveStatus(row.t)} />,
                },
                {
                  key: 'meta',
                  label: '模型',
                  width: '28%',
                  cell: (row) => {
                    const cost = estCost(usage[row.t.id], row.t.model);
                    return (
                      <span className="ftable-meta">
                        {row.t.model || '—'} · {row.t.turns} 回合
                        {cost != null ? ` · ¥${cost.toFixed(4)}` : ''}
                      </span>
                    );
                  },
                },
              ]}
            />
          )}
        </div>
      </div>
    </div>
  );
}
