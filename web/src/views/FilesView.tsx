// 职责：文件视图 —— 项目工作区文件树（活状态现取）+ 文件内容预览（P2：读取接口已开）。
// 树：GET /api/projects/:pid/files（服务端安全过滤）；预览：GET /api/projects/:pid/files/read?path=（工作区内防穿越）。
// 文本用 CodeBlock（行号 + diff 识别）；二进制/超大文件给提示。
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';
import { LoadingState } from '../components/LoadingState';
import { CodeBlock } from '../components/CodeBlock';

interface FNode { name: string; type: 'file' | 'dir'; children?: FNode[] }

interface Preview {
  path: string;
  name: string;
  size: number;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export function FilesView({ pid }: { pid: string }) {
  const [tree, setTree] = useState<FNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pLoading, setPLoading] = useState(false);
  const [pErr, setPErr] = useState('');

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

  const openFile = async (path: string) => {
    setSel(path);
    setPLoading(true);
    setPErr('');
    setPreview(null);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/files/read?path=${encodeURIComponent(path)}`);
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(body.slice(0, 120) || `读取失败 (${r.status})`);
      }
      setPreview((await r.json()) as Preview);
    } catch (e) {
      setPErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPLoading(false);
    }
  };

  const renderNode = (n: FNode, path: string): React.ReactNode => (
    <div key={path}>
      <button
        className={'fx-node ' + n.type + (sel === path ? ' sel' : '')}
        onClick={() => { if (n.type === 'file') void openFile(path); }}
      >
        <Icon name={n.type === 'dir' ? 'folder' : 'doc'} size="sm" />
        {n.name}
      </button>
      {n.children?.length ? (
        <div className="fx-children">
          {n.children.map((c) => renderNode(c, path ? path + '/' + c.name : c.name))}
        </div>
      ) : null}
    </div>
  );

  const ext = preview?.name.includes('.') ? preview.name.split('.').pop()! : '';

  return (
    <div id="filesview">
      <div className="fx-side">
        <div className="fx-tree">
          {loading ? (
            <div className="empty-state"><LoadingState variant="dots" label="加载文件树…" /></div>
          ) : tree ? renderNode(tree, '') : (
            <div className="empty-state">
              <Icon name="folder" />
              <div className="t">文件树不可用</div>
              <div className="d">工作区读取失败（目录不存在或不可读）</div>
            </div>
          )}
        </div>
      </div>
      <div className="fx-main">
        {pLoading ? (
          <div className="empty-state"><LoadingState label="读取文件…" /></div>
        ) : pErr ? (
          <div className="empty-state">
            <Icon name="warn" />
            <div className="t">读取失败</div>
            <div className="d">{pErr}</div>
          </div>
        ) : preview ? (
          <>
            <div className="fname">
              {preview.name}
              <span className="muted" style={{ marginLeft: 10 }}>{preview.size.toLocaleString()} B{preview.truncated ? ' · 超出 256KB 已截断' : ''}</span>
            </div>
            <div className="fmeta">{preview.path}</div>
            {preview.binary ? (
              <div className="note" style={{ marginTop: 12 }}>二进制文件（内容不预览）</div>
            ) : preview.content ? (
              <div className="fx-preview">
                <CodeBlock code={preview.content} info={ext} />
              </div>
            ) : (
              <div className="note" style={{ marginTop: 12 }}>{preview.truncated ? '文件过大，未读取内容' : '空文件'}</div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <Icon name="folder" />
            <div className="t">未选择文件</div>
            <div className="d">从左侧选择文件，查看内容预览</div>
          </div>
        )}
        <div className="note" style={{ marginTop: 14 }}>文件内容由工作区实时读取（读取接口 P2 已开；二进制/超大文件不预览）。</div>
      </div>
      <span className="hidden">{pid}</span>
    </div>
  );
}
