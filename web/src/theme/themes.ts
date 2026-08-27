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
  { id: 'mist', name: '晨雾', en: 'mist', sw: ['#F6F5F2', '#FFFFFF', '#5B8DB8'],
    tokens: { canvas: '#F6F5F2', surface: '#FFFFFF', surface2: '#FAFAF8', line: '#ECEAE6', line2: '#DCD9D3',
      text: 'rgba(20,20,18,0.92)', text2: 'rgba(20,20,18,0.58)', text3: 'rgba(20,20,18,0.38)', ink: '#141412',
      blue: '#5B8DB8', green: '#6E9B7C', yellow: '#B08D4F', red: '#C06B5F', gray: 'rgba(20,20,18,0.5)',
      bgBlue: 'rgba(91,141,184,0.10)', bgGreen: 'rgba(110,155,124,0.12)', bgYellow: 'rgba(176,141,79,0.14)',
      bgRed: 'rgba(192,107,95,0.12)', bgGray: 'rgba(20,20,18,0.05)', onPrimary: '#FFFFFF',
      toastBg: '#232320', toastFg: '#F6F5F2', shimmer: 'rgba(255,255,255,0.6)',
      shadowHover: '0 2px 8px rgba(20,20,18,0.06)', shadowFloat: '0 12px 28px rgba(20,20,18,0.12)' },
    atmo: { type: 'glow', color: 'rgba(120,160,200,0.14)', pos: '58% 0%' } },
  { id: 'night', name: '夜航', en: 'night', sw: ['#16181C', '#1E2126', '#6FA3D9'],
    tokens: { canvas: '#16181C', surface: '#1E2126', surface2: '#24272D', line: '#2E3138', line2: '#3D4149',
      text: 'rgba(240,242,246,0.94)', text2: 'rgba(240,242,246,0.6)', text3: 'rgba(240,242,246,0.38)', ink: '#F0F2F6',
      blue: '#6FA3D9', green: '#7BB88C', yellow: '#D0AC62', red: '#D97A6E', gray: 'rgba(240,242,246,0.52)',
      bgBlue: 'rgba(111,163,217,0.16)', bgGreen: 'rgba(123,184,140,0.14)', bgYellow: 'rgba(208,172,98,0.14)',
      bgRed: 'rgba(217,122,110,0.16)', bgGray: 'rgba(255,255,255,0.06)', onPrimary: '#16181C',
      toastBg: '#2E3138', toastFg: '#F0F2F6', shimmer: 'rgba(255,255,255,0.06)',
      shadowHover: '0 2px 8px rgba(0,0,0,0.3)', shadowFloat: '0 12px 28px rgba(0,0,0,0.42)' },
    atmo: { type: 'stars', count: 60, color: 'rgba(210,225,245,0.35)' } },
  { id: 'glacier', name: '冰原', en: 'glacier', sw: ['#F2F5F8', '#FFFFFF', '#4E7FB8'],
    tokens: { canvas: '#F2F5F8', surface: '#FFFFFF', surface2: '#F6F8FB', line: '#E5E9EF', line2: '#D3D9E2',
      text: 'rgba(24,30,38,0.92)', text2: 'rgba(24,30,38,0.58)', text3: 'rgba(24,30,38,0.38)', ink: '#181E26',
      blue: '#4E7FB8', green: '#5E9074', yellow: '#A58749', red: '#BF6B60', gray: 'rgba(24,30,38,0.5)',
      bgBlue: 'rgba(78,127,184,0.10)', bgGreen: 'rgba(94,144,116,0.12)', bgYellow: 'rgba(165,135,73,0.14)',
      bgRed: 'rgba(191,107,96,0.12)', bgGray: 'rgba(24,30,38,0.05)', onPrimary: '#FFFFFF',
      toastBg: '#242B34', toastFg: '#F2F5F8', shimmer: 'rgba(255,255,255,0.6)',
      shadowHover: '0 2px 8px rgba(24,30,38,0.07)', shadowFloat: '0 12px 28px rgba(24,30,38,0.13)' },
    atmo: { type: 'glow', color: 'rgba(120,170,230,0.13)', pos: '50% 0%' } },
  { id: 'abyss', name: '深海', en: 'abyss', sw: ['#0E1524', '#16202F', '#5FA8D8'],
    tokens: { canvas: '#0E1524', surface: '#16202F', surface2: '#1B2738', line: '#26344A', line2: '#354763',
      text: 'rgba(226,235,248,0.94)', text2: 'rgba(226,235,248,0.6)', text3: 'rgba(226,235,248,0.38)', ink: '#E2EBF8',
      blue: '#5FA8D8', green: '#6FBC96', yellow: '#C8AE68', red: '#D97F72', gray: 'rgba(226,235,248,0.5)',
      bgBlue: 'rgba(95,168,216,0.16)', bgGreen: 'rgba(111,188,150,0.14)', bgYellow: 'rgba(200,174,104,0.14)',
      bgRed: 'rgba(217,127,114,0.16)', bgGray: 'rgba(255,255,255,0.06)', onPrimary: '#0E1524',
      toastBg: '#26344A', toastFg: '#E2EBF8', shimmer: 'rgba(255,255,255,0.06)',
      shadowHover: '0 2px 8px rgba(0,0,0,0.32)', shadowFloat: '0 12px 28px rgba(0,0,0,0.44)' },
    atmo: { type: 'blobs', blobs: [{ x: '24%', y: '6%', r: '420px', c: 'rgba(70,140,200,0.16)' }, { x: '86%', y: '90%', r: '360px', c: 'rgba(45,90,160,0.14)' }] } },
  { id: 'moss', name: '青苔', en: 'moss', sw: ['#141A12', '#1C2418', '#86AD72'],
    tokens: { canvas: '#141A12', surface: '#1C2418', surface2: '#222C1E', line: '#2C3727', line2: '#3B4A34',
      text: 'rgba(232,240,228,0.94)', text2: 'rgba(232,240,228,0.6)', text3: 'rgba(232,240,228,0.38)', ink: '#E8F0E4',
      blue: '#7FAF9B', green: '#86AD72', yellow: '#C4B06B', red: '#CE8A72', gray: 'rgba(232,240,228,0.5)',
      bgBlue: 'rgba(127,175,155,0.16)', bgGreen: 'rgba(134,173,114,0.15)', bgYellow: 'rgba(196,176,107,0.14)',
      bgRed: 'rgba(206,138,114,0.15)', bgGray: 'rgba(255,255,255,0.05)', onPrimary: '#141A12',
      toastBg: '#2C3727', toastFg: '#E8F0E4', shimmer: 'rgba(255,255,255,0.06)',
      shadowHover: '0 2px 8px rgba(0,0,0,0.3)', shadowFloat: '0 12px 28px rgba(0,0,0,0.4)' },
    atmo: { type: 'blobs', blobs: [{ x: '80%', y: '4%', r: '400px', c: 'rgba(130,170,95,0.13)' }, { x: '6%', y: '92%', r: '300px', c: 'rgba(80,120,60,0.12)' }] } },
  { id: 'ink', name: '徽墨', en: 'ink', sw: ['#F4F1EA', '#FCFAF6', '#7A6A5A'],
    tokens: { canvas: '#F4F1EA', surface: '#FCFAF6', surface2: '#F0EDE5', line: '#E4E0D5', line2: '#CCC5B6',
      text: 'rgba(38,34,30,0.92)', text2: 'rgba(38,34,30,0.58)', text3: 'rgba(38,34,30,0.38)', ink: '#26221E',
      blue: '#6C7E93', green: '#7C9070', yellow: '#A0854C', red: '#B0695C', gray: 'rgba(38,34,30,0.5)',
      bgBlue: 'rgba(108,126,147,0.10)', bgGreen: 'rgba(124,144,112,0.12)', bgYellow: 'rgba(160,133,76,0.14)',
      bgRed: 'rgba(176,105,92,0.12)', bgGray: 'rgba(38,34,30,0.05)', onPrimary: '#F4F1EA',
      toastBg: '#2C2824', toastFg: '#F4F1EA', shimmer: 'rgba(255,255,255,0.5)',
      shadowHover: '0 2px 8px rgba(38,34,30,0.07)', shadowFloat: '0 12px 28px rgba(38,34,30,0.13)' },
    atmo: { type: 'glow', color: 'rgba(180,160,130,0.12)', pos: '65% 0%' } },
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
