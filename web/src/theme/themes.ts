// 职责：主题契约数据（THEME CONTRACT）——每套主题 = 完整 25 键 token 包 + 氛围 atmo spec。
// 来源：taskboard-v9.html 的 THEMES 数组，原样移植，不做增删改；新增主题 = 追加一个数据对象。
// 语义 token 25 键：canvas/surface/surface2/line/line2/text/text2/text3/ink/blue/green/yellow/red/gray/
//   bgBlue/bgGreen/bgYellow/bgRed/bgGray/onPrimary/toastBg/toastFg/shimmer/shadowHover/shadowFloat

export interface AtmoGlow {
  type: 'glow';
  color: string;
  pos: string;
}
export interface AtmoStars {
  type: 'stars';
  count: number;
  color: string;
}
export interface AtmoBlob {
  x: string;
  y: string;
  r: string;
  c: string;
}
export interface AtmoBlobs {
  type: 'blobs';
  blobs: AtmoBlob[];
}

export type AtmoSpec = AtmoGlow | AtmoStars | AtmoBlobs;

export interface Theme {
  id: string;
  name: string;
  en: string;
  /** 来源标记：builtin（内置）/ custom（导入的自定义主题） */
  tag?: 'builtin' | 'custom';
  /** 色板预览（3 个主色） */
  sw: string[];
  /** 25 键语义 token */
  tokens: Record<TokenKey, string>;
  /** 氛围 spec（光晕 / 星空 / 光斑） */
  atmo: AtmoSpec;
}

export type TokenKey =
  | 'canvas' | 'surface' | 'surface2' | 'line' | 'line2'
  | 'text' | 'text2' | 'text3' | 'ink' | 'blue' | 'green' | 'yellow' | 'red' | 'gray'
  | 'bgBlue' | 'bgGreen' | 'bgYellow' | 'bgRed' | 'bgGray'
  | 'onPrimary' | 'toastBg' | 'toastFg' | 'shimmer' | 'shadowHover' | 'shadowFloat';

/** token 注入映射：themes.ts 键 → CSS 变量名（CSSOM setProperty 用） */
export const TK_MAP: Record<TokenKey, string> = {
  canvas: '--canvas', surface: '--surface', surface2: '--surface2', line: '--line', line2: '--line2',
  text: '--text', text2: '--text2', text3: '--text3', ink: '--ink', blue: '--blue', green: '--green',
  yellow: '--yellow', red: '--red', gray: '--gray', bgBlue: '--bg-blue', bgGreen: '--bg-green',
  bgYellow: '--bg-yellow', bgRed: '--bg-red', bgGray: '--bg-gray', onPrimary: '--on-primary',
  toastBg: '--toast-bg', toastFg: '--toast-fg', shimmer: '--shimmer',
  shadowHover: '--shadow-hover', shadowFloat: '--shadow-float',
};

export const THEMES: Theme[] = [
  { id: 'mist', name: '晨雾', en: 'mist', sw: ['#F7F6F3', '#FFFFFF', '#1C1B19'],
    tokens: { canvas: '#F7F6F3', surface: '#FFFFFF', surface2: '#F9F9F8', line: '#EAEAEA', line2: '#D9D9D5',
      text: '#1C1B19', text2: '#5F5E5A', text3: '#8A8985', ink: '#111111', blue: '#1F6C9F', green: '#346538',
      yellow: '#956400', red: '#9F2F2D', gray: '#8A8985', bgBlue: '#E1F3FE', bgGreen: '#EDF3EC',
      bgYellow: '#FBF3DB', bgRed: '#FDEBEC', bgGray: '#F1F0EE', onPrimary: '#FFFFFF', toastBg: '#111111',
      toastFg: '#FFFFFF', shimmer: 'rgba(255,255,255,.55)', shadowHover: '0 2px 10px rgba(0,0,0,.05)',
      shadowFloat: '0 12px 32px rgba(28,27,25,.12)' },
    atmo: { type: 'glow', color: 'rgba(224,190,140,.20)', pos: '60% 0%' } },
  { id: 'night', name: '夜航', en: 'night', sw: ['#151412', '#1D1B19', '#EDEAE4'],
    tokens: { canvas: '#151412', surface: '#1D1B19', surface2: '#232120', line: '#2E2B28', line2: '#3D3935',
      text: '#EDEAE4', text2: '#A6A098', text3: '#7C766D', ink: '#EDEAE4', blue: '#7CB6E8', green: '#6FCB8B',
      yellow: '#E3B85C', red: '#F07A70', gray: '#A6A098', bgBlue: 'rgba(31,108,159,.28)', bgGreen: 'rgba(52,101,56,.28)',
      bgYellow: 'rgba(149,100,0,.24)', bgRed: 'rgba(159,47,45,.26)', bgGray: 'rgba(255,255,255,.08)',
      onPrimary: '#151412', toastBg: '#2E2B28', toastFg: '#EDEAE4', shimmer: 'rgba(255,255,255,.07)',
      shadowHover: '0 2px 10px rgba(0,0,0,.28)', shadowFloat: '0 12px 32px rgba(0,0,0,.4)' },
    atmo: { type: 'stars', count: 70, color: 'rgba(255,255,255,.38)' } },
  { id: 'glacier', name: '冰原', en: 'glacier', sw: ['#F5F7FA', '#FFFFFF', '#2563EB'],
    tokens: { canvas: '#F5F7FA', surface: '#FFFFFF', surface2: '#F0F2F5', line: '#E4E7EC', line2: '#C9CFD8',
      text: '#1B1F27', text2: '#5A6474', text3: '#8B94A3', ink: '#1B1F27', blue: '#2563EB', green: '#1A7F4E',
      yellow: '#9A6B00', red: '#C0392B', gray: '#8B94A3', bgBlue: '#E8F0FE', bgGreen: '#E6F4EC',
      bgYellow: '#FCF4DC', bgRed: '#FDEBEA', bgGray: '#F0F2F5', onPrimary: '#FFFFFF', toastBg: '#1B1F27',
      toastFg: '#FFFFFF', shimmer: 'rgba(255,255,255,.55)', shadowHover: '0 2px 10px rgba(27,31,39,.07)',
      shadowFloat: '0 12px 32px rgba(27,31,39,.14)' },
    atmo: { type: 'glow', color: 'rgba(140,180,240,.18)', pos: '50% 0%' } },
  { id: 'abyss', name: '深海', en: 'abyss', sw: ['#0B1220', '#101A2E', '#6CB0F5'],
    tokens: { canvas: '#0B1220', surface: '#101A2E', surface2: '#16233C', line: '#1E2D49', line2: '#2C4066',
      text: '#DCE6F5', text2: '#8FA3C0', text3: '#64799B', ink: '#DCE6F5', blue: '#6CB0F5', green: '#63D1A0',
      yellow: '#E9C05A', red: '#F07A70', gray: '#8FA3C0', bgBlue: 'rgba(41,98,173,.28)', bgGreen: 'rgba(28,109,86,.28)',
      bgYellow: 'rgba(142,100,16,.26)', bgRed: 'rgba(159,47,45,.26)', bgGray: 'rgba(255,255,255,.07)',
      onPrimary: '#0B1220', toastBg: '#1B2A45', toastFg: '#DCE6F5', shimmer: 'rgba(255,255,255,.07)',
      shadowHover: '0 2px 10px rgba(0,0,0,.3)', shadowFloat: '0 12px 32px rgba(0,0,0,.42)' },
    atmo: { type: 'blobs', blobs: [{ x: '22%', y: '8%', r: '420px', c: 'rgba(64,120,220,.20)' }, { x: '85%', y: '88%', r: '380px', c: 'rgba(38,80,160,.16)' }] } },
  { id: 'moss', name: '青苔', en: 'moss', sw: ['#12170F', '#1A2116', '#8FBF6A'],
    tokens: { canvas: '#12170F', surface: '#1A2116', surface2: '#222B1D', line: '#2A3424', line2: '#3C4A33',
      text: '#E7EADF', text2: '#A3AA92', text3: '#767E66', ink: '#E7EADF', blue: '#7FB3A1', green: '#8FBF6A',
      yellow: '#D9B45A', red: '#E08A74', gray: '#A3AA92', bgBlue: 'rgba(41,98,80,.3)', bgGreen: 'rgba(70,110,45,.3)',
      bgYellow: 'rgba(120,92,25,.28)', bgRed: 'rgba(120,45,30,.28)', bgGray: 'rgba(255,255,255,.06)',
      onPrimary: '#12170F', toastBg: '#2A3424', toastFg: '#E7EADF', shimmer: 'rgba(255,255,255,.06)',
      shadowHover: '0 2px 10px rgba(0,0,0,.28)', shadowFloat: '0 12px 32px rgba(0,0,0,.4)' },
    atmo: { type: 'blobs', blobs: [{ x: '78%', y: '4%', r: '400px', c: 'rgba(130,170,95,.15)' }, { x: '8%', y: '92%', r: '300px', c: 'rgba(70,110,45,.12)' }] } },
  { id: 'ink', name: '徽墨', en: 'ink', sw: ['#F6F4EF', '#FDFCF9', '#A63A2E'],
    tokens: { canvas: '#F6F4EF', surface: '#FDFCF9', surface2: '#EFEDE6', line: '#E3DFD4', line2: '#C8C2B2',
      text: '#262220', text2: '#6B6560', text3: '#968F87', ink: '#262220', blue: '#3E5C76', green: '#4A6B4F',
      yellow: '#9C6B1F', red: '#A63A2E', gray: '#968F87', bgBlue: '#E9EFF5', bgGreen: '#EBF1EA',
      bgYellow: '#F7EFDB', bgRed: '#F8E8E5', bgGray: '#EFEDE6', onPrimary: '#F6F4EF', toastBg: '#262220',
      toastFg: '#F6F4EF', shimmer: 'rgba(255,255,255,.5)', shadowHover: '0 2px 10px rgba(38,34,32,.07)',
      shadowFloat: '0 12px 32px rgba(38,34,32,.13)' },
    atmo: { type: 'glow', color: 'rgba(200,178,140,.16)', pos: '65% 0%' } },
];

/** 主题别名（跟随系统解析用） */
export const T_ALIAS: Record<string, string> = { light: 'mist', dark: 'night' };
export const SYSTEM_THEME_ID = 'system';

export function findTheme(id: string | null | undefined): Theme {
  let t = id || 'mist';
  t = T_ALIAS[t] || t;
  if (t === SYSTEM_THEME_ID) {
    t = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'mist';
  }
  return THEMES.find((x) => x.id === t) || THEMES[0];
}
