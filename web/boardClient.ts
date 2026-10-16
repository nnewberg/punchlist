import { useEffect, useState, useSyncExternalStore } from 'react';
import { applyOp } from '../shared/ops';
import type { BoardEvent, BoardInfo, Item, Op, OpError, ServerMsg, Snapshot } from '../shared/types';
import { api, boardApi, wsUrl } from './api';

// Live board state for one tab. The server decides (FR-7): `confirmed` holds what the board Durable
// Object has acknowledged, and pending local ops are re-applied on top of it with the same pure
// `applyOp` the server runs, so changes show instantly and roll back if the server rejects them.

/** `seq` is the event the op became, when it changed anything. */
export type OpResult = { ok: true; seq?: number } | { ok: false; error: OpError };
export type Conn = 'connecting' | 'live' | 'offline';

interface Pending {
  clientOpId: string;
  op: Op;
  tempId?: string;
  sent: boolean;
  resolve: (r: OpResult) => void;
}

export interface RemoteChange {
  event: BoardEvent;
  item: Item;
  prev: Item | undefined;
}

interface State {
  items: ReadonlyMap<string, Item>;
  viewers: string[];
  conn: Conn;
  loaded: boolean;
  missing: boolean;
}

export class BoardClient {
  private confirmed = new Map<string, Item>();
  private pending: Pending[] = [];
  private seq = 0;
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  private keepalive: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private state: State = { items: new Map(), viewers: [], conn: 'connecting', loaded: false, missing: false };
  /** Called for changes made elsewhere (another person, tab, agent or GitHub). */
  onRemote?: (c: RemoteChange) => void;
  onReject?: (error: OpError, op: Op) => void;
  onEvent?: (event: BoardEvent) => void;

  constructor(public readonly board: Pick<BoardInfo, 'owner' | 'repo'>, public readonly me: string) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  async start() {
    try {
      const snap = await api<Snapshot>(boardApi(this.board));
      if (this.stopped) return;
      this.loadSnapshot(snap);
      this.connect();
    } catch {
      this.set({ missing: true, loaded: true });
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.keepalive);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private loadSnapshot(snap: Snapshot) {
    this.confirmed = new Map(snap.items.map(i => [i.id, i]));
    this.seq = snap.seq;
    this.recompute({ viewers: snap.viewers, loaded: true });
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(wsUrl(`${boardApi(this.board)}/ws`));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ conn: 'live' });
      // Catch up on anything missed while disconnected, then flush ops queued meanwhile.
      ws.send(JSON.stringify({ type: 'sync', since: this.seq }));
      for (const p of this.pending) if (!p.sent) this.transmit(p);
      clearInterval(this.keepalive);
      // Answered by the DO's auto-response without waking it (PRD §8).
      this.keepalive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30_000);
    };
    ws.onmessage = e => {
      if (e.data === 'pong') return;
      this.handle(JSON.parse(e.data as string) as ServerMsg);
    };
    ws.onclose = () => {
      clearInterval(this.keepalive);
      if (this.stopped) return;
      // Ops already sent may or may not have landed; the sync on reconnect tells us. Drop them locally.
      for (const p of this.pending.filter(p => p.sent)) p.resolve({ ok: true });
      this.pending = this.pending.filter(p => !p.sent);
      this.recompute({ conn: 'offline' });
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private handle(msg: ServerMsg) {
    switch (msg.type) {
      case 'event':
        this.applyServerEvent(msg.event, msg.item, msg.clientOpId);
        break;
      case 'events':
        for (const e of msg.events) this.applyServerEvent(e.event, e.item);
        this.seq = Math.max(this.seq, msg.seq);
        break;
      case 'resync':
        this.loadSnapshot(msg.snapshot);
        break;
      case 'reject': {
        const p = this.takePending(msg.clientOpId);
        if (p) {
          p.resolve({ ok: false, error: msg.error });
          this.onReject?.(msg.error, p.op);
        }
        this.recompute();
        break;
      }
      case 'ack':
        this.takePending(msg.clientOpId)?.resolve({ ok: true });
        this.recompute();
        break;
      case 'presence':
        this.set({ viewers: msg.viewers });
        break;
    }
  }

  private applyServerEvent(event: BoardEvent, item: Item, clientOpId?: string) {
    if (event.seq <= this.seq && !clientOpId) return; // already have it
    const prev = this.confirmed.get(item.id);
    this.confirmed.set(item.id, item);
    this.seq = Math.max(this.seq, event.seq);
    const mine = clientOpId ? this.takePending(clientOpId) : undefined;
    mine?.resolve({ ok: true, seq: event.seq });
    this.recompute();
    this.onEvent?.(event);
    if (!mine) this.onRemote?.({ event, item, prev });
  }

  private takePending(id: string): Pending | undefined {
    const i = this.pending.findIndex(p => p.clientOpId === id);
    return i >= 0 ? this.pending.splice(i, 1)[0] : undefined;
  }

  private recompute(extra: Partial<State> = {}) {
    const view = new Map(this.confirmed);
    const now = new Date().toISOString();
    for (const p of this.pending) {
      const res = applyOp(view, p.op, { actor: { user: this.me, via: 'web' }, now, newId: p.tempId });
      if (res.ok && !res.noop) view.set(res.after.id, res.after);
    }
    this.set({ items: view, ...extra });
  }

  private transmit(p: Pending) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'op', clientOpId: p.clientOpId, op: p.op }));
    p.sent = true;
  }

  /** Apply locally right away and send to the board. Resolves once the server accepts or rejects it. */
  send(op: Op): Promise<OpResult> {
    return new Promise(resolve => {
      const clientOpId = crypto.randomUUID();
      const p: Pending = { clientOpId, op, sent: false, resolve, ...(op.op === 'create' ? { tempId: `new-${clientOpId.slice(0, 4)}` } : {}) };
      this.pending.push(p);
      this.recompute();
      this.transmit(p);
    });
  }
}

export function useBoard(board: Pick<BoardInfo, 'owner' | 'repo'>, me: string | null) {
  const [client, setClient] = useState<BoardClient | null>(null);
  useEffect(() => {
    if (!me) return;
    const c = new BoardClient(board, me);
    setClient(c);
    void c.start();
    return () => c.stop();
  }, [board.owner, board.repo, me]);
  const state = useSyncExternalStore(client?.subscribe ?? noopSubscribe, client?.getState ?? getEmpty);
  return { client, ...state };
}

const EMPTY: State = { items: new Map(), viewers: [], conn: 'connecting', loaded: false, missing: false };
const noopSubscribe = () => () => {};
const getEmpty = () => EMPTY;
