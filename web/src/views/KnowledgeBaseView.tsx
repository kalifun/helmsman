// 职责：知识库 —— 记录表 + 详情（知识债务：注入未用 / 用了还失败）。
// 记录表：Beautiful UI「Records Table」移植（MIT © Shane Levine）—— 标签 / 排序 / 关系强度。
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';
import { Button } from '../components/Button';
import { RecordsTable } from '../components/RecordsTable';
import { Markdown } from '../components/Markdown';
import { LoadingState } from '../components/LoadingState';
import { invalidateKbNote, listKbNotes, searchKbNotes, setKbNoteStable, type DebtStatus, type KbNoteRow } from '../api/client';
import { relTime } from '../store/projection';

function isPinned(n: KbNoteRow): boolean {
  return (n.tags ?? []).some((t) => t.toLowerCase() === 'stable');
}

/** 来源友好标签（表格列 + 详情用） */
const SOURCE_LABEL: Record<string, string> = {
  task: '任务沉淀',
  subagent: '子代理',
  human: '人工录入',
  project: '项目',
};

const TRUST_LABEL: Record<KbNoteRow['trust'], string> = {
  'human-approved': '人工确认',
  'agent-generated': '自动沉淀',
  unverified: '未验证',
};

const STRENGTH: Record<DebtStatus, { id: string; label: string }> = {
  useful: { id: 'strong', label: '很强' },
  idle: { id: 'weak', label: '观察中' },
  unused: { id: 'none', label: '无引用' },
  toxic: { id: 'toxic', label: '有害' },
};

/** 强度序（排序用）：无引用 < 有害 < 观察中 < 很强 */
const STRENGTH_ORDER: Record<DebtStatus, number> = { unused: 0, toxic: 1, idle: 2, useful: 3 };

type Filter = 'valid' | 'unused' | 'toxic';

function strengthOf(n: KbNoteRow): { id: string; label: string } {
  return n.debt ? STRENGTH[n.debt.status] : { id: 'weak', label: '—' };
}

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
      // M4：搜索走服务端融合检索（关键词/摘要/标签命中 + 排序 + 债务降权），不做客户端子串降级
      if (query && query.trim()) {
        setNotes(await searchKbNotes(pid, query.trim()));
      } else {
        setNotes(await listKbNotes(pid));
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
  // 顶部概览统计
  const totalCount = notes.length;
  const pinnedCount = notes.filter(isPinned).length;
  const srcCounts = notes.reduce<Record<string, number>>((acc, n) => {
    acc[n.source.kind] = (acc[n.source.kind] ?? 0) + 1;
    return acc;
  }, {});
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

  const pin = async (n: KbNoteRow, pinned: boolean) => {
    setBusy(true);
    try {
      const updated = await setKbNoteStable(n.id, pinned);
      if (updated) {
        setSelected({ ...n, ...updated, debt: n.debt });
        await load(q);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="kbview">
      <div className="ph-head">
        <h1>知识库</h1>
        <div className="ph-path">
          任务自动沉淀 · 人工录入 · 稳定前缀 · 失效审计 —— 双时态演化（version / valid_until）
        </div>
      </div>
      <div className="kb-bar">
        <div className="search">
          <Icon name="search" size="sm" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索知识库…" aria-label="搜索知识库" />
        </div>
        <div className="filters">
          <button className={'chip' + (filter === 'valid' ? ' active' : '')} onClick={() => setFilter('valid')}>有效</button>
          <button className={'chip' + (filter === 'unused' ? ' active' : '')} onClick={() => setFilter('unused')}>从未引用{unusedCount ? ` ${unusedCount}` : ''}</button>
          <button className={'chip' + (filter === 'toxic' ? ' active' : '')} onClick={() => setFilter('toxic')}>可能有毒{toxicCount ? ` ${toxicCount}` : ''}</button>
        </div>
        <div className="kb-stats">
          <span className="kb-stat">{totalCount} 条</span>
          <span className="kb-stat">📌 {pinnedCount}</span>
          {Object.entries(srcCounts).map(([k, c]) => (
            <span key={k} className="kb-stat muted">{SOURCE_LABEL[k] ?? k} {c}</span>
          ))}
        </div>
      </div>
      <div className="kb-body">
        <div className="kb-grid">
          {error ? (
            <div className="empty-state"><div className="t">加载失败</div><div className="d">{error}</div></div>
          ) : loading && notes.length === 0 ? (
            <div className="empty-state"><LoadingState variant="surfer" label="加载知识库…" /></div>
          ) : (
            <RecordsTable
              rows={visible}
              rowKey={(n) => n.id}
              selectedKey={selected?.id}
              onRow={setSelected}
              empty={(
                <div className="empty-state">
                  <Icon name="kb" />
                  <div className="t">{filter === 'valid' ? '知识库为空' : '没有这类笔记'}</div>
                  <div className="d">{filter === 'valid' ? '任务完成时，结论会自动沉淀到这里。要点进每张卡开头，打开笔记点「钉到稳定前缀」。' : '债务要等笔记被装配过几次才出现'}</div>
                </div>
              )}
              footer={<>{visible.length} 条 · {unusedCount} 从未引用 · {toxicCount} 可能有毒</>}
              columns={[
                {
                  key: 'title',
                  label: '笔记',
                  width: '28%',
                  sort: (a, b) => a.title.localeCompare(b.title, 'zh'),
                  cell: (n) => <span className="rtable-name">{n.title}</span>,
                },
                {
                  key: 'tags',
                  label: '标签',
                  width: '22%',
                  cell: (n) => (
                    <span className="rtable-tags">
                      <span className={'trust trust-' + n.trust}>{TRUST_LABEL[n.trust]}</span>
                      {isPinned(n) && <span className="trust trust-human-approved">稳定前缀</span>}
                      {n.tags.slice(0, 3).map((t) => <span key={t} className="tag">#{t}</span>)}
                    </span>
                  ),
                },
                {
                  key: 'when',
                  label: '最近',
                  width: '14%',
                  sort: (a, b) => a.validFrom - b.validFrom,
                  cell: (n) => relTime(n.validFrom),
                },
                {
                  key: 'str',
                  label: '关系',
                  width: '14%',
                  sort: (a, b) => (a.debt ? STRENGTH_ORDER[a.debt.status] : 2) - (b.debt ? STRENGTH_ORDER[b.debt.status] : 2),
                  cell: (n) => {
                    const s = strengthOf(n);
                    return <span className={'rtable-str ' + s.id}>{s.label}</span>;
                  },
                },
                {
                  key: 'src',
                  label: '来源',
                  width: '22%',
                  cell: (n) => (
                    <span className="rtable-src">
                      {SOURCE_LABEL[n.source.kind] ?? n.source.kind}
                      {n.source.ref && n.source.ref !== n.source.kind ? ` · ${n.source.ref}` : ''}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </div>
        {selected && (
        <div className="kb-main">
            <div className="note">
              <h3>{selected.title}</h3>
              <div className="note-meta">
                <span className={'trust trust-' + selected.trust}>{TRUST_LABEL[selected.trust]}</span>
                {isPinned(selected) && <span className="trust trust-human-approved">稳定前缀</span>}
                <span className="muted">来源：{SOURCE_LABEL[selected.source.kind] ?? selected.source.kind} · {new Date(selected.validFrom).toLocaleString()}</span>
              </div>
              {selected.debt && (
                <div className={'banner' + (selected.debt.status === 'toxic' ? ' warn' : selected.debt.status === 'unused' ? '' : ' ok')} style={{ marginTop: 12 }}>
                  装配 {selected.debt.injected} 次 · 引用 {selected.debt.cited} 次
                  {selected.debt.failedWhenCited > 0 ? ` · 引用后失败 ${selected.debt.failedWhenCited}` : ''}
                  {selected.debt.status === 'unused' ? ' —— 装进去了但工具/产出没碰到它' : ''}
                  {selected.debt.status === 'toxic' ? ' —— 用了之后任务更容易失败' : ''}
                </div>
              )}
              <div className="note-content"><Markdown text={selected.content.join('\n\n')} /></div>
              {selected.keywords.length > 0 && (
                <div className="note-keywords">{selected.keywords.map((k) => <span key={k} className="tag">{k}</span>)}</div>
              )}
              {selected.applicability ? (
                <div className="note-applicability">适用：{selected.applicability}</div>
              ) : null}
              {selected.antiPatterns && selected.antiPatterns.length > 0 ? (
                <div className="note-antipatterns">
                  <div className="t">禁忌 / 反模式</div>
                  <ul>{selected.antiPatterns.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </div>
              ) : null}
              {selected.validUntil === null && (
                <div style={{ marginTop: 18, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="ghost" mini disabled={busy} onClick={() => void pin(selected, !isPinned(selected))}>
                    {isPinned(selected) ? '取消稳定前缀' : '钉到稳定前缀'}
                  </Button>
                  <Button variant="plain" mini disabled={busy} onClick={() => void mute(selected.id)}>
                    不再装配
                  </Button>
                </div>
              )}
            </div>
        </div>
        )}
      </div>
    </div>
  );
}
