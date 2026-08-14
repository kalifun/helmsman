// 职责：主题状态（选择/氛围档位，localStorage 持久化）+ ThemeProvider —— CSSOM 注入全部语义 token。
// 注入逻辑与 taskboard-v9 applyTheme 一致：documentElement.style.setProperty 逐键写入；
// 'system' 跟随 prefers-color-scheme（监听变化）；持久化键与原型一致（helmsman-theme / helmsman-atmo）。
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { TK_MAP, findTheme, SYSTEM_THEME_ID, type Theme } from './themes';

export type AtmoLevel = 'off' | 'soft' | 'on' | 'strong';

const LS_THEME = 'helmsman-theme';
const LS_ATMO = 'helmsman-atmo';

function readLS(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

interface ThemeState {
  themeId: string; // 'mist' | 'night' | ... | 'system'
  atmo: AtmoLevel;
  setTheme: (id: string) => void;
  setAtmo: (level: AtmoLevel) => void;
}
export const useThemeStore = create<ThemeState>((set) => ({
  themeId: readLS(LS_THEME, 'mist'),
  atmo: (readLS(LS_ATMO, 'on') as AtmoLevel) || 'on',
  setTheme: (id) => {
    localStorage.setItem(LS_THEME, id);
    set({ themeId: id });
  },
  setAtmo: (level) => {
    localStorage.setItem(LS_ATMO, level);
    set({ atmo: level });
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
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(themeId));

  useEffect(() => {
    applyTokens(theme);
  }, [theme]);

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
