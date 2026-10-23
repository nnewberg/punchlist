// Which build of Punchlist this is (PL-014). `vite build` stamps one id into the web bundle and the
// Worker alike (vite.config.ts), so an open tab can compare its own build with the deployed one.
// Anything not built that way (`npm run dev`, the tests) is DEV_BUILD, which never reloads a tab.

declare const __PUNCH_BUILD__: string | undefined;

export const DEV_BUILD = 'dev';
export const BUILD_ID: string = typeof __PUNCH_BUILD__ === 'string' ? __PUNCH_BUILD__ : DEV_BUILD;

export interface ReloadState {
  /** This tab's build. */
  mine: string;
  /** The build the server last said is deployed, if it has said. */
  deployed: string | null;
  /** The build this tab last reloaded to get (kept in sessionStorage), so a stale page can't loop. */
  reloadedFor: string | null;
  hidden: boolean;
  /** Something a reload would lose: typed text, the description editor open, a card in hand, ops not yet acknowledged. */
  unsaved: boolean;
  /** Someone is in the middle of something that a reload would interrupt but not lose (a focused field, an open menu). Ignored while hidden. */
  engaged: boolean;
}

/**
 * Whether a tab should reload to pick up the deployed build: `current` when it has nothing to pick up
 * (or already tried), `wait` until reloading loses nothing, else `reload`.
 */
export function reloadDecision(s: ReloadState): 'current' | 'wait' | 'reload' {
  if (!s.deployed || s.deployed === s.mine || s.mine === DEV_BUILD || s.deployed === DEV_BUILD) return 'current';
  if (s.reloadedFor === s.deployed) return 'current';
  if (s.unsaved || (s.engaged && !s.hidden)) return 'wait';
  return 'reload';
}
