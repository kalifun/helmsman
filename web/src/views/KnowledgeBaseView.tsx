// 职责：知识库 —— 双栏（搜索 + 过滤 chips + 笔记列表 / 笔记详情）。
// M4：后端已实现 GET/POST /api/kb/notes + /api/kb/search（双时态 + 信任分级）。
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';

interface KbNote {
  id: string;
  project_id: string;
  title: string;
  content: string[];
  tags: string[];
  keywords: string[];
  summary: string;
  links: string[];
  source: { kind: string; ref: string };
  validFrom: number;
  validUntil: number | null;
  invalidatedBy?: string;
  version: number;
  trust: 'human-approved' | 'agent-generated' | 'unverified';
  createdAt: number;
  updatedAt: number;
}

const TRUST_LABEL: Record<KbNote['trust'], string> = {
  'human-approved': '人工确认',
  'agent-generated': '自动沉淀',
  unverified: '未验证',
};

export function KnowledgeBaseView({ pid }: { pid: string }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'valid' | 'all'>('valid');
  const [notes, setNotes] = useState<KbNote[]>([]);
  const [selected, setSelected] = useState<KbNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      if (query && query.trim()) {
        const r = await fetch(`/api/kb/search?project=${encodeURIComponent(pid)}&q=${encodeURIComponent(query)}`);
        const hits = (await r.json()) as Array<{ note: KbNote; score: number }>;
        setNotes(hits.map((h) => h.note));
      } else {
        const r = await fetch(`/api/kb/notes?project=${encodeURIComponent(pid)}`);
        setNotes((await r.json()) as KbNote[]);
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

  const visible = filter === 'valid' ? notes.filter((n) => n.validUntil === null) : notes;

  return (
    <div id="kbview">
      <div className="kb-side">
        <div className="search">
          <Icon name="search" size="sm" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索知识库…" aria-label="搜索知识库" />
        </div>
        <div className="filters">
          <button className={'chip' + (filter === 'valid' ? ' active' : '')} onClick={() => setFilter('valid')}>只看有效</button>
          <button className={'chip' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>全部</button>
        </div>
        <div className="kb-list">
          {error && <div className="empty-state"><div className="t">加载失败</div><div className="d">{error}</div></div>}
          {!error && loading && notes.length === 0 && <div className="empty-state"><div className="d">加载中…</div></div>}
          {!error && !loading && visible.length === 0 && (
            <div className="empty-state">
              <Icon name="kb" />
              <div className="t">知识库为空</div>
              <div className="d">任务完成时，结论会自动沉淀到这里</div>
            </div>
          )}
          {visible.map((n) => (
            <div key={n.id} className={'kb-item' + (selected?.id === n.id ? ' active' : '')} onClick={() => setSelected(n)}>
              <div className="kb-item-title">{n.title}</div>
              <div className="kb-item-meta">
                <span className={'trust trust-' + n.trust}>{TRUST_LABEL[n.trust]}</span>
                {n.validUntil !== null && <span className="invalidated">已失效</span>}
                {n.tags.slice(0, 3).map((t) => <span key={t} className="tag">#{t}</span>)}
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
            {selected.content.map((line, i) => <p key={i}>{line}</p>)}
            {selected.keywords.length > 0 && (
              <div className="note-keywords">{selected.keywords.map((k) => <span key={k} className="tag">{k}</span>)}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
