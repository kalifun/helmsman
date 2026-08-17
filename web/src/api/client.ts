// 职责：REST 封装 —— 真实接口（契约见 docs/frontend-design-v1.md §3.1，形状以服务为准）。
// M2.3：资产卡两层 —— 卡（O1=B，1 卡 N 执行）为主资源；执行 = 会话（按 sid 操作）。
// 走 Vite dev proxy（/api → 127.0.0.1:3081，服务无 CORS 头，必须同源代理）。
import type { Project, TaskState } from '../store/projection';

const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = body.slice(0, 200);
    } catch { /* ignore */ }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

/** GET /api/projects —— 项目列表 [{id,name,path,card_count,counts}] */
export function listProjects(): Promise<Project[]> {
  return req<Project[]>('/projects');
}

/** GET /api/projects/:pid —— 项目详情 {id,name,path,cards:{<cardId>:CardState}}（cards 是字典） */
export async function getProject(pid: string): Promise<{ id: string; name: string; path: string; cards: Record<string, CardState> }> {
  return req('/projects/' + encodeURIComponent(pid));
}

/** GET /api/projects/:pid/cards —— 卡列表（轻量：最新执行状态 + 里程碑 + 执行次数） */
export interface CardSummary {
  id: string;
  title: string;
  description: string;
  kind: string;
  milestone?: string | null;
  execution_count: number;
  created_at?: number;
  latest?: {
    session_id: string;
    status: string;
    title?: string | null;
    started_at?: number | null;
    finished_at?: number | null;
  } | null;
}
export function listCards(pid: string): Promise<CardSummary[]> {
  return req<CardSummary[]>('/projects/' + encodeURIComponent(pid) + '/cards');
}

/** GET /api/cards/:cardId —— 卡详情（全部执行代次，executions 字典键 = 会话 id） */
export interface CardDetail {
  id: string;
  title: string;
  description: string;
  kind: string;
  milestone?: string | null;
  deps?: string[];          // 依赖契约：完成本卡前需先完成的卡 id
  criteria?: string | null; // 需求契约：验收标准（D1.7 校准批准后写回）
  created_at?: number;
  execution_count: number;
  project_id?: string;
  executions: Record<string, TaskState>;
  exec_order?: string[];
}
export function getCard(cardId: string): Promise<CardDetail> {
  return req<CardDetail>('/cards/' + encodeURIComponent(cardId));
}

/** POST /api/projects/:pid/cards —— 建卡（资产）+ 首代执行（建卡即自动跑）；201 {card_id, session_id} */
export interface CreateCardInput {
  title: string;
  description?: string;
  kind?: string; // 'requirement' | 'bug' | 'task'
  milestone?: string;
  preset?: string; // agent preset id（每任务工具/人格组装）
  deps?: string[]; // 依赖契约：同项目已存在卡的 id（完成本卡前需先完成）
  calibrate?: boolean; // D1.6 时机①：先校准需求（AI 提案验收标准 → 确认 → 写回）再执行
}
export async function createCard(pid: string, input: CreateCardInput): Promise<{ card_id: string; session_id: string }> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { card_id: string; session_id: string };
}

/** POST /api/cards/:cardId/status —— 手动标记状态（设计状态机：拖拽/手动标记完成/失败/待办） */
export async function markStatus(cardId: string, status: 'Done' | 'Failed' | 'Pending'): Promise<boolean> {
  const res = await fetch(BASE + '/cards/' + encodeURIComponent(cardId) + '/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return res.ok;
}

/** POST /api/cards/:cardId/executions —— 卡上起新执行代次（fork：from_execution_id 派生）；
 *  新会话 = 新执行，原执行事件流保留供 diff。 */
export async function forkExecution(cardId: string, fromExecutionId?: string): Promise<{ session_id: string; forked_from?: string | null }> {
  const res = await fetch(BASE + '/cards/' + encodeURIComponent(cardId) + '/executions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fromExecutionId ? { from_execution_id: fromExecutionId } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { session_id: string; forked_from?: string | null };
}

/** POST /api/cards/:cardId/calibrate —— D1.7 需求校准（AI 探索提案验收标准 → 确认 → 写回） */
export async function calibrateCard(cardId: string): Promise<{ session_id: string }> {
  const res = await fetch(BASE + '/cards/' + encodeURIComponent(cardId) + '/calibrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { session_id: string };
}

/** GET /api/tasks/:sid —— 单次执行（= 会话）TaskState（按 sid，不是卡 id） */
export function getTask(sid: string): Promise<TaskState> {
  return req<TaskState>('/tasks/' + encodeURIComponent(sid));
}

/** POST /api/tasks/:sid/comments —— 评论 = 唯一控制通道（评论即控制：指示/引导/批复）；
 *  服务端经 ACP session/prompt 发给引擎，WS user/message + assistant/message 回流评论线程。 */
export async function postComment(sid: string, text: string): Promise<boolean> {
  const res = await fetch(BASE + '/tasks/' + encodeURIComponent(sid) + '/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error('comment ' + res.status);
  const data = (await res.json()) as { ok?: boolean };
  return data.ok === true;
}

/** POST /api/tasks/:sid/cancel —— 停止；{ok:true} */
export async function cancelTask(sid: string): Promise<boolean> {
  const res = await fetch(BASE + '/tasks/' + encodeURIComponent(sid) + '/cancel', { method: 'POST' });
  if (!res.ok) throw new Error('cancel ' + res.status);
  const data = (await res.json()) as { ok?: boolean };
  return data.ok === true;
}

/** POST /api/fs/pick —— 服务端弹系统「选择文件夹」对话框，直接返回绝对路径（取消 → cancelled） */
export async function pickFs(): Promise<{ cancelled: boolean; path?: string }> {
  const res = await fetch(BASE + '/fs/pick', { method: 'POST' });
  if (!res.ok) throw new Error('fs/pick ' + res.status);
  return (await res.json()) as { cancelled: boolean; path?: string };
}

/** GET /api/fs/list?path= —— 本地目录浏览（新建项目选目录；目录优先，过滤隐藏项） */
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
}
export interface FsList {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}
export function listFs(path?: string): Promise<FsList> {
  const q = path ? '?path=' + encodeURIComponent(path) : '';
  return req<FsList>('/fs/list' + q);
}

/** DELETE /api/projects/:pid —— 移除项目。
 *  mode=archive：仅移除可恢复（会话日志归档 + SQLite 标记，重新导入同目录自动恢复）
 *  mode=purge：彻底清理（删会话日志 + 记录）；均不动用户项目文件 */
export async function removeProject(pid: string, mode: 'archive' | 'purge'): Promise<boolean> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error('remove ' + res.status);
  const data = (await res.json()) as { ok?: boolean };
  return data.ok === true;
}

/** POST /api/projects —— 显式注册项目（设计文档 §5.1 建议接口；id 由 name 推导，幂等） */
export async function createProject(path: string, name?: string): Promise<Project> {
  const res = await fetch(BASE + '/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { path, name } : { path }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as Project;
}

import type { CardState } from '../store/projection';
// ---------- 批复队列（P0：Waiting 状态机） ----------

export interface ApprovalItem {
  id: number;
  project_id: string;
  execution_id: string;
  kind: 'plan' | 'permission' | 'acceptance' | 'cost' | 'calibrate' | 'checkpoint';
  payload: Record<string, unknown>;
  reason: string | null;
  outcome: 'approved' | 'rejected' | 'suspended' | null;
  comment: string | null;
  created_at: number;
  decided_at: number | null;
  suspended_at: number | null;
  task_title?: string;
  card_id?: string | null;
  card_kind?: string | null;
  /** 策略建议（P1 O6）：同类批复历史沉淀，count>=2；{ scope, outcome, count } | null */
  policy_suggestion?: { scope: string; outcome: 'approved' | 'rejected'; count: number } | null;
}

/** GET /api/approvals?project= —— 待批复队列 */
export function listApprovals(pid: string): Promise<ApprovalItem[]> {
  return req<ApprovalItem[]>('/approvals?project=' + encodeURIComponent(pid));
}

/** POST /api/tasks/:sid/waiting —— 触发 Waiting{kind}（测试/控制用） */
export async function triggerWaiting(sid: string, kind: string, reason: string): Promise<boolean> {
  const res = await fetch(BASE + '/tasks/' + encodeURIComponent(sid) + '/waiting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, reason }),
  });
  return res.ok;
}

/** POST /api/approvals/:id —— 决策（approve/reject + 评论送达 agent）；remember=true 沉淀策略原子 */
export async function decideApproval(id: number, outcome: 'approved' | 'rejected', comment: string, remember = false): Promise<boolean> {
  const res = await fetch(BASE + '/approvals/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome, comment, remember }),
  });
  return res.ok;
}

// ---------- 策略学习（P1 O6：规则可查看可删除） ----------

export interface PolicyRow {
  id: number;
  project_id: string;
  kind: string;
  scope: string;
  outcome: 'approved' | 'rejected';
  count: number;
  created_at: number;
  updated_at: number;
}

export function listPolicies(pid: string): Promise<PolicyRow[]> {
  return req<PolicyRow[]>('/policies?project=' + encodeURIComponent(pid));
}

export async function deletePolicy(id: number): Promise<boolean> {
  const res = await fetch(BASE + '/policies/' + id, { method: 'DELETE' });
  return res.ok;
}

/** GET /api/approvals/suspended —— 挂起批复（O5：Waiting 超时自动挂起） */
export function listSuspendedApprovals(pid: string): Promise<ApprovalItem[]> {
  return req<ApprovalItem[]>('/approvals/suspended?project=' + encodeURIComponent(pid));
}

/** POST /api/approvals/:id/resume —— 恢复单条挂起（原会话从 Waiting 点继续） */
export async function resumeApproval(id: number): Promise<boolean> {
  const res = await fetch(BASE + '/approvals/' + id + '/resume', { method: 'POST' });
  return res.ok;
}

/** POST /api/projects/:pid/approvals/resume-all —— 批量恢复 */
export async function resumeAllApprovals(pid: string): Promise<boolean> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/approvals/resume-all', { method: 'POST' });
  return res.ok;
}

/** GET /api/presets —— 可用 agent 预设（每任务工具/人格组装） */
export interface PresetInfo { id: string; name: string; description: string }
export function listPresets(): Promise<PresetInfo[]> {
  return req<PresetInfo[]>('/presets');
}

// ---------- 预设 Profile（P0 §2.6：三轴组合 = 命名 Profile） ----------

export interface Profile {
  id: string;
  project_id: string;
  name: string;
  is_builtin: boolean;
  mode: 'normal' | 'plan' | 'goal';
  setting: 'light' | 'balanced' | 'delivery';
  approval: 'ask' | 'auto' | 'yolo';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  is_default: boolean;
}

/** GET /api/projects/:pid/presets —— Profile 列表（含三轴 + 默认标记） */
export function listProfiles(pid: string): Promise<Profile[]> {
  return req<Profile[]>('/projects/' + encodeURIComponent(pid) + '/presets');
}

/** POST /api/projects/:pid/presets —— 自定义 Profile（三轴存新） */
export async function createProfile(pid: string, input: Omit<Profile, 'project_id' | 'is_builtin' | 'is_default'>): Promise<Profile | null> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  return (await res.json()) as Profile;
}

/** POST /api/projects/:pid/presets/:id/default —— 设项目默认 */
export async function setDefaultProfile(pid: string, id: string): Promise<boolean> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/presets/' + encodeURIComponent(id) + '/default', { method: 'POST' });
  return res.ok;
}

/** 三轴 → 中文标签（建卡下拉/预设管理展示） */
export const MODE_LABEL: Record<Profile['mode'], string> = { normal: '常规', plan: '计划', goal: '目标' };
export const SETTING_LABEL: Record<Profile['setting'], string> = { light: '轻量', balanced: '均衡', delivery: '交付' };
export const APPROVAL_LABEL: Record<Profile['approval'], string> = { ask: '询问', auto: '自动', yolo: 'Yolo（全放手）' };
export const SANDBOX_LABEL: Record<Profile['sandbox'], string> = { 'read-only': '只读', 'workspace-write': '写项目', 'danger-full-access': '全放开' };

export function profileSummary(p: Profile): string {
  return `${MODE_LABEL[p.mode]} × ${SETTING_LABEL[p.setting]} × ${APPROVAL_LABEL[p.approval]}`;
}

// ---------- 度量（M4 §5.2 序列任务曲线 / 度量面板） ----------

/** 单次执行度量（metrics 表行） */
export interface MetricRow {
  id: number;
  project_id: string;
  task_id: string;
  brief_snapshot: Array<{ id: string; title: string; score: number }>;
  outcome: string;
  cited_entries: string[];
  turns: number;
  steps: number;
  group_tag?: string;
  verified?: boolean;
  cost: number;
  cache_hit: number;
  in_tokens: number;
  cache_tokens: number;
  out_tokens: number;
  reason_tokens: number;
  created_at: number;
}

/** GET /api/metrics?project= —— 项目全部执行度量（按时间倒序，前端转正序画序列曲线） */
export function getMetrics(pid: string): Promise<MetricRow[]> {
  return req<MetricRow[]>('/metrics?project=' + encodeURIComponent(pid));
}

// ---------- 简单会话（A 组：两级制松入口） ----------

export interface ChatSummary {
  session_id: string;
  status: string;
  turns: number;
  steps: number;
  last_text: string | null;
  started_at: number | null;
}

/** POST /api/projects/:pid/chats —— 创建独立会话（不挂卡） */
export async function createChat(pid: string): Promise<{ session_id: string }> {
  const res = await fetch(BASE + '/projects/' + encodeURIComponent(pid) + '/chats', { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as { session_id: string };
}

export function listChats(pid: string): Promise<ChatSummary[]> {
  return req<ChatSummary[]>('/projects/' + encodeURIComponent(pid) + '/chats');
}

export function getChat(sid: string): Promise<TaskState> {
  return req<TaskState>('/chats/' + encodeURIComponent(sid));
}

/** POST /api/chats/:sid —— 发消息（阻塞到 agent end_turn） */
export async function sendChat(sid: string, text: string): Promise<{ stop_reason: string }> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as { stop_reason: string };
}

/** POST /api/chats/:sid/promote —— 提升为任务（会话上下文进简报 → 建卡自动跑） */
export async function promoteChat(sid: string, input: { title?: string; description?: string }): Promise<{ card_id: string; session_id: string }> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid) + '/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as { card_id: string; session_id: string };
}

/** POST /api/chats/:sid/kb —— 存入知识库（会话结论 → KB 笔记） */
export async function saveChatToKb(sid: string, title?: string): Promise<{ note_id: string }> {
  const res = await fetch(BASE + '/chats/' + encodeURIComponent(sid) + '/kb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as { note_id: string };
}
