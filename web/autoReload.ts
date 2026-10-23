import { BUILD_ID, DEV_BUILD, reloadDecision } from '../shared/build';

// PL-014: a tab that's behind the deployed build reloads itself, at a moment that loses nothing, so
// nobody has to reload to get the latest. A deploy restarts every board, so each open board tab
// reconnects within seconds and hears the new build in the reply to its sync. Pages without a board
// socket (My work) ask /v1/build when they come back into view.

const RELOADED_FOR = 'pl_reloaded_for';
/** How often a tab that's behind looks again for a safe moment. */
const RECHECK_MS = 2_000;
/** At most this often, a tab coming into view asks which build is deployed. */
const ASK_MS = 60_000;

let deployed: string | null = null;
let asked = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const holds = new Set<() => boolean>();

/** Holds off reloading while `busy()` is true, e.g. while a board has ops the server hasn't answered. Returns the release. */
export function holdReload(busy: () => boolean): () => void {
  holds.add(busy);
  return () => holds.delete(busy);
}

/** What the server says is deployed. */
export function deployedBuild(build: string | undefined) {
  if (!build || build === deployed) return;
  deployed = build;
  check();
}

/** Typed text (a note, a title or a new item, a tag), the description editor open, a card in hand, or a hold. */
function unsaved(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, input:not([type]):not([data-not-draft]), input[type=text]:not([data-not-draft])');
  return [...fields].some(f => f.value.trim() !== '') || !!document.querySelector('.body-edit, .dragging') || [...holds].some(busy => busy());
}

/** Typing in a field (even an empty one) or picking from a menu. */
function engaged(): boolean {
  return !!document.activeElement?.closest('input, textarea, [contenteditable]') || !!document.querySelector('.menu');
}

function check() {
  clearTimeout(timer);
  let reloadedFor: string | null;
  try {
    reloadedFor = sessionStorage.getItem(RELOADED_FOR);
  } catch {
    return; // nowhere to remember it, so no way to stop a loop
  }
  const hidden = document.visibilityState === 'hidden';
  const d = reloadDecision({ mine: BUILD_ID, deployed, reloadedFor, hidden, unsaved: unsaved(), engaged: engaged() });
  if (d === 'wait') timer = setTimeout(check, RECHECK_MS);
  if (d !== 'reload') return;
  try {
    sessionStorage.setItem(RELOADED_FOR, deployed!);
  } catch {
    return;
  }
  location.reload(); // same URL, so the board and any open item come back
}

function ask() {
  asked = Date.now();
  fetch('/v1/build', { cache: 'no-store' })
    .then(r => r.json() as Promise<{ build?: string }>)
    .then(r => deployedBuild(r.build), () => {});
}

/** Called once at startup. A dev build never reloads, so it doesn't ask. */
export function startAutoReload() {
  if (BUILD_ID === DEV_BUILD) return;
  asked = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - asked > ASK_MS) ask();
    check();
  });
}
