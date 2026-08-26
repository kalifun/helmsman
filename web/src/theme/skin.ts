// 职责：换装皮肤系统（Skin System v2 轻量模型）—— 皮肤包数据模型、校验、持久化、注入。
// 皮肤包 = 三个可选文件（至少一个）：
//   tokens?  25 键色板子集（theme.json 的 tokens 字段）——只覆盖皮肤有的键，缺省回落内置主题
//   css?     theme.css 任意 CSS 覆盖（彻底变装靠它）
//   bg?      背景图（DataURL 或 URL）
// 应用机制：token 覆盖走 CSSOM setProperty；css 走动态 <style id="helmsman-skin"> 注入；
//   背景走 body style；一键还原 = 全部移除。
import { TK_MAP, type TokenKey } from './themes';

export interface UserSkin {
  id: string;
  name: string;
  /** 25 键 token 子集（theme.json 的 tokens 字段；键必须是合法 TokenKey） */
  tokens?: Partial<Record<TokenKey, string>>;
  /** theme.css 原文 */
  css?: string;
  /** 背景图（DataURL / URL） */
  bg?: string;
  /** 背景定位参数（可选，对应 art.focusX/Y + safeArea） */
  bgFocus?: { x: string; y: string };
  createdAt: number;
}

const LS_SKINS = 'helmsman-skins';
const LS_ACTIVE = 'helmsman-skin-active';

const STYLE_ID = 'helmsman-skin';

/** 读用户皮肤表（localStorage，损坏容错） */
export function loadSkins(): Record<string, UserSkin> {
  try {
    const raw = localStorage.getItem(LS_SKINS);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, UserSkin>;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveSkins(skins: Record<string, UserSkin>): void {
  try {
    localStorage.setItem(LS_SKINS, JSON.stringify(skins));
  } catch {
    // 存储满/禁用时静默失败（皮肤不持久化，本次会话仍生效）
  }
}

/** 读当前激活皮肤 id（无则 null = 内置主题） */
export function loadActiveSkinId(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE);
  } catch {
    return null;
  }
}

function saveActiveSkinId(id: string | null): void {
  try {
    if (id == null) localStorage.removeItem(LS_ACTIVE);
    else localStorage.setItem(LS_ACTIVE, id);
  } catch {
    // 同上静默
  }
}

/** 校验皮肤名（唯一性由调用方保证） */
export function validSkinName(name: string): boolean {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 40;
}

/** 校验一个 token 覆盖包：键必须是 25 键白名单内，值必须是合法 CSS 颜色/字符串。 */
export function validateTokens(tokens: unknown): Partial<Record<TokenKey, string>> | null {
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return null;
  const out: Partial<Record<TokenKey, string>> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (!(k in TK_MAP)) return null; // 白名单外键 → 整个拒绝（防坏包）
    if (typeof v !== 'string' || v.trim() === '') return null;
    out[k as TokenKey] = v;
  }
  return Object.keys(out).length > 0 ? out : null; // 空对象 = 无有效覆盖
}

/** 校验皮肤 JSON 文本 → UserSkin（缺省 id 自动生成）。返回 null = 坏包。 */
export function parseSkinJson(text: string): UserSkin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const name = typeof p.name === 'string' && validSkinName(p.name) ? p.name.trim() : null;
  const tokens = p.tokens !== undefined ? validateTokens(p.tokens) : undefined;
  // tokens 存在但校验失败（白名单外键/坏值）→ 整个拒包
  if (p.tokens !== undefined && tokens === null) return null;
  const css = typeof p.css === 'string' && p.css.trim() ? p.css : undefined;
  const bg = typeof p.bg === 'string' && p.bg.startsWith('data:') ? p.bg : undefined;
  // 至少一个有效内容（name 只是元数据，不算内容）
  if (!tokens && !css && !bg) return null;
  return {
    id: typeof p.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(p.id) ? p.id : genSkinId(),
    name: name ?? '未命名皮肤',
    ...(tokens ? { tokens } : {}),
    ...(css ? { css } : {}),
    ...(bg ? { bg } : {}),
    createdAt: Date.now(),
  };
}

/** 生成皮肤 id（时间戳 + 随机） */
export function genSkinId(): string {
  return 'skin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/** 解析 zip 皮肤包（theme.css + 可选 theme.json/background）。极简 zip 解析（无依赖）。 */
export async function parseSkinZip(file: File): Promise<UserSkin | null> {
  const MAX_ZIP = 2 * 1024 * 1024; // zip ≤ 2 MiB
  const MAX_CSS = 512 * 1024; // css ≤ 512 KiB
  if (file.size > MAX_ZIP) return null;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const entries = parseZipEntries(buf);
    const themeJson = entries.find((e) => e.name.endsWith('theme.json'));
    const themeCss = entries.find((e) => e.name.endsWith('theme.css'));
    const bg = entries.find((e) => e.name.match(/background\.(png|jpe?g|gif|webp)$/i));
    if (!themeJson && !themeCss && !bg) return null;
    let meta: Record<string, unknown> = {};
    if (themeJson) {
      try {
        meta = JSON.parse(decoder.decode(themeJson.data)) as Record<string, unknown>;
      } catch {
        return null; // 坏 theme.json → 拒包
      }
    }
    const tokens = meta.tokens !== undefined ? validateTokens(meta.tokens) : undefined;
    if (meta.tokens !== undefined && tokens === null) return null; // 坏 tokens → 拒包
    const name = typeof meta.name === 'string' && validSkinName(meta.name) ? meta.name.trim() : 'zip 皮肤';
    let css: string | undefined;
    if (themeCss) {
      if (themeCss.data.length > MAX_CSS) return null;
      css = decoder.decode(themeCss.data);
      if (!css.trim()) css = undefined;
    }
    let bgData: string | undefined;
    if (bg) {
      bgData = toDataUrl(bg.name, bg.data);
      if (!bgData) return null;
    }
    if (!tokens && !css && !bgData) return null;
    return {
      id: typeof meta.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(meta.id) ? meta.id : genSkinId(),
      name,
      ...(tokens ? { tokens } : {}),
      ...(css ? { css } : {}),
      ...(bgData ? { bg: bgData } : {}),
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

const decoder = new TextDecoder('utf-8');

/** 极简 zip 条目解析：定位本地文件头（PK\x03\x04），按各条目数据长度推进（仅 store/无压缩）。 */
function parseZipEntries(buf: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const out: Array<{ name: string; data: Uint8Array }> = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i + 30 <= buf.length) {
    if (view.getUint32(i, true) !== 0x04034b50) break; // 本地文件头签名
    const method = view.getUint16(i + 8, true); // 0 = store（不压缩）
    const compSize = view.getUint32(i + 18, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const name = decoder.decode(buf.subarray(i + 30, i + 30 + nameLen));
    const dataStart = i + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (method === 0 && dataEnd <= buf.length) {
      out.push({ name, data: buf.subarray(dataStart, dataEnd) });
    }
    i = dataEnd > i ? dataEnd : i + 1;
  }
  return out;
}

function toDataUrl(name: string, data: Uint8Array): string | null {
  const mime = name.match(/\.(png)$/i) ? 'image/png'
    : name.match(/\.(jpe?g)$/i) ? 'image/jpeg'
    : name.match(/\.(gif)$/i) ? 'image/gif'
    : name.match(/\.(webp)$/i) ? 'image/webp'
    : null;
  if (!mime) return null;
  let bin = '';
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
  return 'data:' + mime + ';base64,' + btoa(bin);
}

// ---------- 注入 / 还原 ----------

/** 应用一个皮肤：token 覆盖（CSSOM）+ css（<style> 注入）+ 背景（body）。 */
export function applySkin(skin: UserSkin): void {
  const doc = document.documentElement;
  const r = doc.style;
  // 1) token 覆盖：只 set 皮肤有的键（缺省回落内置主题已 set 的值）
  if (skin.tokens) {
    for (const [k, v] of Object.entries(skin.tokens)) {
      const varName = TK_MAP[k as TokenKey];
      if (varName) r.setProperty(varName, v);
    }
  }
  // 2) theme.css：动态 <style> 注入（整体替换）
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (skin.css) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = skin.css;
  } else if (styleEl) {
    styleEl.remove();
  }
  // 3) 背景
  const body = document.body;
  if (skin.bg) {
    const pos = skin.bgFocus ? `${skin.bgFocus.x} ${skin.bgFocus.y}` : '50% 0%';
    body.style.backgroundImage = `url("${skin.bg}")`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = pos;
    body.style.backgroundAttachment = 'fixed';
  } else {
    body.style.backgroundImage = '';
    body.style.backgroundSize = '';
    body.style.backgroundPosition = '';
    body.style.backgroundAttachment = '';
  }
  doc.dataset.skin = skin.id;
}

/** 一键还原：移除皮肤注入（token 由内置主题重新 set 覆盖，见 ThemeProvider 协调）。 */
export function clearSkin(): void {
  const styleEl = document.getElementById(STYLE_ID);
  if (styleEl) styleEl.remove();
  const body = document.body;
  body.style.backgroundImage = '';
  body.style.backgroundSize = '';
  body.style.backgroundPosition = '';
  body.style.backgroundAttachment = '';
  delete document.documentElement.dataset.skin;
}

// ---------- 皮肤表管理 ----------

export function saveSkin(skin: UserSkin): void {
  const skins = loadSkins();
  skins[skin.id] = skin;
  saveSkins(skins);
}

export function deleteSkin(id: string): void {
  const skins = loadSkins();
  delete skins[id];
  saveSkins(skins);
  if (loadActiveSkinId() === id) {
    saveActiveSkinId(null);
    clearSkin();
  }
}

export function getActiveSkin(): UserSkin | null {
  const id = loadActiveSkinId();
  if (!id) return null;
  return loadSkins()[id] ?? null;
}

export function setActiveSkin(id: string | null): void {
  saveActiveSkinId(id);
}
