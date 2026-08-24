// 职责：改动表（Beautiful UI「Diff Table」移植，MIT © Shane Levine）——
//   AI 提议的表格改动：列定义 + 行（选中态）+ 单元格改动标记（add 绿 / del 红删除线 / mod 黄）。
//   纯展示组件；验收证据里把 git diffstat 解析成行接入。
export type DiffCellKind = 'plain' | 'add' | 'del' | 'mod';

export interface DiffCell {
  text: string;
  kind?: DiffCellKind;
  /** chip 形态（如状态标签） */
  chip?: { label: string; dot?: boolean };
}

export interface DiffColumn {
  key: string;
  label: string;
  width?: string;
}

export interface DiffRow {
  id: string | number;
  selected?: boolean;
  cells: DiffCell[];
}

interface Props {
  title?: string;
  columns: DiffColumn[];
  rows: DiffRow[];
  footer?: string;
}

export function DiffTable({ title, columns, rows, footer }: Props) {
  return (
    <div className="difftable">
      {title ? <div className="difftable-bar">{title}</div> : null}
      <table>
        <colgroup>
          {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => <th key={c.key}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.selected ? 'sel' : undefined} aria-selected={r.selected || undefined}>
              {r.cells.map((c, i) => (
                <td key={i}>
                  {c.chip ? (
                    <span className="chip">{c.chip.dot ? <span className="dot" /> : null}{c.chip.label}</span>
                  ) : (
                    <span className={'cell' + (c.kind && c.kind !== 'plain' ? ' ' + c.kind : '')}>{c.text}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer ? <div className="difftable-foot">{footer}</div> : null}
    </div>
  );
}

/**
 * 解析 `git diff --stat` 输出为 DiffTable 行。
 * 行格式：` path/to/file | 12 +++++-------`（+ 数 = 增，- 数 = 删，总和 = 变动行数）
 * 尾行（"N files changed, X insertions(+), Y deletions(-)"）作为 footer。
 */
export function parseDiffStat(stat: string): { rows: DiffRow[]; footer?: string } {
  const rows: DiffRow[] = [];
  let footer: string | undefined;
  let n = 0;
  for (const raw of stat.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s+([+-]+)/);
    if (m) {
      const [, file, count, marks] = m;
      const adds = [...marks].filter((c) => c === '+').length;
      const dels = [...marks].filter((c) => c === '-').length;
      rows.push({
        id: n++,
        cells: [
          { text: file.trim() },
          { text: count, kind: 'plain' },
          { text: String(adds), kind: adds > 0 ? 'add' : 'plain' },
          { text: String(dels), kind: dels > 0 ? 'del' : 'plain' },
        ],
      });
    } else if (/files? changed/.test(line)) {
      footer = line.trim();
    }
  }
  return { rows, footer };
}
