import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BUILD_ID, DEV_BUILD, nextReload, pageEngaged, pageUnsaved, QUIET_MS, reloadDecision, RETRY_MS, type Page, type ReloadState } from '../shared/build';
import type { BoardInfo, ServerMsg } from '../shared/types';
import { call, useProdWorker } from './harness';

// PL-014: open tabs pick up a new deploy by reloading themselves, but never at the cost of someone's work.

useProdWorker();

const NOW = Date.UTC(2026, 9, 22, 12);
const MIN = 60_000;
const behind: ReloadState = { mine: 'abc', deployed: 'def', last: null, now: NOW, hidden: false, unsaved: false, engaged: false, quietFor: QUIET_MS };

describe('when a tab reloads for a new build', () => {
  it('stays put when it is the deployed build, or has not heard', () => {
    expect(reloadDecision({ ...behind, deployed: 'abc' })).toBe('current');
    expect(reloadDecision({ ...behind, deployed: null })).toBe('current');
  });

  it('never reloads a dev build, or for one', () => {
    expect(reloadDecision({ ...behind, mine: DEV_BUILD })).toBe('current');
    expect(reloadDecision({ ...behind, deployed: DEV_BUILD })).toBe('current');
  });

  it('reloads a hidden tab right away when nothing would be lost, even mid-action', () => {
    expect(reloadDecision({ ...behind, hidden: true, engaged: true, quietFor: 0 })).toBe('reload');
  });

  it('waits on unsaved work even when hidden', () => {
    expect(reloadDecision({ ...behind, unsaved: true })).toBe('wait');
    expect(reloadDecision({ ...behind, unsaved: true, hidden: true })).toBe('wait');
  });

  it('reloads a visible tab only once it has been left alone', () => {
    expect(reloadDecision({ ...behind, quietFor: QUIET_MS - 1 })).toBe('wait');
    expect(reloadDecision({ ...behind, engaged: true })).toBe('wait');
    expect(reloadDecision(behind)).toBe('reload');
  });

  it('backs off when reloading did not bring it up to date: 1, 5, then every 30 minutes', () => {
    const after = (tries: number, ago: number) => reloadDecision({ ...behind, last: { build: 'def', at: NOW - ago, tries } });
    expect(after(1, MIN - 1)).toBe('wait');
    expect(after(1, MIN)).toBe('reload');
    expect(after(2, 5 * MIN - 1)).toBe('wait');
    expect(after(2, 5 * MIN)).toBe('reload');
    expect(after(7, 30 * MIN - 1)).toBe('wait');
    expect(after(7, 30 * MIN)).toBe('reload');
    expect(RETRY_MS).toEqual([MIN, 5 * MIN, 30 * MIN]);
  });

  it('keeps counting tries across builds, so a page and server that never agree still back off', () => {
    const first = nextReload(null, 'def', NOW);
    expect(first).toEqual({ build: 'def', at: NOW, tries: 1 });
    const second = nextReload(first, 'ghi', NOW + MIN);
    expect(second).toEqual({ build: 'ghi', at: NOW + MIN, tries: 2 });
    expect(reloadDecision({ ...behind, deployed: 'jkl', last: second, now: NOW + 2 * MIN })).toBe('wait');
  });
});

// A few elements shaped like the board's markup, and just enough selector matching (tags, classes,
// attributes, :not) to run the page checks on them the way a browser would.
interface El {
  tag: string;
  attrs: Record<string, string>;
  value?: string;
  focused?: boolean;
  parent?: El;
  children: El[];
}
const h = (tag: string, attrs: Record<string, string | boolean> = {}, ...children: El[]): El => {
  const { value, focused, ...rest } = attrs;
  const el: El = { tag, attrs: Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])), children, ...(typeof value === 'string' ? { value } : {}), ...(focused ? { focused: true } : {}) };
  for (const c of children) c.parent = el;
  return el;
};
const matches = (el: El, sel: string): boolean => sel.split(',').some(s => matchCompound(el, s.trim()));
function matchCompound(el: El, sel: string): boolean {
  const tag = /^[a-z]+/.exec(sel)?.[0];
  if (tag && el.tag !== tag) return false;
  for (const [, cls, attr, val, not] of sel.slice(tag?.length ?? 0).matchAll(/\.([\w-]+)|\[([\w-]+)(?:=([\w-]+))?\]|:not\(([^)]*)\)/g)) {
    if (cls && !(el.attrs.class ?? '').split(' ').includes(cls)) return false;
    if (attr && (!(attr in el.attrs) || (val !== undefined && el.attrs[attr] !== val))) return false;
    if (not && matchCompound(el, not)) return false;
  }
  return true;
}
function pageOf(root: El): Page {
  const all: El[] = [];
  const walk = (e: El) => (all.push(e), e.children.forEach(walk));
  walk(root);
  return {
    has: sel => all.some(e => matches(e, sel)),
    values: sel => all.filter(e => matches(e, sel)).map(e => e.value ?? ''),
    focusIn: sel => {
      for (let e = all.find(x => x.focused); e; e = e.parent) if (matches(e, sel)) return true;
      return false;
    },
  };
}
const board = (...children: El[]) => h('div', { class: 'app' }, h('input', { 'data-not-draft': true, value: '' }), h('div', { class: 'board' }), ...children);
const sheet = (...children: El[]) => h('div', { class: 'sheet' }, h('input', { class: 'note-input', value: '' }), ...children);

describe('what on the page holds off a reload', () => {
  it('nothing, on a board at rest with an item open', () => {
    const p = pageOf(board(sheet()));
    expect(pageUnsaved(p)).toBe(false);
    expect(pageEngaged(p)).toBe(false);
  });

  it('typed text: a note, a new item, a tag', () => {
    expect(pageUnsaved(pageOf(board(sheet(h('input', { class: 'note-input', value: 'half a thought' })))))).toBe(true);
    expect(pageUnsaved(pageOf(board(h('div', { class: 'composer' }, h('textarea', { value: 'New thing' })))))).toBe(true);
    expect(pageUnsaved(pageOf(board(sheet(h('input', { class: 'inline-input', value: 'ui' })))))).toBe(true);
    expect(pageUnsaved(pageOf(board(sheet(h('input', { class: 'inline-input', value: '   ' })))))).toBe(false);
  });

  it('the description editor only once its draft differs from the saved text', () => {
    const editor = (dirty: boolean) => h('div', { class: 'body-edit', ...(dirty ? { 'data-dirty': 'true' } : {}) }, h('textarea', { 'data-not-draft': true, value: 'Saved body' }));
    expect(pageUnsaved(pageOf(board(sheet(editor(false)))))).toBe(false);
    expect(pageUnsaved(pageOf(board(sheet(editor(true)))))).toBe(true);
  });

  it('a card in hand', () => {
    expect(pageUnsaved(pageOf(h('div', { class: 'app' }, h('div', { class: 'board dragging' }))))).toBe(true);
  });

  it('not a search, a checkbox or another non-text input, but a search keeps a visible tab put', () => {
    const searching = h('div', { class: 'app', 'data-view-set': 'true' }, h('input', { 'data-not-draft': true, value: 'export' }), h('input', { type: 'checkbox', value: 'on' }));
    expect(pageUnsaved(pageOf(searching))).toBe(false);
    expect(pageEngaged(pageOf(searching))).toBe(true);
  });

  it('a focused field, even empty, an open menu or a toast keeps a visible tab put', () => {
    expect(pageEngaged(pageOf(board(sheet(h('input', { class: 'inline-input', value: '', focused: true })))))).toBe(true);
    expect(pageEngaged(pageOf(board(sheet(h('span', {}, h('div', { class: 'menu' }))))))).toBe(true);
    expect(pageEngaged(pageOf(board(h('div', { class: 'toast' }, h('button', { focused: true })))))).toBe(true);
    expect(pageUnsaved(pageOf(board(h('div', { class: 'toast' }))))).toBe(false);
  });
});

describe('the deployed build', () => {
  it('is served at /v1/build without signing in', async () => {
    const res = await call('/v1/build');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ build: BUILD_ID });
  });

  it('comes with the reply to a socket’s sync', async () => {
    const info: BoardInfo = { owner: 'nnewberg', repo: 'punchlist', prefix: 'PL' };
    const stub = env.BOARD.get(env.BOARD.idFromName(crypto.randomUUID()));
    const res = await stub.fetch('https://board/ws', {
      headers: { Upgrade: 'websocket', 'X-Punch-Board': JSON.stringify(info), 'X-Punch-User': 'nick', 'X-Punch-Role': 'edit' },
    });
    const ws = res.webSocket!;
    ws.accept();
    const reply = new Promise<ServerMsg>(resolve => ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data as string) as ServerMsg;
      if (msg.type === 'events' || msg.type === 'resync') resolve(msg);
    }));
    ws.send(JSON.stringify({ type: 'sync', since: 0 }));
    expect(await reply).toMatchObject({ type: 'events', build: BUILD_ID });
    ws.close();
  });
});
