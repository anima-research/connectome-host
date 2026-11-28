import { test, expect } from 'bun:test';
import {
  CHAT_MIN_PX,
  clampSidebarWidth,
  initialCollapsed,
  readSidebarPrefs,
  saveSidebarCollapsed,
  saveSidebarWidth,
  sidebarWidthFor,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_MIN_PX,
  SIDEBAR_WIDTH_KEY,
  type SidebarStore,
} from '../web/src/sidebar-layout';

function memoryStore(init: Record<string, string> = {}): SidebarStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const throwingStore: SidebarStore = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

test('with no saved width, the sidebar keeps the widths it had before it could be resized', () => {
  expect(sidebarWidthFor(null, 1024)).toBe(384);
  expect(sidebarWidthFor(null, 1440)).toBe(480);
});

test('a width is clamped to the minimum and to what leaves the chat its share of the window', () => {
  expect(clampSidebarWidth(100, 1440)).toBe(SIDEBAR_MIN_PX);
  expect(clampSidebarWidth(2000, 1440)).toBe(1440 - CHAT_MIN_PX);
  expect(clampSidebarWidth(612.4, 1440)).toBe(612);
});

test('a window too narrow for both keeps the sidebar at its minimum rather than below it', () => {
  expect(clampSidebarWidth(500, 390)).toBe(SIDEBAR_MIN_PX);
});

test('a saved width comes back, clamped to the current window but kept as saved', () => {
  const store = memoryStore({ [SIDEBAR_WIDTH_KEY]: '900' });
  const prefs = readSidebarPrefs(store);
  expect(prefs.width).toBe(900);
  expect(sidebarWidthFor(prefs.width, 1440)).toBe(900);
  expect(sidebarWidthFor(prefs.width, 1100)).toBe(1100 - CHAT_MIN_PX);
});

test('a saved width that does not parse, or is empty or zero, counts as none', () => {
  for (const raw of ['', 'wide', '0', '-20', 'NaN', 'Infinity']) {
    expect(readSidebarPrefs(memoryStore({ [SIDEBAR_WIDTH_KEY]: raw })).width).toBeNull();
  }
});

test('collapse follows the saved choice, and with none, starts collapsed only on a narrow window', () => {
  expect(initialCollapsed(readSidebarPrefs(memoryStore()), 390)).toBe(true);
  expect(initialCollapsed(readSidebarPrefs(memoryStore()), 1440)).toBe(false);
  expect(initialCollapsed(readSidebarPrefs(memoryStore({ [SIDEBAR_COLLAPSED_KEY]: 'false' })), 390)).toBe(false);
  expect(initialCollapsed(readSidebarPrefs(memoryStore({ [SIDEBAR_COLLAPSED_KEY]: 'true' })), 1440)).toBe(true);
  expect(readSidebarPrefs(memoryStore({ [SIDEBAR_COLLAPSED_KEY]: 'yes' })).collapsed).toBeNull();
});

test('saving writes what reading takes back, and forgetting the width brings the default back', () => {
  const store = memoryStore();
  saveSidebarWidth(store, 655.7);
  saveSidebarCollapsed(store, true);
  expect(readSidebarPrefs(store)).toEqual({ width: 656, collapsed: true });
  saveSidebarWidth(store, null);
  expect(store.data.has(SIDEBAR_WIDTH_KEY)).toBe(false);
  expect(sidebarWidthFor(readSidebarPrefs(store).width, 1440)).toBe(480);
});

test('storage that throws, or is missing, gives the defaults and saving does not throw', () => {
  expect(readSidebarPrefs(throwingStore)).toEqual({ width: null, collapsed: null });
  expect(readSidebarPrefs(null)).toEqual({ width: null, collapsed: null });
  expect(() => saveSidebarWidth(throwingStore, 500)).not.toThrow();
  expect(() => saveSidebarWidth(throwingStore, null)).not.toThrow();
  expect(() => saveSidebarCollapsed(throwingStore, true)).not.toThrow();
  expect(() => saveSidebarWidth(null, 500)).not.toThrow();
});
