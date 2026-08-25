// 职责：洞察卡（Beautiful UI「Insight Cards」移植，MIT © Shane Levine）——
//   分页洞察 + 可 scrub 的折线（指针滑动读点）+ 对比行。纯展示，CTA 经回调上抛。
import { useMemo, useState, type ReactNode } from 'react';

export interface InsightSpark {
  label: string;
  value: string;
  /** 正 = 绿升，负 = 红降 */
  delta?: number;
}

export interface InsightPage {
  id: string;
  body: ReactNode;
  sparks?: InsightSpark[];
  /** 可 scrub 的序列（空则不画图） */
  series?: number[];
  seriesLabel?: string;
  fmt?: (v: number) => string;
  cta?: { label: string; onClick: () => void };
}

function Scrub({ pts, fmt }: { pts: number[]; fmt: (v: number) => string }) {
  const [idx, setIdx] = useState<number | null>(null);
  const W = 320, H = 56, L = 8, R = 8, T = 8, B = 8;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(...pts, 1);
  const xOf = (i: number) => (pts.length <= 1 ? L + iw / 2 : L + (i / (pts.length - 1)) * iw);
  const yOf = (v: number) => T + ih - (v / max) * ih;
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
  const cur = idx != null ? pts[idx] : pts[pts.length - 1];
  const curI = idx ?? pts.length - 1;

  const at = (clientX: number, el: SVGSVGElement) => {
    const box = el.getBoundingClientRect();
    const x = (clientX - box.left) / box.width;
    setIdx(Math.max(0, Math.min(pts.length - 1, Math.round(x * (pts.length - 1)))));
  };

  return (
    <div className="insight-scrub">
      <svg
        width={W}
        height={H}
        className="insight-svg"
        onMouseMove={(e) => at(e.clientX, e.currentTarget)}
        onMouseLeave={() => setIdx(null)}
      >
        {d ? <path d={d} fill="none" className="insight-path" /> : null}
        <circle cx={xOf(curI)} cy={yOf(cur)} r={3.2} className="insight-dot" />
      </svg>
      <span className="insight-readout">#{curI + 1} · {fmt(cur)}</span>
    </div>
  );
}

interface Props {
  pages: InsightPage[];
}

export function InsightCards({ pages }: Props) {
  const [i, setI] = useState(0);
  const n = pages.length;
  const page = pages[Math.min(i, Math.max(0, n - 1))];
  const fmt = page?.fmt ?? ((v: number) => String(v));
  const series = useMemo(() => page?.series?.filter((v) => Number.isFinite(v)) ?? [], [page]);

  if (!page || n === 0) return null;

  return (
    <div className="insight">
      <div className="insight-head">
        <span className="insight-kicker">洞察 {i + 1}<em>/{n}</em></span>
        <span className="insight-nav">
          <button type="button" className="insight-arrow" disabled={i <= 0} onClick={() => setI((v) => v - 1)} aria-label="上一条">‹</button>
          <button type="button" className="insight-arrow" disabled={i >= n - 1} onClick={() => setI((v) => v + 1)} aria-label="下一条">›</button>
        </span>
      </div>
      <div className="insight-body">{page.body}</div>
      {page.sparks && page.sparks.length > 0 ? (
        <div className="insight-sparks">
          {page.sparks.map((s) => (
            <div key={s.label} className="insight-spark">
              <span className="sl">{s.label}</span>
              {s.delta != null ? (
                <span className={'sd ' + (s.delta >= 0 ? 'up' : 'down')}>
                  {s.delta >= 0 ? '+' : ''}{(s.delta * 100).toFixed(2)}%
                </span>
              ) : null}
              <span className="sv">{s.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {series.length > 1 ? (
        <div className="insight-chart">
          <div className="insight-chart-lab">{page.seriesLabel ?? '趋势'}</div>
          <Scrub key={page.id} pts={series} fmt={fmt} />
        </div>
      ) : null}
      {page.cta ? (
        <div className="insight-foot">
          <button type="button" className="btn mini" onClick={page.cta.onClick}>{page.cta.label}</button>
        </div>
      ) : null}
    </div>
  );
}
