/**
 * JSONL 会话日志 tailer（观察通道，pull 式）——照 crates/observe/src/tail.rs 翻译。
 * dsh 持久化布局（compression:'none'）：<root>/<project>/<sessionId>/session.jsonl，
 * 首行为 header，其后每行一个 SessionEvent（含 type）。
 * 轮询扫描目录树、按文件字节偏移续读，逐行解析送入事件流。
 */
import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
export const POLL_INTERVAL_MS = 200

/** 一个带来源会话 id 的日志事件。 */
export interface TailEvent {
  sessionId: string
  event: Record<string, unknown>
}

/** 启动 tailer：轮询扫描 root，返回事件流（无限运行）。initialOffsets：启动恢复已读偏移。 */
export function startTailer(
  root: string,
  initialOffsets: Map<string, number>,
  onEvent: (ev: TailEvent) => void,
): () => void {
  const offsets = new Map(initialOffsets)
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const scan = (): void => {
    if (stopped) return
    for (const file of walk(root)) {
      const sessionId = basename(dirname(file))
      const off = offsets.get(file) ?? 0
      const { lines, newOff } = readLines(file, off)
      if (newOff > off) offsets.set(file, newOff)
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          onEvent({ sessionId, event })
        } catch {
          // 半行/损坏行跳过
        }
      }
    }
  }

  scan()
  timer = setInterval(scan, POLL_INTERVAL_MS)
  return () => {
    stopped = true
    if (timer) clearInterval(timer)
  }
}

/** 递归收集所有 session.jsonl 文件路径。 */
function walk(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir).map((n) => join(dir, n))
    } catch {
      continue
    }
    for (const p of entries) {
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (st.isFile() && basename(p) === 'session.jsonl') out.push(p)
    }
  }
  return out
}

/** 从字节偏移续读：返回新增完整行 + 新偏移。 */
function readLines(file: string, offset: number): { lines: string[]; newOff: number } {
  try {
    const fd = openSync(file, 'r')
    try {
      const size = statSync(file).size
      if (offset > size) offset = 0 // 文件被重建（归档/恢复）
      const remaining = size - offset
      if (remaining <= 0) return { lines: [], newOff: offset }
      const buf = Buffer.alloc(Math.min(remaining, 1 << 20))
      const n = readSync(fd, buf, 0, buf.length, offset)
      const text = buf.subarray(0, n).toString('utf8')
      // 只消费最后一个完整行；尾部半行留到下次（文件还在增长）
      const lastNl = text.lastIndexOf('\n')
      if (lastNl < 0) return { lines: [], newOff: offset }
      const complete = text.slice(0, lastNl)
      const lines = complete.split('\n').filter((l) => l.trim().length > 0)
      return { lines, newOff: offset + lastNl + 1 }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { lines: [], newOff: offset }
  }
}
