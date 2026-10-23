import { BUILD_ID, DEV_BUILD, nextReload, pageEngaged, pageUnsaved, reloadDecision, type LastReload, type Page } from '../shared/build';

// PL-014: a tab that's behind the deployed build reloads itself, at a moment that loses nothing, so
// nobody has to reload to get the latest. A deploy restarts every board, so each open board tab
// reconnects within seconds and hears the new build in the reply to its sync. While no board socket
// is live (My work, or a board that's offline), the tab asks /v1/build: at startup, every few
// minutes while it's in view, and when it comes back into view, gets focus or gets back online.

const LAST_RELOAD = 'pl_last_reload';
/** How often a tab that's behind looks again for a safe moment. */
const RECHECK_MS = 2_000;
/** How often a tab in view with no live board socket asks which build is deployed. */
const POLL_MS = 5 * 60_000;
/** Asking on focus and the like happens at most this often. */
const ASK_MS = 60_000;

interface Board {
  /** Ops the server hasn't answered yet. */
  busy(): boolean;
  /** Its socket is open, so it hears the deployed build on its own. */
  live(): boolean;
}

let deployed: string | null = null;
let asked = 0;
let lastInput = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Where the last reload is kept if sessionStorage can't be used: at most one reload per page load, then. */
let memory: LastReload | null = null;
const boards = new Set<Board>();

/** A board client, which holds off a reload while it has ops in flight. Returns the release. */
export function watchBoard(b: Board): () => void {
  boards.add(b);
  return () => boards.delete(b);
}

/** What the server says is deployed. */
export function deployedBuild(build: string | undefined) {
  if (!build || build === deployed) return;
  deployed = build;
  check();
}

const page: Page = {
  has: sel => !!document.querySelector(sel),
  values: sel => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(sel)].map(f => f.value),
  focusIn: sel => !!document.activeElement?.closest(sel),
};

function readLast(): LastReload | null {
  try {
    return JSON.parse(sessionStorage.getItem(LAST_RELOAD) ?? 'null') as LastReload | null;
  } catch {
    return memory;
  }
}

function writeLast(last: LastReload | null) {
  memory = last;
  try {
    if (last) sessionStorage.setItem(LAST_RELOAD, JSON.stringify(last));
    else sessionStorage.removeItem(LAST_RELOAD);
  } catch {
    // kept in memory instead
  }
}

function check() {
  clearTimeout(timer);
  const last = readLast();
  const now = Date.now();
  const d = reloadDecision({
    mine: BUILD_ID,
    deployed,
    last,
    now,
    hidden: document.visibilityState === 'hidden',
    unsaved: pageUnsaved(page) || [...boards].some(b => b.busy()),
    engaged: pageEngaged(page),
    quietFor: now - lastInput,
  });
  if (d === 'current' && last && deployed === BUILD_ID) writeLast(null); // up to date: start counting afresh
  if (d === 'wait') timer = setTimeout(check, RECHECK_MS);
  if (d !== 'reload') return;
  writeLast(nextReload(last, deployed!, now));
  location.reload(); // same URL, so the board and any open item come back
}

function ask(force = false) {
  if ([...boards].some(b => b.live()) || (!force && Date.now() - asked < ASK_MS)) return;
  asked = Date.now();
  fetch('/v1/build', { cache: 'no-store' })
    .then(r => r.json() as Promise<{ build?: string }>)
    .then(r => deployedBuild(r.build), () => {});
}

/** Called once at startup. A dev build never reloads, so it doesn't ask. */
export function startAutoReload() {
  if (BUILD_ID === DEV_BUILD) return;
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
    window.addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ask();
    check();
  });
  window.addEventListener('focus', () => ask());
  window.addEventListener('online', () => ask());
  setInterval(() => document.visibilityState === 'visible' && ask(true), POLL_MS);
  ask(true);
}
