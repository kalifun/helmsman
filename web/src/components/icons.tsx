// 职责：内联 SVG 图标集 —— 从 taskboard-v9.html 原样移植（stroke 风格，1.6 线宽，随 currentColor）。
export type IconName =
  | 'app' | 'folder' | 'board' | 'graph' | 'chat' | 'kb' | 'play' | 'plus' | 'refresh'
  | 'search' | 'warn' | 'home' | 'side' | 'gear' | 'check' | 'lock' | 'doc' | 'x';

const PATHS: Record<IconName, React.ReactNode> = {
  app: (<><rect x="1" y="1" width="14" height="14" rx="3.5" /><path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4.5" /></>),
  folder: (<path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 2h5.5A1.5 1.5 0 0 1 14.5 6.5v6A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z" />),
  board: (<><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M1.5 7.5h13M8 7.5V13" /></>),
  graph: (<><circle cx="4.5" cy="4" r="1.5" /><circle cx="12" cy="5" r="1.5" /><circle cx="8" cy="11.5" r="1.5" /><path d="M5.7 5 7 10.2M10.8 6 8.9 10.3M6 4.8h4.5" /></>),
  chat: (<path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3.5 2.8v-2.8H3.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />),
  kb: (<><path d="M8 3.6C6.4 2.9 4.7 2.9 3 3.3v9.2c1.7-.4 3.4-.4 5 .3z" /><path d="M8 3.6c1.6-.7 3.3-.7 5-.3v9.2c-1.7-.4-3.4-.4-5 .3z" /></>),
  play: (<path d="M5.5 3.5 12.5 8 5.5 12.5z" />),
  plus: (<path d="M8 3v10M3 8h10" />),
  refresh: (<><path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" /><path d="M13.5 1.5V5h-3.5" /></>),
  search: (<><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 13.5 13.5" /></>),
  warn: (<><path d="M8 2.5 14.2 13H1.8z" /><path d="M8 6.5V9.8" /></>),
  home: (<><path d="M2.5 7.5 8 3l5.5 4.5" /><path d="M4 6.5V13h8V6.5" /></>),
  side: (<><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M6 2.5v11" /></>),
  gear: (<><circle cx="8" cy="8" r="1.8" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" /></>),
  check: (<path d="M3 8.5 6.5 12 13 4.5" />),
  lock: (<><rect x="3.5" y="7.5" width="9" height="6.5" rx="1.5" /><path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" /></>),
  doc: (<><path d="M4 1.5h5.5L13 5v9.5H4z" /><path d="M9.5 1.5V5H13" /></>),
  x: (<path d="M4 4l8 8M12 4l-8 8" />),
};

export function Icon({
  name,
  size,
  className,
  style,
}: {
  name: IconName;
  size?: 'sm';
  className?: string;
  style?: React.CSSProperties;
}) {
  const cls = ['ic', size ? size : '', className || ''].filter(Boolean).join(' ');
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden="true" style={style}>
      {PATHS[name]}
    </svg>
  );
}