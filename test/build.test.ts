import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BUILD_ID, DEV_BUILD, reloadDecision, type ReloadState } from '../shared/build';
import type { BoardInfo, ServerMsg } from '../shared/types';
import { call, useProdWorker } from './harness';

// PL-014: open tabs pick up a new deploy by reloading themselves, but never at the cost of someone's work.

useProdWorker();

const behind: ReloadState = { mine: 'abc', deployed: 'def', reloadedFor: null, hidden: false, unsaved: false, engaged: false };

describe('when a tab reloads for a new build', () => {
  it('stays put when it is the deployed build, or has not heard', () => {
    expect(reloadDecision({ ...behind, deployed: 'abc' })).toBe('current');
    expect(reloadDecision({ ...behind, deployed: null })).toBe('current');
  });

  it('never reloads a dev build, or for one', () => {
    expect(reloadDecision({ ...behind, mine: DEV_BUILD })).toBe('current');
    expect(reloadDecision({ ...behind, deployed: DEV_BUILD })).toBe('current');
  });

  it('reloads right away when nothing would be lost, hidden or not', () => {
    expect(reloadDecision(behind)).toBe('reload');
    expect(reloadDecision({ ...behind, hidden: true })).toBe('reload');
  });

  it('waits on unsaved work even when hidden', () => {
    expect(reloadDecision({ ...behind, unsaved: true })).toBe('wait');
    expect(reloadDecision({ ...behind, unsaved: true, hidden: true })).toBe('wait');
  });

  it('waits while someone is typing or picking, but not once the tab is hidden', () => {
    expect(reloadDecision({ ...behind, engaged: true })).toBe('wait');
    expect(reloadDecision({ ...behind, engaged: true, hidden: true })).toBe('reload');
  });

  it('reloads only once for a build, so a stale page can’t loop', () => {
    expect(reloadDecision({ ...behind, reloadedFor: 'def' })).toBe('current');
    expect(reloadDecision({ ...behind, reloadedFor: 'older' })).toBe('reload');
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
