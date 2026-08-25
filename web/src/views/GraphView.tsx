// 职责：依赖图（DAG 预览）—— 按依赖深度分层；deps = 目标契约（建卡时指定，投影自最新执行）。
// 节点 = 卡（状态 = 最新执行）；边 = deps 贝塞尔曲线，虚线黄 = 依赖未完成（阻塞）。
// 视觉：Beautiful UI「Flowchart」移植（MIT © Shane Levine）—— 点阵画布 + 起点/依赖步骤卡。
// 点击 → 详情抽屉（全部执行代次）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import { useProjection, cardStatus, latestExecution, activityText } from '../store/projection';
import { StatusPill } from '../components/StatusPill';

export function GraphView({ pid }: { pid: string }) {
  const cards = useProjection((s) => s.cards[pid] || {});
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(28);
  const [ty, setTy] = useState(20);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const all = useMemo(() => Object.values(cards), [cards]);
  const byId = useMemo(() => cards, [cards]);

  // 依赖深度（目标契约 deps；无 deps → 全 0 层）
  const depth = (cardId: string, seen: Set<string> = new Set()): number => {
    if (seen.has(cardId)) return 0;
    seen.add(cardId);
    const c = byId[cardId];
    const deps = latestExecution(c)?.deps;
    if (!deps?.length) return 0;
    return 1 + Math.max(...deps.map((d) => (byId[d] ? depth(d, seen) : 0)));
  };

  const layers = useMemo(() => {
    const m = new Map<number, string[]>();
    all.forEach((c) => {
      const d = depth(c.id);
      m.set(d, [...(m.get(d) || []), c.id]);
    });
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  const W = 240, H = 108, XG = 330, X0 = 48, YG = 132;
  const pos = useMemo(() => {
    const p: Record<string, [number, number]> = {};
    layers.forEach(([, ids], i) => {
      const colH = ids.length * YG;
      const y0 = Math.max(16, 48 + (colH - YG) / 2 - colH / 2 + YG / 2);
      ids.forEach((id, j) => { p[id] = [X0 + i * XG, y0 + j * YG]; });
    });
    return p;
  }, [layers]);

  const width = X0 + layers.length * XG + W + 48;
  const height = Math.max(280, Math.max(0, ...layers.map(([, ids]) => ids.length)) * YG + 80);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      setTx((v) => v + e.clientX - drag.current!.x);
      setTy((v) => v + e.clientY - drag.current!.y);
      drag.current = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => { drag.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  return (
    <div id="graphview">
      <div className="g-tip">
        <span>依赖图</span><span>悬停高亮依赖</span><span>滚轮缩放 · 拖拽平移</span>
      </div>
      <div className="g-legend">
        <span className="k"><span className="sw" />依赖已就绪</span>
        <span className="k"><span className="sw dash" />依赖未完成</span>
      </div>
      <div
        className="g-wrap"
        onWheel={(e) => { e.preventDefault(); setScale((s) => Math.min(2, Math.max(0.5, s * (e.deltaY < 0 ? 1.1 : 0.9)))); }}
        onMouseDown={(e) => { if ((e.target as HTMLElement).closest('.g-card')) return; drag.current = { x: e.clientX, y: e.clientY }; }}
        style={{ cursor: drag.current ? 'grabbing' : undefined }}
      >
        <div id="g-inner" style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}>
          <svg className="g-edge-svg" width={width} height={height}>
            {all.flatMap((c) => {
              const deps = latestExecution(c)?.deps || [];
              return deps.map((d) => {
                const p1 = pos[d], p2 = pos[c.id];
                if (!p1 || !p2) return null;
                const depCard = byId[d];
                const blocked = !depCard || cardStatus(depCard) !== 'Done';
                const dx = Math.max(40, (p2[0] - p1[0]) / 2);
                return <path key={c.id + ':' + d} className={'g-edge' + (blocked ? ' blocked' : '') + (hoverId === d || hoverId === c.id ? ' hl' : '')} d={`M${p1[0] + W},${p1[1] + H / 2} C${p1[0] + W + dx},${p1[1] + H / 2} ${p2[0] - dx},${p2[1] + H / 2} ${p2[0]},${p2[1] + H / 2}`} />;
              });
            })}
          </svg>
          <div className="g-nodes" style={{ width, height }}>
            {all.map((c) => {
              const [x, y] = pos[c.id] || [0, 0];
              const st = cardStatus(c);
              const exec = latestExecution(c);
              const deps = (exec?.deps || []).map((id) => byId[id]?.title || id.slice(0, 8)).filter(Boolean);
              return (
                <div
                  key={c.id}
                  className={'g-card st-' + st}
                  style={{ left: x, top: y }}
                  onMouseEnter={() => setHoverId(c.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onClick={() => {
                    useUi.getState().setRoute({ openId: c.id, tab: 'comments' });
                    writeHash(pid, 'graph', c.id, 'comments');
                  }}
                >
                  <div className="gc-kicker">{deps.length ? '依赖' : '起点'}</div>
                  <div className="gc-title">{c.title || c.id.slice(0, 14)}{c.milestone ? <span className="milestone-chip" style={{ marginLeft: 6 }}>{c.milestone}</span> : null}</div>
                  {deps.length ? <div className="gc-cond">若 {deps.join('、')} 完成</div> : null}
                  <div className="gc-row"><StatusPill status={st} /></div>
                  <div className="gc-meta">
                    {exec && exec.activities.length ? activityText(exec.activities[exec.activities.length - 1]).slice(0, 22) : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{ position: 'absolute', bottom: 44, left: 20, fontSize: 11, color: 'var(--text3)' }}>
        依赖 DAG = 目标契约（建卡时指定 deps · 最新执行快照）{all.length ? '' : ''}
      </div>
    </div>
  );
}
