// 职责：筛选表（Beautiful UI「Filter Table」移植，MIT © Shane Levine）——
//   顶部状态 chips 重组表格；chip 计数来自当前 rows（可与外层搜索叠加）。
import { useMemo, type ReactNode } from 'react';

export interface FilterChip {
  id: string;
  label: string;
}

export interface FilterCol<T> {
  key: string;
  label: string;
  width?: string;
  cell: (row: T) => ReactNode;
}

interface Props<T> {
  chips: FilterChip[];
  /** 当前 chip；'all' = 不筛 */
  value: string;
  onChange: (id: string) => void;
  chipOf: (row: T) => string;
  columns: FilterCol<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRow?: (row: T) => void;
  empty?: ReactNode;
}

export function FilterTable<T>({
  chips, value, onChange, chipOf, columns, rows, rowKey, onRow, empty,
}: Props<T>) {
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: rows.length };
    rows.forEach((r) => {
      const id = chipOf(r);
      m[id] = (m[id] ?? 0) + 1;
    });
    return m;
  }, [rows, chipOf]);

  const shown = value === 'all' ? rows : rows.filter((r) => chipOf(r) === value);
  const visibleChips = chips.filter((c) => c.id === 'all' || (counts[c.id] ?? 0) > 0);

  return (
    <div className="ftable">
      <div className="ftable-chips" role="tablist">
        {visibleChips.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={value === c.id}
            className={'ftable-chip' + (value === c.id ? ' on' : '')}
            onClick={() => onChange(c.id)}
          >
            {c.label}
            <b>{counts[c.id] ?? 0}</b>
          </button>
        ))}
      </div>
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
          {shown.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="ftable-empty">{empty ?? '无匹配'}</td>
            </tr>
          ) : shown.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRow ? 'hit' : undefined}
              onClick={onRow ? () => onRow(row) : undefined}
            >
              {columns.map((c) => <td key={c.key}>{c.cell(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
