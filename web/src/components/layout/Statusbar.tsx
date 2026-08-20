// 职责：Statusbar —— 连接点 · 项目路径 · 运行中/待确认/失败 · 会话成本 · 平均缓存命中（全部真实数据派生）。
// M2.3：计数按卡的最新执行状态；成本/缓存按执行（会话）usage 聚合。
import { useUi } from '../../store/ui';
import { useProjection, estCost, avgCacheHit, cardStatus, latestExecution } from '../../store/projection';

export function Statusbar() {
  const pid = useUi((s) => s.pid);
  const view = useUi((s) => s.view);
  const projects = useProjection((s) => s.projects);
  const cards = useProjection((s) => s.cards);
  const usage = useProjection((s) => s.usage);
  const conn = useProjection((s) => s.conn);
  const pending = useUi((s) => s.pendingProjects);

  const home = !pid || view === 'home';

  if (home) {
    const allCards = Object.values(cards).flatMap((m) => Object.values(m));
    const execs = allCards.map((c) => latestExecution(c)).filter((t): t is NonNullable<typeof t> => !!t);
    const cost = execs.reduce((sum, t) => sum + (estCost(usage[t.id], t.model) ?? 0), 0);
    const hit = avgCacheHit(execs, usage);
    const counts = cardCounts(allCards);
    return (
      <footer id="statusbar">
        <div className="sb-left">
          <span className={'dot' + (conn === 'online' ? ' ok' : conn === 'reconnect' ? ' warn' : '')} />
          <span>Helmsman · 工作台</span>
        </div>
        <div className="spacer" />
        <div className="sb-right">
          <span><b>{Object.keys(projects).length + Object.keys(pending).length}</b> 个项目</span>
          {counts.Running ? <span>运行中 <b>{counts.Running}</b></span> : null}
          {counts.Failed ? <span>失败 <b>{counts.Failed}</b></span> : null}
          <span>会话成本 ¥{cost.toFixed(4)}</span>
          <span>平均缓存 {hit == null ? '—' : Math.round(hit * 100) + '%'}</span>
        </div>
      </footer>
    );
  }

  const proj = projects[pid ?? ''] ?? pending[pid ?? ''];
  const projCards = Object.values(cards[pid ?? ''] || {});
  const execs = projCards.map((c) => latestExecution(c)).filter((t): t is NonNullable<typeof t> => !!t);
  const c = cardCounts(projCards);
  const cost = execs.reduce((sum, t) => sum + (estCost(usage[t.id], t.model) ?? 0), 0);
  const hit = avgCacheHit(execs, usage);
  const parts: string[] = [];
  if (c.Running) parts.push(`运行中 <b>${c.Running}</b>`);
  if (c.Failed) parts.push(`失败 <b>${c.Failed}</b>`);
  if (c.Pending) parts.push(`待确认 <b>${c.Pending}</b>`);

  return (
    <footer id="statusbar">
      <div className="sb-left">
        <span className={'dot' + (conn === 'online' ? ' ok' : conn === 'reconnect' ? ' warn' : '')} />
        <span>Helmsman · {proj?.path ?? pid}</span>
      </div>
      <div className="spacer" />
      <div className="sb-right">
        {parts.length ? <span dangerouslySetInnerHTML={{ __html: parts.join(' · ') }} /> : null}
        <span>会话成本 ¥{cost.toFixed(4)}</span>
        <span>平均缓存 {hit == null ? '—' : Math.round(hit * 100) + '%'}</span>
      </div>
    </footer>
  );
}

/** 卡计数（按卡的最新执行状态；无执行 = Pending） */
function cardCounts(cards: import('../../store/projection').CardState[]): Record<string, number> {
  const out: Record<string, number> = { Pending: 0, Running: 0, Done: 0, Failed: 0, Cancelled: 0, Waiting: 0 };
  cards.forEach((c) => { out[cardStatus(c)] += 1; });
  return out;
}
