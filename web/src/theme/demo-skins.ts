// 职责：示例皮肤包（Skin System v2 demo）—— 展示两种换装能力：
//   1.「鲸」：token 覆盖皮肤（深海蓝金，呼应品牌 🐳）—— 只改色板，几行数据
//   2.「宣纸」：彻底变装（theme.css）—— 改字体/圆角/侧栏/卡片，可见"换了一个产品"
// 用法：设置 → 主题 → 导入皮肤（web/src/theme/demo-skins/ 下文件），或直接用下方 JSON。
import type { UserSkin } from './skin';

export const WHALE_SKIN: UserSkin = {
  id: 'demo-whale',
  name: '鲸 · 深海蓝金',
  tokens: {
    canvas: '#0A1424',
    surface: '#101D33',
    surface2: '#16243E',
    line: '#1F3050',
    line2: '#2E4470',
    text: '#E8EEF8',
    text2: '#9FB3D0',
    text3: '#6C82A6',
    ink: '#F4F8FF',
    blue: '#4FA3E8',
    green: '#5BC8A8',
    yellow: '#E8C15A',
    red: '#F0806E',
    gray: '#9FB3D0',
    bgBlue: 'rgba(60,120,210,.24)',
    bgGreen: 'rgba(60,160,130,.22)',
    bgYellow: 'rgba(190,150,50,.22)',
    bgRed: 'rgba(190,70,60,.24)',
    bgGray: 'rgba(255,255,255,.06)',
    onPrimary: '#0A1424',
    toastBg: '#1F3050',
    toastFg: '#E8EEF8',
    shimmer: 'rgba(255,255,255,.06)',
    shadowHover: '0 2px 10px rgba(0,0,0,.3)',
    shadowFloat: '0 12px 32px rgba(0,0,0,.42)',
  },
  createdAt: 0,
};

export const PAPER_SKIN: UserSkin = {
  id: 'demo-paper',
  name: '宣纸 · 彻底变装',
  css: `
/* 宣纸皮肤：字体 + 圆角 + 侧栏 + 卡片的彻底变装 demo */
:root {
  --font: "Songti SC", "STSong", "Noto Serif SC", Georgia, serif;
  --mono: "SF Mono", "Songti SC", monospace;
  --r-sm: 2px; --r-md: 4px; --r-lg: 8px;
}
body { letter-spacing: .01em; }
#app .sidebar,
.app-sidebar,
aside, nav[class*="side"] {
  background: linear-gradient(180deg, var(--canvas), var(--surface)) !important;
  border-right: 1px solid var(--line) !important;
}
.kcard, .panel, .appr-card, .task-card {
  border-radius: var(--r-lg) !important;
  box-shadow: none !important;
  border: 1px solid var(--line) !important;
}
h1, h2, h3, .kt, .appr-title { font-weight: 600 !important; }
`,
  createdAt: 0,
};

/** 示例皮肤 JSON（可直接存成 theme.json 导入） */
export const DEMO_JSON = (skin: UserSkin): string => JSON.stringify({
  id: skin.id,
  name: skin.name,
  tokens: skin.tokens,
  css: skin.css ?? '',
}, null, 2);
