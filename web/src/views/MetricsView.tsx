// 职责：度量视图（M4 §5.2）—— 序列任务曲线 + 度量面板。
// 序列曲线：x = 执行时序（created_at 正序），y = 指标；按 group_tag 分组着色（对照实验 A/B）。
// 面板：任务数 / 总成本 / 平均成本 / 平均轮次 / 验收通过率 / 平均缓存命中率。
// 零依赖：SVG 折线手绘（点 + title 原生 tooltip）。
import { useEffect, useMemo, useState } from 'react';
import { getMetrics, type MetricRow } from '../api/client';

const W = 680, H = 150, P = { l: 46, r: 14, t: 16, b: 22 };

function nice(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** 折线图：values = 按 x 序的数值；fixedMax = 固定 y 上限（如命中率 1） */
function Line({
  series, fixedMax, fmt, label,
}: {
  series: { name: string; color: string; pts: Array<{ x: number; y: number | null }> }[];
  fixedMax?: number;
  fmt: (v: number) => string;
  label: string;
}) {
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const all = series.flatMap((s) => s.pts.map((p) => p.y).filter((y): y is number => y != null));
  const max = fixedMax ?? nice(Math.max(...all, 1));
  const xOf = (i: number, n: number) => (n <= 1 ? P.l + iw / 2 : P.l + (i / (n - 1)) * iw);
  const yOf = (v: number) => P.t + ih - (v / max) * ih;
  // 网格（4 条横线）
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: P.t + ih * f, v: max * (1 - f) }));
  return (
    <div className="m-line">
      <div className="m-line-label">{label}</div>
      <svg width={W} height={H} className="m-svg">
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={g.y} y2={g.y} className="m-grid" />
            <text x={P.l - 6} y={g.y + 3} className="m-axis">{fmt(g.v)}</text>
          </g>
        ))}
        {series.map((s) => {
          const d = s.pts.map((p, i) => {
            if (p.y == null) return '';
            return `${i === 0 ? 'M' : 'L'}${xOf(p.x, s.pts.length).toFixed(1)},${yOf(p.y).toFixed(1)}`;
          }).filter(Boolean).join(' ');
          return (
            <g key={s.name}>
              {d ? <path d={d} fill="none" className="m-path" style={{ stroke: s.color }} /> : null}
              {s.pts.map((p, i) =>
                p.y == null ? null : (
                  <circle key={i} cx={xOf(p.x, s.pts.length)} cy={yOf(p.y)} r={2.6} fill={s.color} className="m-dot">
                    <title>{`${s.name} · #${p.x + 1}：${fmt(p.y!)}`}</title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
      </svg>
      <div className="m-legend">
        {series.map((s) => (
          <span key={s.name} className="m-legend-item"><span className="m-sw" style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
    </div>
  );
}

export function MetricsView({ pid }: { pid: string }) {
  const [rows, setRows] = useState<MetricRow[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    getMetrics(pid).then((rs) => { if (alive) setRows(rs); }).catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [pid]);

  const m = useMemo(() => {
    if (!rows) return null;
    const seq = [...rows].sort((a, b) => a.created_at - b.created_at); // 时间正序
    const groups = new Map<string, MetricRow[]>();
    seq.forEach((r) => {
      const g = r.group_tag || '全部';
      groups.set(g, [...(groups.get(g) || []), r]);
    });
    const series = (pick: (r: MetricRow) => number | null) =>
      [...groups.entries()].map(([name, rs], gi) => ({
        name,
        color: gi === 0 ? 'var(--blue)' : gi === 1 ? 'var(--green)' : 'var(--yellow)',
        pts: rs.map((r, i) => ({ x: i, y: pick(r) })),
      }));
    // 累计成本（组内累计）
    const cum = (rs: MetricRow[]) => { let acc = 0; return rs.map((r) => { acc += r.cost; return acc; }); };
    const cumSeries = [...groups.entries()].map(([name, rs], gi) => ({
      name,
      color: gi === 0 ? 'var(--blue)' : gi === 1 ? 'var(--green)' : 'var(--yellow)',
      pts: cum(rs).map((v, i) => ({ x: i, y: v })),
    }));
    const verified = seq.filter((r) => r.verified === true).length;
    const verifiedTotal = seq.filter((r) => r.verified === true || r.verified === false).length;
    return {
      total: seq.length,
      totalCost: seq.reduce((a, r) => a + r.cost, 0),
      avgCost: seq.length ? seq.reduce((a, r) => a + r.cost, 0) / seq.length : 0,
      avgTurns: seq.length ? seq.reduce((a, r) => a + r.turns, 0) / seq.length : 0,
      verifiedRate: verifiedTotal ? verified / verifiedTotal : null,
      verifiedTotal,
      avgCache: seq.filter((r) => r.cache_hit > 0).length
        ? seq.filter((r) => r.cache_hit > 0).reduce((a, r) => a + r.cache_hit, 0) / seq.filter((r) => r.cache_hit > 0).length
        : null,
      costSeries: series((r) => r.cost),
      cumSeries,
      turnsSeries: series((r) => r.turns),
      cacheSeries: series((r) => (r.cache_hit > 0 ? r.cache_hit : null)),
    };
  }, [rows]);

  if (err) return <div id="metrics" className="m-empty">度量加载失败：{err}</div>;
  if (!m) return <div id="metrics" className="m-empty">加载中…</div>;
  if (m.total === 0) return <div id="metrics" className="m-empty">暂无执行度量 —— 跑几个任务后这里会显示成本/轮次/命中率随知识积累的曲线。</div>;

  const yuan = (v: number) => `¥${v >= 0.01 ? v.toFixed(3) : v.toFixed(4)}`;
  const num = (v: number) => String(Math.round(v * 100) / 100);

  return (
    <div id="metrics">
      <div className="m-panel">
        <div className="m-card"><span className="m-k">执行次数</span><span className="m-v">{m.total}</span></div>
        <div className="m-card"><span className="m-k">总成本</span><span className="m-v">{yuan(m.totalCost)}</span></div>
        <div className="m-card"><span className="m-k">平均成本</span><span className="m-v">{yuan(m.avgCost)}</span></div>
        <div className="m-card"><span className="m-k">平均轮次</span><span className="m-v">{num(m.avgTurns)}</span></div>
        <div className="m-card">
          <span className="m-k">验收通过率</span>
          <span className="m-v">{m.verifiedRate == null ? '—' : `${Math.round(m.verifiedRate * 100)}%`}</span>
          <span className="m-s">{m.verifiedTotal ? `${m.verifiedTotal} 次验收` : '无验收标准'}</span>
        </div>
        <div className="m-card">
          <span className="m-k">平均缓存命中</span>
          <span className="m-v">{m.avgCache == null ? '—' : `${Math.round(m.avgCache * 100)}%`}</span>
          <span className="m-s">前缀分区生效度</span>
        </div>
      </div>
      <div className="m-charts">
        <Line series={m.costSeries} fmt={(v) => (v >= 0.01 ? v.toFixed(2) : v.toFixed(3))} label="单次成本（¥）" />
        <Line series={m.cumSeries} fmt={(v) => (v >= 0.01 ? v.toFixed(2) : v.toFixed(3))} label="累计成本（¥）" />
        <Line series={m.turnsSeries} fmt={(v) => String(Math.round(v))} label="轮次 / 执行" />
        <Line series={m.cacheSeries} fixedMax={1} fmt={(v) => `${Math.round(v * 100)}%`} label="缓存命中率" />
      </div>
    </div>
  );
}
