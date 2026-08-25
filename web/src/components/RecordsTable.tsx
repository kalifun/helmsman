// 职责：记录表（Beautiful UI「Records Table」移植，MIT © Shane Levine）——
//   CRM 式网格：可排序列 + 标签 + 选中行。纯展示，排序在组件内，行点击上抛。
import { useMemo, useState, type ReactNode } from 'react';

export interface RecordsCol<T> {
  key: string;
  label: string;
  width?: string;
  /** 提供则可点表头排序 */
  sort?: (a: T, b: T) => number;
  cell: (row: T) => ReactNode;
}

interface Props<T> {
  columns: RecordsCol<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onRow?: (row: T) => void;
  footer?: ReactNode;
  empty?: ReactNode;
}

export function RecordsTable<T>({ columns, rows, rowKey, selectedKey, onRow, footer, empty }: Props<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);

  const shown = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const copy = [...rows];
    copy.sort((a, b) => col.sort!(a, b) * dir);
    return copy;
  }, [rows, columns, sortKey, dir]);

  const toggle = (key: string, sortable: boolean) => {
    if (!sortable) return;
    if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setDir(1); }
  };

  return (
    <div className="rtable">
      <table>
        <colgroup>
          {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.sort ? 'sort' : undefined}
                aria-sort={sortKey === c.key ? (dir === 1 ? 'ascending' : 'descending') : undefined}
                onClick={() => toggle(c.key, !!c.sort)}
              >
                {c.label}
                {c.sort ? <span className="rtable-caret">{sortKey === c.key ? (dir === 1 ? '↑' : '↓') : ''}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="rtable-empty">{empty ?? '无记录'}</td>
            </tr>
          ) : shown.map((row) => {
            const id = rowKey(row);
            return (
              <tr
                key={id}
                className={(onRow ? 'hit' : '') + (selectedKey === id ? ' sel' : '')}
                onClick={onRow ? () => onRow(row) : undefined}
              >
                {columns.map((c) => <td key={c.key}>{c.cell(row)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer ? <div className="rtable-foot">{footer}</div> : null}
    </div>
  );
}
