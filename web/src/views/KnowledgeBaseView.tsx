// 职责：知识库 —— 双栏 + 知识债务（注入未用 / 用了还失败）。
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';
import { Button } from '../components/Button';
import { invalidateKbNote, listKbNotes, type DebtStatus, type KbNoteRow } from '../api/client';

const TRUST_LABEL: Record<KbNoteRow['trust'], string> = {
  'human-approved': '人工确认',
  'agent-generated': '自动沉淀',
  unverified: '未验证',
};

const DEBT_LABEL: Record<DebtStatus, string> = {
  idle: '观察中',
  useful: '在用',
  unused: '从未引用',
  toxic: '可能有毒',
};

type Filter = 'valid' | 'unused' | 'toxic';

export function KnowledgeBaseView({ pid }: { pid: string }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('valid');
  const [notes, setNotes] = useState<KbNoteRow[]>([]);
  const [selected, setSelected] = useState<KbNoteRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listKbNotes(pid);
      if (query && query.trim()) {
        const ql = query.trim().toLowerCase();
        setNotes(rows.filter((n) => n.title.toLowerCase().includes(ql) || n.content.join(' ').toLowerCase().includes(ql)));
      } else {
        setNotes(rows);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [pid]);

  useEffect(() => {
    const t = setTimeout(() => void load(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const unusedCount = notes.filter((n) => n.debt?.status === 'unused').length;
  const toxicCount = notes.filter((n) => n.debt?.status === 'toxic').length;
  const visible = notes.filter((n) => {
    if (n.validUntil !== null) return false;
    if (filter === 'unused') return n.debt?.status === 'unused';
    if (filter === 'toxic') return n.debt?.status === 'toxic';
    return true;
  });

  const mute = async (id: string) => {
    setBusy(true);
    try {
      if (await invalidateKbNote(id)) {
        setSelected(null);
        await load(q);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="kbview">
      <div className="kb-side">
        <div className="search">
          <Icon name="search" size="sm" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索知识库…" aria-label="搜索知识库" />
        </div>
        <div className="filters">
          <button className={'chip' + (filter === 'valid' ? ' active' : '')} onClick={() => setFilter('valid')}>有效</button>
          <button className={'chip' + (filter === 'unused' ? ' active' : '')} onClick={() => setFilter('unused')}>从未引用{unusedCount ? ` ${unusedCount}` : ''}</button>
          <button className={'chip' + (filter === 'toxic' ? ' active' : '')} onClick={() => setFilter('toxic')}>可能有毒{toxicCount ? ` ${toxicCount}` : ''}</button>
        </div>
        <div className="kb-list">
          {error && <div className="empty-state"><div className="t">加载失败</div><div className="d">{error}</div></div>}
          {!error && loading && notes.length === 0 && <div className="empty-state"><div className="d">加载中…</div></div>}
          {!error && !loading && visible.length === 0 && (
            <div className="empty-state">
              <Icon name="kb" />
              <div className="t">{filter === 'valid' ? '知识库为空' : '没有这类笔记'}</div>
              <div className="d">{filter === 'valid' ? '任务完成时，结论会自动沉淀到这里' : '债务要等笔记被装配过几次才出现'}</div>
            </div>
          )}
          {visible.map((n) => (
            <div key={n.id} className={'kb-item' + (selected?.id === n.id ? ' active' : '')} onClick={() => setSelected(n)}>
              <div className="kb-item-title">{n.title}</div>
              <div className="kb-item-meta">
                <span className={'trust trust-' + n.trust}>{TRUST_LABEL[n.trust]}</span>
                {n.debt && n.debt.status !== 'idle' && (
                  <span className={'trust trust-' + (n.debt.status === 'toxic' ? 'unverified' : n.debt.status === 'unused' ? 'agent-generated' : 'human-approved')}>
                    {DEBT_LABEL[n.debt.status]}
                  </span>
                )}
                {n.tags.slice(0, 2).map((t) => <span key={t} className="tag">#{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="kb-main">
        {!selected && <div className="ph-empty">选择左侧笔记查看详情</div>}
        {selected && (
          <div className="note">
            <h3>{selected.title}</h3>
            <div className="note-meta">
              <span className={'trust trust-' + selected.trust}>{TRUST_LABEL[selected.trust]}</span>
              <span className="muted">来源：{selected.source.kind} · {new Date(selected.validFrom).toLocaleString()}</span>
            </div>
            {selected.debt && (
              <div className={'banner' + (selected.debt.status === 'toxic' ? ' warn' : selected.debt.status === 'unused' ? '' : ' ok')} style={{ marginTop: 12 }}>
                装配 {selected.debt.injected} 次 · 引用 {selected.debt.cited} 次
                {selected.debt.failedWhenCited > 0 ? ` · 引用后失败 ${selected.debt.failedWhenCited}` : ''}
                {selected.debt.status === 'unused' ? ' —— 装进去了但工具/产出没碰到它' : ''}
                {selected.debt.status === 'toxic' ? ' —— 用了之后任务更容易失败' : ''}
              </div>
            )}
            {selected.content.map((line, i) => <p key={i}>{line}</p>)}
            {selected.keywords.length > 0 && (
              <div className="note-keywords">{selected.keywords.map((k) => <span key={k} className="tag">{k}</span>)}</div>
            )}
            {selected.validUntil === null && (
              <div style={{ marginTop: 18 }}>
                <Button variant="plain" mini disabled={busy} onClick={() => void mute(selected.id)}>
                  不再装配
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
