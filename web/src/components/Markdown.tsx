// 轻量 Markdown 渲染（无依赖）——支持标题/加粗/斜体/行内代码/代码块/列表/表格/分隔线。
// 用途：计划内容、agent 消息等 markdown 文本展示（不引大库，避免构建链负担）。
// 代码块走 CodeBlock（Beautiful UI 移植）：行号 listing；unified diff 可切 Code/Diff。
import { useMemo, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';

/** 行内格式：**加粗**、*斜体*、`代码` */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else parts.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** 解析一行表格：| a | b | → ['a','b'] */
function splitTableRow(line: string): string[] {
  return line.split('|').slice(1, -1).map((s) => s.trim());
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.split('\n');
    const out: ReactNode[] = [];
    let i = 0;
    let k = 0;
    while (i < lines.length) {
      const line = lines[i];
      // 代码块
      if (line.trim().startsWith('```')) {
        const info = line.trim().slice(3);
        const buf: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
        i++; // 跳过闭合 ```
        out.push(<CodeBlock key={k++} code={buf.join('\n')} info={info} />);
        continue;
      }
      // 标题
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        const level = h[1].length;
        const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
        out.push(<Tag key={k++} className="md-h">{inline(h[2])}</Tag>);
        i++;
        continue;
      }
      // 分隔线
      if (/^\s*[-*_]{3,}\s*$/.test(line)) {
        out.push(<hr key={k++} className="md-hr" />);
        i++;
        continue;
      }
      // 表格（当前行含 | 且下一行是分隔行）
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const header = splitTableRow(line);
        const body: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|')) { body.push(splitTableRow(lines[i])); i++; }
        out.push(
          <table key={k++} className="md-table">
            <thead><tr>{header.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>{row.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>,
        );
        continue;
      }
      // 列表（- / * / 数字.）
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]/.test(line);
        const items: ReactNode[] = [];
        const re = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/;
        while (i < lines.length && re.test(lines[i])) {
          items.push(<li key={i}>{inline(re.exec(lines[i])![1])}</li>);
          i++;
        }
        out.push(ordered
          ? <ol key={k++} className="md-ol">{items}</ol>
          : <ul key={k++} className="md-ul">{items}</ul>);
        continue;
      }
      // 普通行
      if (line.trim()) {
        out.push(<p key={k++} className="md-p">{inline(line)}</p>);
      }
      i++;
    }
    return out;
  }, [text]);

  return <div className="md">{blocks}</div>;
}
