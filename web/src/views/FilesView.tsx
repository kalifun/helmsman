// 职责：文件视图 —— 项目工作区文件树（活状态现取，目标契约）。
// P0 占位：结构就位（左树右预览），接口未开，空态标注，不做假文件数据。
import { useState } from 'react';
import { Icon } from '../components/icons';

interface FNode { name: string; type: 'file' | 'dir'; children?: FNode[] }

export function FilesView({ pid }: { pid: string }) {
  const [tree] = useState<FNode | null>(null); // 目标契约：GET /api/projects/:pid/files 未开
  const [sel, setSel] = useState<string | null>(null);

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
          {tree ? renderNode(tree, tree.name) : (
            <div className="empty-state">
              <Icon name="folder" />
              <div className="t">文件树未接入</div>
              <div className="d">工作区文件 = 目标契约（workspace-context 现取 · P0 未开）</div>
            </div>
          )}
        </div>
      </div>
      <div className="fx-main">
        {sel ? (
          <>
            <div className="fname">{sel.split('/').pop()}</div>
            <div className="fmeta">{sel}</div>
            <pre>{'// 文件内容由工作区监视实时现取（目标契约）'}</pre>
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
