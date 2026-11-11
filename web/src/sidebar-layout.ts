// The right sidebar's width, and whether it is collapsed, as the operator last
// left them in this browser. Kept in localStorage, which can be missing or
// throw (a private window, blocked site data), so every read and write here
// falls back to the defaults instead of failing.

/** The narrowest the sidebar can be dragged. */
export const SIDEBAR_MIN_PX = 240;
/** The chat keeps at least this much of the window beside an open sidebar. */
export const CHAT_MIN_PX = 360;
/** Below this window width, a browser with no saved choice starts with the sidebar collapsed. */
export const NARROW_VIEWPORT_PX = 768;
/** How far one arrow-key press on the resize handle moves it. */
export const SIDEBAR_KEY_STEP_PX = 16;

export const SIDEBAR_WIDTH_KEY = 'connectome-host.sidebar.width';
export const SIDEBAR_COLLAPSED_KEY = 'connectome-host.sidebar.collapsed';

/** The width the sidebar had before it could be resized: `w-96`, and `xl:w-[30rem]` from 1280 px. */
export function defaultSidebarWidth(viewport: number): number {
  return viewport >= 1280 ? 480 : 384;
}

/** A width the window can hold: at least SIDEBAR_MIN_PX, and leaving the chat CHAT_MIN_PX where it can. */
export function clampSidebarWidth(px: number, viewport: number): number {
  const max = Math.max(SIDEBAR_MIN_PX, viewport - CHAT_MIN_PX);
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_PX, px)));
}

/** The width to draw: the saved one if any, else the default, either clamped to the window. */
export function sidebarWidthFor(saved: number | null, viewport: number): number {
  return clampSidebarWidth(saved ?? defaultSidebarWidth(viewport), viewport);
}

export type SidebarStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SidebarPrefs {
  /** The width last dragged to, or null when none is saved (or it doesn't parse). */
  width: number | null;
  /** Whether it was last collapsed, or null when no choice is saved. */
  collapsed: boolean | null;
}

export function readSidebarPrefs(store: SidebarStore | null): SidebarPrefs {
  let width: number | null = null;
  let collapsed: boolean | null = null;
  try {
    const raw = store?.getItem(SIDEBAR_WIDTH_KEY) ?? null;
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n) && n > 0) width = n;
  } catch { /* unreadable storage: no saved width */ }
  try {
    const raw = store?.getItem(SIDEBAR_COLLAPSED_KEY) ?? null;
    if (raw === 'true') collapsed = true;
    else if (raw === 'false') collapsed = false;
  } catch { /* unreadable storage: no saved choice */ }
  return { width, collapsed };
}

/** Whether to start collapsed: the saved choice, else collapsed only on a narrow window. */
export function initialCollapsed(prefs: SidebarPrefs, viewport: number): boolean {
  return prefs.collapsed ?? viewport < NARROW_VIEWPORT_PX;
}

/** Save a width, or forget it (null) so the default applies again. */
export function saveSidebarWidth(store: SidebarStore | null, width: number | null): void {
  try {
    if (width === null) store?.removeItem(SIDEBAR_WIDTH_KEY);
    else store?.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
  } catch { /* storage full or blocked: the width holds until a reload */ }
}

export function saveSidebarCollapsed(store: SidebarStore | null, collapsed: boolean): void {
  try {
    store?.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch { /* storage full or blocked: the choice holds until a reload */ }
}

/** The page's localStorage, or null where reading it throws. */
export function browserSidebarStore(): SidebarStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
