// 职责：WS 客户端 —— /api/events 事件镜像订阅：指数退避重连（1s→2s→4s→…封顶 30s）、
// 连接状态通知、事件回调。真实服务广播全部会话的原始 dsh 日志事件（{type,seq,time,data}，
// 仅 session 事件自带会话 id）；前端以事件为「变化信号」驱动投影刷新，重连后按 last_seq 追平（REST 重拉）。
import type { WsEvent } from '../store/projection';

export type ConnState = 'online' | 'reconnect';

export interface EventsClientOpts {
  url?: string;
  onEvent: (ev: WsEvent) => void;
  /** 断连/重连状态变化（online / reconnect） */
  onState: (s: ConnState) => void;
  /** 成功重连后回调（前端借此按 last_seq 追平：重拉当前投影） */
  onReconnect?: () => void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export class EventsClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opts: EventsClientOpts;

  constructor(opts: EventsClientOpts) {
    this.opts = opts;
  }

  connect() {
    this.closed = false;
    this.open();
  }

  private open() {
    const url = this.opts.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
    this.opts.onState('reconnect');
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.attempt = 0;
      this.opts.onState('online');
      this.opts.onReconnect?.();
    };
    this.ws.onmessage = (e) => {
      try {
        this.opts.onEvent(JSON.parse(String(e.data)) as WsEvent);
      } catch {
        /* 忽略无法解析的帧 */
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      // onclose 随后触发统一重连
      try { this.ws?.close(); } catch { /* ignore */ }
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    this.attempt += 1;
    this.opts.onState('reconnect');
    this.timer = setTimeout(() => this.open(), delay);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}
