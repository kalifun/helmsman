// 职责：轨迹会话视图（dsh ui-trajectory 机制参考，不抄代码）——
//   虚拟化窗口（只渲染可见行+缓冲，200+ 条流畅）、滚动锚定（默认跟尾部，上滚暂停跟随）、
//   流式尾部隔离（Running 时新活动只在尾部追加）、回合分组 + 工具 call/result 合并。
// 数据模型沿用 drawer 的 toRows（活动 → 行），交互机制按 dsh 设计重做。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Activity, TaskState } from '../store/projection';
import { useProjection, estCost, cacheHitOf } from '../store/projection';

export interface TrajRow {
  idx: number;
  turn: number;
  at?: number;
  kind: 'text' | 'think' | 'tool';
  name?: string;
  args?: string;
  err?: boolean;
  text?: string;
  ms?: number;
}

/** 活动 → 轨迹行（合并 ToolStart/ToolResult；带 at/turn 供分组与耗时） */
export function toRows(t: TaskState): TrajRow[] {
  const toolById: Record<string, { args: string }> = {};
  (t.tool_calls || []).forEach((tc) => { toolById[tc.call_id] = tc; });
  const rows: TrajRow[] = [];
  const acts = t.activities;
  let i = 0;
  while (i < acts.length) {
    const a: Activity = acts[i];
    if ('ToolStart' in a) {
      let res: Activity | null = null;
      let j = i + 1;
      if (j < acts.length && 'ToolResult' in acts[j]) { res = acts[j]; j++; }
      const tr = res && 'ToolResult' in res ? res.ToolResult : null;
      const startAt = a.ToolStart.at;
      rows.push({
        idx: i, turn: a.ToolStart.turn ?? 0, at: startAt,
        kind: 'tool', name: a.ToolStart.name,
        args: tr ? toolById[tr.name]?.args : '',
        err: tr ? tr.is_error : false,
        ms: startAt != null && tr?.at != null ? Math.max(0, tr.at - startAt) : undefined,
      });
      i = j;
    } else if ('Reasoning' in a) {
      rows.push({ idx: i, turn: a.Reasoning.turn ?? 0, at: a.Reasoning.at, kind: 'think', text: a.Reasoning.text }); i++;
    } else if ('Text' in a) {
      rows.push({ idx: i, turn: a.Text.turn ?? 0, at: a.Text.at, kind: 'text', text: a.Text.text }); i++;
    } else { i++; }
  }
  return rows;
}

// ---------- 虚拟化参数 ----------
const ROW_H = 32;        // 估算行高（px）
const BUFFER = 10;       // 窗口上下缓冲行数
const OVERSCAN = 60;     // 触底加载更多（px）

interface Props {
  task: TaskState;
  stream?: string;
}

export function TrajectoryView({ task, stream }: Props) {
  const usage = useProjection((s) => s.usage);
  const execUsage = usage[task.id];
  const cost = estCost(execUsage);
  const hit = cacheHitOf(execUsage);
  const rows = useMemo(() => toRows(task), [task]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 锚定状态：'tail' = 跟随尾部；'paused' = 用户上滚暂停跟随
  const [follow, setFollow] = useState<'tail' | 'paused'>('tail');
  // 可见窗口 [start, end)
  const [range, setRange] = useState<[number, number]>([0, 40]);
  const total = rows.length + (stream ? 1 : 0);

  const running = task.status === 'Running' || (task.waiting !== null && task.waiting !== undefined);

  // 滚动容器高度（虚拟化视口）
  const viewportH = 320;

  // 滚动处理：判断是否在底部（锚定尾部）还是用户上滚（暂停跟随）
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < OVERSCAN) {
      if (follow === 'paused') setFollow('tail');
    } else {
      setFollow('paused');
    }
    // 计算可见窗口
    const firstVisible = Math.max(0, Math.floor(el.scrollTop / ROW_H) - BUFFER);
    const visibleCount = Math.ceil(el.clientHeight / ROW_H) + BUFFER * 2;
    setRange([firstVisible, Math.min(total, firstVisible + visibleCount)]);
  };

  // 流式/数据变化：若在跟随尾部，滚到底；若暂停，保持位置（不打断检查）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (follow === 'tail') {
      el.scrollTop = el.scrollHeight;
      // 同步窗口到底部
      const last = Math.max(0, Math.ceil(el.scrollHeight / ROW_H) - 1);
      const visibleCount = Math.ceil(el.clientHeight / ROW_H) + BUFFER * 2;
      setRange([Math.max(0, last - visibleCount), Math.min(total, last + BUFFER)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, follow]);

  // 首次挂载锚定尾部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const base = task.started_at ?? rows[0]?.at;
  const offset = (at?: number): string => {
    if (at == null || base == null) return '';
    const ms = at - base;
    return '+' + (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
  };

  // 按回合分组（只对窗口内的行分组，保持结构）
  const groups = useMemo(() => {
    const [start, end] = range;
    const out: { turn: number; rows: TrajRow[] }[] = [];
    for (let i = start; i < end && i < rows.length; i++) {
      const r = rows[i];
      const g = out[out.length - 1];
      if (!g || g.turn !== r.turn) out.push({ turn: r.turn, rows: [r] });
      else g.rows.push(r);
    }
    return out;
  }, [rows, range]);

  const topPad = range[0] * ROW_H;
  const bottomPad = Math.max(0, (rows.length - range[1]) * ROW_H);

  return (
    <div className="traj-scroll" ref={scrollRef} onScroll={onScroll} style={{ height: viewportH, overflowY: 'auto' }}>
      <div className="sess-meta">
        <span className="kv">模型 <b>{task.model || '-'}</b></span>
        <span className="kv">回合 <b>{task.turns ?? 0}</b></span>
        <span className="kv">步骤 <b>{task.steps ?? 0}</b></span>
        <span className="kv">seq <b>{task.last_seq ?? 0}</b></span>
        {follow === 'paused' ? <span className="traj-follow-hint" title="点击回到最新">⏸ 已暂停跟随 · 滚到底部恢复</span> : null}
      </div>

      {groups.length === 0 && !stream && <div className="ph-empty">暂无轨迹（引擎执行中或未开始）</div>}

      {/* 虚拟化：顶部占位 + 可见行 + 底部占位 */}
      {topPad > 0 ? <div style={{ height: topPad }} /> : null}
      {groups.map((g) => (
        <div key={g.turn} className="traj-group">
          <div className="traj-group-head">回合 {g.turn || 1}</div>
          {g.rows.map((r) => renderRow(r, offset(r.at)))}
        </div>
      ))}
      {bottomPad > 0 ? <div style={{ height: bottomPad }} /> : null}

      {running && stream ? (
        <div className="traj-row" data-kind="text" data-stream="true">
          <span className="traj-dot" />
          <span className="traj-index">▌</span>
          <span className="traj-text">{stream}</span>
        </div>
      ) : null}
      {running ? <div className="sess-caret">▌</div> : null}

      {execUsage ? (
        <div className="cost-block">
          <div className="t">回合成本（本执行）</div>
          <div className="cost-row">
            <span>
              输入 {execUsage.inputTokens.toLocaleString()} · 输出 {execUsage.outputTokens.toLocaleString()} · 缓存读 {execUsage.cacheReadTokens.toLocaleString()} · 思考 {execUsage.reasoningTokens.toLocaleString()}
            </span>
          </div>
          <div className="cost-row"><span>缓存命中率（本执行）</span><b>{hit == null ? '—' : Math.round(hit * 100) + '%'}</b></div>
          <div className="cost-row total"><span>估算</span><span>¥ {cost == null ? '—' : cost.toFixed(4)}</span></div>
        </div>
      ) : null}
    </div>
  );
}

function renderRow(r: TrajRow, time: string) {
  if (r.kind === 'think') {
    return (
      <details key={r.idx} className="traj-row" data-kind="think">
        <summary className="traj-main">
          <span className="traj-dot" />
          <span className="traj-index">#{r.idx + 1}</span>
          <span className="traj-text">{r.text?.slice(0, 60) || '思考'}</span>
          <span className="traj-time">{time}</span>
        </summary>
        <div className="traj-detail think">{r.text}</div>
      </details>
    );
  }
  if (r.kind === 'tool') {
    const isErr = r.err;
    return (
      <details key={r.idx} className="traj-row" data-kind="tool" data-err={isErr || undefined}>
        <summary className="traj-main">
          <span className="traj-dot" />
          <span className="traj-index">#{r.idx + 1}</span>
          <span className="traj-tool-name">{r.name}</span>
          <span className={r.err ? 'err' : 'ok'}>{r.err ? '失败' : '成功'}</span>
          {r.ms != null ? <span className="traj-ms">{r.ms} ms</span> : null}
          <span className="traj-time">{time}</span>
        </summary>
        {r.args ? <div className="traj-detail mono">{r.args}</div> : null}
      </details>
    );
  }
  const errCls = (r.text || '').indexOf('失败') === 0 ? ' err' : '';
  return (
    <div key={r.idx} className="traj-row" data-kind="text">
      <span className="traj-dot" />
      <span className="traj-index">#{r.idx + 1}</span>
      <span className={'traj-text' + errCls}>{r.text}</span>
      <span className="traj-time">{time}</span>
    </div>
  );
}
