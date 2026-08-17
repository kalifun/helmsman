// 职责：文件视图 —— 项目工作区文件树（活状态现取）。GET /api/projects/:pid/files（服务端安全过滤）。
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';

interface FNode { name: string; type: 'file' | 'dir'; children?: FNode[] }

export function FilesView({ pid }: { pid: string }) {
  const [tree, setTree] = useState<FNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch('/api/projects/' + encodeURIComponent(pid) + '/files')
      .then((r) => r.json())
      .then((root: FNode) => { if (alive) setTree(root); })
      .catch(() => { if (alive) setTree(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [pid]);

  const renderNode = (n: FNode, path: string): React.ReactNode => (
    <div key={path}>
      <button
        className={'fx-node ' + n.type + (sel === path ? ' sel' : '')}
        onClick={() => {
          if (n.type === 'dir') return;
          setSel(path);
        }}
      >
        <Icon name={n.type === 'dir' ? 'folder' : 'doc'} size="sm" />
        {n.name}
      </button>
      {n.children?.length ? (
        <div className="fx-children">
          {n.children.map((c) => renderNode(c, path + '/' + c.name))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div id="filesview">
      <div className="fx-side">
        <div className="fx-tree">
          {loading ? (
            <div className="empty-state"><div className="t">加载中…</div></div>
          ) : tree ? renderNode(tree, tree.name) : (
            <div className="empty-state">
              <Icon name="folder" />
              <div className="t">文件树不可用</div>
              <div className="d">工作区读取失败（目录不存在或不可读）</div>
            </div>
          )}
        </div>
      </div>
      <div className="fx-main">
        {sel ? (
          <>
            <div className="fname">{sel.split('/').pop()}</div>
            <div className="fmeta">{sel}</div>
            <pre>{'文件内容预览 = 目标契约（需文件读取接口，P2 活状态监视）'}</pre>
          </>
        ) : (
          <div className="empty-state">
            <Icon name="folder" />
            <div className="t">未选择文件</div>
            <div className="d">从左侧选择文件，查看活状态（workspace-context 现取）</div>
          </div>
        )}
        <div className="note" style={{ marginTop: 14 }}>文件内容由工作区监视实时现取（AGENTS.md + 文件变化监视，spec §9 · 目标契约）。</div>
      </div>
      <span className="hidden">{pid}</span>
    </div>
  );
}
