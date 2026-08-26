// 职责：主题状态（选择/氛围档位，localStorage 持久化）+ ThemeProvider —— CSSOM 注入全部语义 token。
// 注入逻辑与 taskboard-v9 applyTheme 一致：documentElement.style.setProperty 逐键写入；
// 'system' 跟随 prefers-color-scheme（监听变化）；持久化键与原型一致（helmsman-theme / helmsman-atmo）。
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { TK_MAP, findTheme, SYSTEM_THEME_ID, type Theme } from './themes';
import { applySkin, clearSkin, getActiveSkin, loadActiveSkinId, setActiveSkin, type UserSkin } from './skin';

export type AtmoLevel = 'off' | 'soft' | 'on' | 'strong';

const LS_THEME = 'helmsman-theme';
const LS_ATMO = 'helmsman-atmo';
const LS_RADIUS = 'helmsman-radius';

function readLS(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function readRadius(): number {
  const n = Number(readLS(LS_RADIUS, '8'));
  return Number.isFinite(n) ? Math.min(16, Math.max(4, Math.round(n))) : 8;
}

export function applyRadius(n: number) {
  const r = document.documentElement.style;
  r.setProperty('--r-sm', Math.max(4, n - 2) + 'px');
  r.setProperty('--r-md', n + 'px');
  r.setProperty('--r-lg', n + 4 + 'px');
}

interface ThemeState {
  themeId: string; // 'mist' | 'night' | ... | 'system'
  atmo: AtmoLevel;
  /** --r-md 基准（px），连带 --r-sm / --r-lg */
  radius: number;
  setTheme: (id: string) => void;
  setAtmo: (level: AtmoLevel) => void;
  setRadius: (n: number) => void;
}
export const useThemeStore = create<ThemeState>((set) => ({
  themeId: readLS(LS_THEME, 'mist'),
  atmo: (readLS(LS_ATMO, 'on') as AtmoLevel) || 'on',
  radius: readRadius(),
  setTheme: (id) => {
    localStorage.setItem(LS_THEME, id);
    set({ themeId: id });
  },
  setAtmo: (level) => {
    localStorage.setItem(LS_ATMO, level);
    set({ atmo: level });
  },
  setRadius: (n) => {
    const radius = Math.min(16, Math.max(4, Math.round(n)));
    localStorage.setItem(LS_RADIUS, String(radius));
    applyRadius(radius);
    set({ radius });
  },
}));

/** 注入一套主题的全部 token 到 documentElement（CSSOM），并打 data-theme 标记 */
export function applyTokens(th: Theme) {
  const r = document.documentElement.style;
  (Object.keys(TK_MAP) as (keyof typeof TK_MAP)[]).forEach((k) => {
    r.setProperty(TK_MAP[k], th.tokens[k]);
  });
  document.documentElement.dataset.theme = th.id;
}

/** 解析当前生效的主题（含 system 跟随） */
function resolveTheme(themeId: string): Theme {
  return findTheme(themeId);
}

const Ctx = createContext<{ theme: Theme; themeId: string }>({ theme: findTheme('mist'), themeId: 'mist' });
export const useThemeCtx = () => useContext(Ctx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const themeId = useThemeStore((s) => s.themeId);
  const radius = useThemeStore((s) => s.radius);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(themeId));
  const [skin, setSkin] = useState<UserSkin | null>(() => getActiveSkin());

  // 内置主题 token 注入（基础层；皮肤 token 覆盖在其上，见下方 applySkin）
  useEffect(() => {
    applyTokens(theme);
  }, [theme]);

  // 皮肤注入：token 覆盖 + css + 背景。激活皮肤时每次主题/皮肤变化都重新应用
  // （皮肤 token 需要压在最新内置主题之上；css/背景独立于内置主题）。
  // 还原（skin=null）时先清皮肤注入，再重放内置主题 token（皮肤覆盖过的键归位）。
  useEffect(() => {
    if (skin) {
      applyTokens(theme);
      applySkin(skin);
    } else {
      clearSkin();
      applyTokens(theme);
    }
  }, [skin, theme]);

  // 外部切换皮肤（ThemePicker 导入/选择后调用 setSkin 由本组件暴露）
  useEffect(() => {
    const onStorage = () => setSkin(getActiveSkin());
    window.addEventListener('helmsman-skin-changed', onStorage);
    return () => window.removeEventListener('helmsman-skin-changed', onStorage);
  }, []);

  useEffect(() => {
    applyRadius(radius);
  }, [radius]);

  useEffect(() => {
    setTheme(resolveTheme(themeId));
  }, [themeId]);

  // system 主题跟随系统明暗切换
  useEffect(() => {
    if (themeId !== SYSTEM_THEME_ID) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(resolveTheme(themeId));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themeId]);

  const value = useMemo(() => ({ theme, themeId }), [theme, themeId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 激活/取消皮肤（ThemePicker 用；触发 helmsman-skin-changed 让 Provider 应用）。 */
export function activateSkin(id: string | null): void {
  setActiveSkin(id);
  window.dispatchEvent(new Event('helmsman-skin-changed'));
}
