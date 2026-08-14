// 职责：任务投影 store（zustand）+ 状态推导。投影形状 {pid:{cardId:CardState}} 来自真实 REST；
// M2.3（O1=B）：卡 = 资产（1 卡 N 执行），执行 = 会话；看板状态 = 最新执行代次。
// WS 事件是「变化信号」：驱动防抖重拉（增量按 last_seq 追平），并在 activeSession 边界内折叠 usage。
// 红线 2：阻塞（依赖未完成）每次渲染现算（depsUnmet 纯函数），绝不写状态字段。
// 红线 4：成本/缓存命中按 usage 数据计算，会话级（usage 从 WS assistant/message 累积，无 usage 显示 —）。
import { create } from 'zustand';
import * as api from '../api/client';

// ---------- 真实契约类型（docs/frontend-design-v1.md §3.2，形状以服务为准） ----------
export type TaskStatus = 'Pending' | 'Running' | 'Done' | 'Failed' | 'Cancelled';

/** WS /api/events 事件（dsh 会话日志事件镜像：{type,seq,time,data}；session 事件自带 id） */
export interface WsEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

/** 轨迹活动（服务端 fold 带 at=事件时间 ms、turn=归属回合；dsh 轨迹模型的时间/回合维度） */
export type Activity =
  | { Text: { text: string; at?: number; turn?: number } }
  | { Reasoning: { text: string; at?: number; turn?: number } }
  | { ToolStart: { name: string; at?: number; turn?: number } }
  | { ToolResult: { name: string; is_error: boolean; at?: number; turn?: number } };

export interface ToolCall {
  call_id: string;
  name: string;
  args: string;
  is_error: boolean;
}

/** assistant/message.usage（真实字段，实测形状） */
export interface Usage {
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** 评论线程条目（评论 = 唯一控制通道；服务端 fold user/assistant message 产出） */
export interface Comment {
  who: 'user' | 'agent';
  text: string;
  at: number;                 // epoch ms
}

/** 执行 = 会话（D1.2 1:1）；TaskState 是看板卡的执行单元（1 卡 N 执行里的 N） */
export interface TaskState {
  id: string;                 // = dsh 会话 id（opaque，UI 不解析）
  status: TaskStatus;
  title?: string;
  model?: string;
  turns: number;
  steps: number;
  tool_calls: ToolCall[];
  activities: Activity[];     // 有界队列（MAX_ACTIVITIES=200，服务侧）
  comments?: Comment[];       // 评论线程（P0.5：服务端已产出）
  started_at?: number;
  finished_at?: number;
  last_seq: number;           // 已折叠到的日志 seq（增量同步水位）
  recovered: boolean;         // 服务重启后从会话日志重放标记
  /** Waiting 判别联合（§2.5）：非空 = 任务停在等待批复 */
  waiting?: { kind: 'plan' | 'permission' | 'acceptance' | 'cost'; reason: string; payload: Record<string, unknown> } | null;
  /** 执行启动时的预设快照（§2.6：执行契约，随任务生命周期延续） */
  preset?: { id: string; name: string; mode: string; setting: string; approval: string; sandbox: string } | null;
}

/** 资产卡（O1=B）：卡 = 需求/缺陷/任务 + 里程碑，挂 executions（1 卡 N 执行） */
export interface CardState {
  id: string;                 // 卡 id（opaque）
  title: string;
  description?: string;
  kind?: string;              // 'requirement' | 'bug' | 'task'
  milestone?: string | null;
  executions: Record<string, TaskState>;  // sid → 执行（键 = 会话 id）
  exec_order?: string[];      // 执行代次顺序（创建序；末位 = 最新）
  created_at?: number;
  execution_count?: number;
  project_id?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  card_count: number;
  /** 状态计数 [Pending, Running, Done, Failed, Cancelled]（按卡的最新执行状态；列表轻量渲染） */
  counts?: [number, number, number, number, number];
}

// ---------- 执行经济学（§6 规格：定价表为配置项，前端按此估算） ----------
/** 定价表（每 M token，¥）：输入 2 / 输出 8 / 缓存读 0.2 / 思考 8 */
export const EST_PRICE = { input: 2.0, output: 8.0, cacheRead: 0.2, reasoning: 8.0 } as const;

/** 会话级估算成本（¥）；无 usage → null */
export function estCost(u?: Usage | null): number | null {
  if (!u) return null;
  return (
    (u.inputTokens || 0) / 1e6 * EST_PRICE.input +
    (u.outputTokens || 0) / 1e6 * EST_PRICE.output +
    (u.cacheReadTokens || 0) / 1e6 * EST_PRICE.cacheRead +
    (u.reasoningTokens || 0) / 1e6 * EST_PRICE.reasoning
  );
}

/** 会话级缓存命中率 = cacheRead / (cacheRead + input)；无 usage → null（spec §6.2 每回合/每会话聚合） */
export function cacheHitOf(u?: Usage | null): number | null {
  if (!u) return null;
  const denom = (u.cacheReadTokens || 0) + (u.inputTokens || 0);
  if (denom <= 0) return null;
  return u.cacheReadTokens / denom;
}

/** 平均缓存命中率（跨当前任务集，会话级数值聚合）；无数据 → null */
export function avgCacheHit(tasks: TaskState[], usage: Record<string, Usage>): number | null {
  const hits: number[] = [];
  tasks.forEach((t) => {
    const h = cacheHitOf(usage[t.id]);
    if (h != null) hits.push(h);
  });
  if (!hits.length) return null;
  return hits.reduce((a, b) => a + b, 0) / hits.length;
}

// ---------- 状态推导（红线 2：全部现算，不存储） ----------
/** 有效状态 = 存储状态（真实 API 无 Waiting；Waiting 属目标契约，服务新增后自然流入） */
export function effectiveStatus(t: TaskState): TaskStatus | 'Waiting' {
  // 目标契约：Waiting（待确认）是 approval 缝状态；task.waiting 非空 = 任务停在等待批复
  if (t.waiting) return 'Waiting';
  return t.status as TaskStatus | 'Waiting';
}

/** 卡的最新一次执行（1 卡 N 执行的展示面；exec_order 优先，缺失回退字典序兜底） */
export function latestExecution(card: CardState | undefined | null): TaskState | null {
  if (!card) return null;
  const order = card.exec_order?.length ? card.exec_order : Object.keys(card.executions);
  const sid = order[order.length - 1];
  return (sid && card.executions[sid]) || null;
}

/** 卡状态 = 最新执行状态（无执行 = Pending） */
export function cardStatus(card: CardState | undefined | null): TaskStatus | 'Waiting' {
  const t = latestExecution(card);
  return t ? effectiveStatus(t) : 'Pending';
}

/** 执行代次列表（按 exec_order，缺省字典序） */
export function executionList(card: CardState | undefined | null): TaskState[] {
  if (!card) return [];
  const order = card.exec_order?.length ? card.exec_order : Object.keys(card.executions);
  return order.map((sid) => card.executions[sid]).filter(Boolean);
}

/** 依赖未完成（目标契约：TaskState.deps 未开，形状来自 engine-spec §2/architecture taskgraph）。
 *  每次渲染现算：返回未完成依赖的标题列表。 */
export function depsUnmet(t: TaskState, tasksById: Record<string, TaskState>): string[] {
  const deps = (t as TaskState & { deps?: string[] }).deps;
  if (!deps || !deps.length) return [];
  return deps
    .map((d) => tasksById[d])
    .filter((dep): dep is TaskState => !!dep && dep.status !== 'Done')
    .map((dep) => dep.title || dep.id);
}

/** 活动摘要文本（看板卡末条/首页正在发生用） */
export function activityText(a: Activity): string {
  if ('Reasoning' in a) return a.Reasoning.text;
  if ('ToolStart' in a) return `工具 · ${a.ToolStart.name}`;
  if ('ToolResult' in a) return `结果 · ${a.ToolResult.name} · ${a.ToolResult.is_error ? '失败' : '成功'}`;
  return a.Text.text;
}

export function statusCounts(tasks: TaskState[]): Record<TaskStatus | 'Waiting', number> {
  const c: Record<TaskStatus | 'Waiting', number> = { Pending: 0, Running: 0, Done: 0, Failed: 0, Cancelled: 0, Waiting: 0 };
  tasks.forEach((t) => { c[effectiveStatus(t)] += 1; });
  return c;
}

export function fmtTime(ms?: number): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

export function relTime(ms?: number): string {
  if (ms == null) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

export type ConnState = 'online' | 'reconnect' | 'offline';

interface ProjectionState {
  projects: Record<string, Project>;
  cards: Record<string, Record<string, CardState>>;  // pid → cardId → CardState（1 卡 N 执行）
  usage: Record<string, Usage>;                       // sid → 会话级 usage（WS 累积）
  /** sid → assistant/chunk 流式文本尾巴（activeSession 边界内累积；重拉后 activities 完整，流式仅 Running 显示） */
  streams: Record<string, string>;
  loading: boolean;                                   // 初始加载
  error: string | null;
  conn: ConnState;
  maxEventSeq: number;                                // WS 事件 seq 水位
  activeSessionId: string | null;                     // WS session 事件边界（usage 归属）
  revision: number;                                   // 任何投影变化 +1（视图/防抖刷新订阅用）
  loadProjects: () => Promise<void>;
  loadProject: (pid: string) => Promise<void>;
  loadCard: (cardId: string) => Promise<void>;
  loadTask: (sid: string) => Promise<void>;
  createCard: (pid: string, input: api.CreateCardInput) => Promise<string | null>;
  /** fork：卡上派生新执行代次（from_execution_id 可选）；返回新执行（会话）id */
  forkExecution: (cardId: string, fromExecutionId?: string) => Promise<string | null>;
  cancelTask: (sid: string) => Promise<boolean>;
  postComment: (sid: string, text: string) => Promise<boolean>;
  /** 显式注册项目（POST /api/projects）→ 刷新项目列表 → 返回注册结果 */
  registerProject: (path: string, name?: string) => Promise<Project | null>;
  /** 移除项目（archive=仅移除可恢复 / purge=彻底清理）；返回是否成功 */
  removeProject: (pid: string, mode: 'archive' | 'purge') => Promise<boolean>;
  applyWsEvent: (ev: WsEvent) => void;
  setConn: (s: ConnState) => void;
  bump: () => void;
}

export const useProjection = create<ProjectionState>((set, get) => ({
  projects: {},
  cards: {},
  usage: {},
  streams: {},
  loading: true,
  error: null,
  conn: 'offline',
  maxEventSeq: 0,
  activeSessionId: null,
  revision: 0,

  loadProjects: async () => {
    try {
      const ps = await api.listProjects();
      set((s) => {
        const projects = { ...s.projects };
        ps.forEach((p) => { projects[p.id] = p; });
        return { projects, loading: false, error: null };
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadProject: async (pid) => {
    try {
      const p = await api.getProject(pid);
      set((s) => {
        const cards = { ...s.cards, [pid]: p.cards };
        const projects = { ...s.projects, [pid]: { id: p.id, name: p.name, path: p.path, card_count: Object.keys(p.cards).length } };
        return { cards, projects, error: null };
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadCard: async (cardId) => {
    try {
      const c = await api.getCard(cardId);
      set((s) => {
        const pid = c.project_id || Object.keys(s.cards).find((k) => s.cards[k][cardId]);
        if (!pid) return { error: `card ${cardId} 归属未知` };
        return { cards: { ...s.cards, [pid]: { ...s.cards[pid], [cardId]: c } } };
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadTask: async (sid) => {
    try {
      const t = await api.getTask(sid);
      set((s) => {
        // 按 sid 反查所属卡（cards 字典内扫描执行）
        for (const pid of Object.keys(s.cards)) {
          for (const cardId of Object.keys(s.cards[pid])) {
            if (s.cards[pid][cardId].executions[sid]) {
              return {
                cards: {
                  ...s.cards,
                  [pid]: {
                    ...s.cards[pid],
                    [cardId]: { ...s.cards[pid][cardId], executions: { ...s.cards[pid][cardId].executions, [sid]: t } },
                  },
                },
              };
            }
          }
        }
        return {};
      });
    } catch { /* 单任务拉取失败不阻断整体 */ }
  },

  createCard: async (pid, input) => {
    try {
      const r = await api.createCard(pid, input);
      set((s) => ({ revision: s.revision + 1 }));
      await get().loadProject(pid);
      return r.card_id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  forkExecution: async (cardId, fromExecutionId) => {
    try {
      const r = await api.forkExecution(cardId, fromExecutionId);
      set((s) => ({ revision: s.revision + 1 }));
      await get().loadCard(cardId);
      return r.session_id;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  cancelTask: async (sid) => {
    try {
      const ok = await api.cancelTask(sid);
      if (ok) set((s) => ({ revision: s.revision + 1 }));
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  postComment: async (sid, text) => {
    try {
      const ok = await api.postComment(sid, text);
      if (ok) set((s) => ({ revision: s.revision + 1 }));
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  registerProject: async (path, name) => {
    try {
      const p = await api.createProject(path, name);
      set((s) => ({ projects: { ...s.projects, [p.id]: p }, error: null }));
      await get().loadProjects();
      return p;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  removeProject: async (pid, mode) => {
    try {
      const ok = await api.removeProject(pid, mode);
      if (ok) {
        set((s) => {
          const projects = { ...s.projects };
          delete projects[pid];
          const cards = { ...s.cards };
          delete cards[pid];
          return { projects, cards, revision: s.revision + 1 };
        });
        await get().loadProjects();
      }
      return ok;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  // WS 事件折叠（轻量）：session 事件记边界；assistant/message 折叠 usage；其余只抬水位。
  // 投影本身以 REST 重拉为准（服务 fold 是权威），事件只负责「何时刷新」。
  applyWsEvent: (ev) => {
    const patch: Partial<ProjectionState> = {};
    if (ev.type === 'session' && (ev as WsEvent & { id?: string }).id) {
      patch.activeSessionId = (ev as WsEvent & { id: string }).id;
      // 新执行（会话）入投影由服务端 fold + 防抖重拉承担（卡 id 未知，不做本地占位）。
    }
    if (ev.type === 'assistant/chunk') {
      const c = ev.data?.chunk as { type?: string; text?: string } | undefined;
      if (c?.type === 'text-delta' && c.text) {
        const sid = get().activeSessionId;
        if (sid) {
          patch.streams = { ...get().streams, [sid]: (get().streams[sid] || '') + c.text };
        }
      }
    }
    if (ev.type === 'assistant/message' && ev.data?.usage) {
      const u = ev.data.usage as Usage;
      if (u.inputTokens || u.outputTokens || u.cacheReadTokens || u.reasoningTokens) {
        const sid = get().activeSessionId;
        if (sid) {
          const prev = get().usage[sid] || { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
          patch.usage = {
            ...get().usage,
            [sid]: {
              cacheReadTokens: (prev.cacheReadTokens || 0) + (u.cacheReadTokens || 0),
              inputTokens: (prev.inputTokens || 0) + (u.inputTokens || 0),
              outputTokens: (prev.outputTokens || 0) + (u.outputTokens || 0),
              reasoningTokens: (prev.reasoningTokens || 0) + (u.reasoningTokens || 0),
            },
          };
        }
      }
    }
    if (typeof ev.seq === 'number' && ev.seq > get().maxEventSeq) {
      patch.maxEventSeq = ev.seq;
    }
    patch.revision = get().revision + 1;
    set(patch);
  },

  setConn: (s) => set({ conn: s }),
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** 同步目标：当前视图需要拉的数据（pid 与 openId 由 UI store 提供，防抖后调用）。
 *  待注册项目（本地 pending）服务端 404，跳过拉取；首张卡 POST 后由服务注册。 */
export function refreshTargets(pid: string | null, openId: string | null, home: boolean) {
  const p = useProjection.getState();
  if (home || !pid) {
    p.loadProjects();
    return;
  }
  const { pendingProjects } = useUiStoreRef.getState();
  if (!pendingProjects[pid]) p.loadProject(pid);
  if (openId) p.loadCard(openId);
}

// 延迟引用避免循环 import（ui store 引用 projection 的类型）
import { useUi as useUiStoreRef } from './ui';