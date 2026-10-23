// Which build of Punchlist this is (PL-014). `vite build` stamps one id into the web bundle and the
// Worker alike (vite.config.ts), so an open tab can compare its own build with the deployed one.
// Anything not built that way (`npm run dev`, the tests) is DEV_BUILD, which never reloads a tab.
// The rules for when a tab reloads live here too, apart from the browser, so they can be tested.

declare const __PUNCH_BUILD__: string | undefined;

export const DEV_BUILD = 'dev';
export const BUILD_ID: string = typeof __PUNCH_BUILD__ === 'string' ? __PUNCH_BUILD__ : DEV_BUILD;

/** A visible tab reloads only after this long with no pointer or key input. */
export const QUIET_MS = 10_000;
/** After the 1st, 2nd and 3rd-or-later reload that didn't bring the tab up to date, wait this long before trying again. */
export const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

/** The tab's last reload for a new build, kept until it finds itself up to date. */
export interface LastReload {
  build: string;
  at: number;
  /** Reloads in a row that haven't brought it up to date. */
  tries: number;
}

export interface ReloadState {
  /** This tab's build. */
  mine: string;
  /** The build the server last said is deployed, if it has said. */
  deployed: string | null;
  last: LastReload | null;
  now: number;
  hidden: boolean;
  /** Something a reload would lose: typed text, an edited description, a card in hand, ops not yet answered. */
  unsaved: boolean;
  /** Something a reload would interrupt but not lose, e.g. a focused field, a menu, a toast or a search. Ignored while hidden. */
  engaged: boolean;
  /** How long since the last pointer or key input. Ignored while hidden. */
  quietFor: number;
}

/**
 * Whether a tab should reload to pick up the deployed build: `current` when there's nothing to pick
 * up, `wait` until reloading loses and interrupts nothing (and any earlier attempt has had time to
 * settle), else `reload`. A visible tab that's never left alone waits until it's hidden.
 */
export function reloadDecision(s: ReloadState): 'current' | 'wait' | 'reload' {
  if (!s.deployed || s.deployed === s.mine || s.mine === DEV_BUILD || s.deployed === DEV_BUILD) return 'current';
  if (s.last && s.now - s.last.at < RETRY_MS[Math.min(s.last.tries, RETRY_MS.length) - 1]!) return 'wait';
  if (s.unsaved) return 'wait';
  if (!s.hidden && (s.engaged || s.quietFor < QUIET_MS)) return 'wait';
  return 'reload';
}

/** What to remember when reloading for `build`. */
export const nextReload = (last: LastReload | null, build: string, now: number): LastReload => ({ build, at: now, tries: (last?.tries ?? 0) + 1 });

/** The little of the page the checks below read, so they can be tried on fixtures without a browser. */
export interface Page {
  has(selector: string): boolean;
  /** The values of the fields that match. */
  values(selector: string): string[];
  /** Whether the focused element is, or is inside, something that matches. */
  focusIn(selector: string): boolean;
}

/** Text boxes whose text is someone's unsaved work. The search box is marked `data-not-draft`, and so is the description, which says when it's changed with `data-dirty`. */
const DRAFT_FIELDS = 'textarea:not([data-not-draft]), input:not([type]):not([data-not-draft]), input[type=text]:not([data-not-draft])';

/** Typed text (a note, a title, a new item, a tag), a changed description, or a card in hand. */
export const pageUnsaved = (p: Page) => p.values(DRAFT_FIELDS).some(v => v.trim() !== '') || p.has('[data-dirty], .dragging');

/** Typing (even in an empty field), a menu or toast open (a toast may offer Undo), or a search, filter or older Done items in view. */
export const pageEngaged = (p: Page) => p.focusIn('input, textarea, [contenteditable]') || p.has('.menu, .toast, [data-view-set]');
