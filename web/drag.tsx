import { Component, createRef, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { Status } from '../shared/types';

// Card dragging, done with pointer events rather than HTML5 drag and drop so the card in hand and
// the cards around it can move: the card lifts and tilts with the pointer, the seam it's over opens
// to its height, and on release it flies into the gap while the column it left closes up.

export interface Slot {
  status: Status;
  beforeId: string | null;
}
export interface Over extends Slot {
  /** Top of the open gap, in the column body's scroll coordinates. */
  zoneTop: number;
}
export interface DragState {
  id: string;
  w: number;
  h: number;
  /** How far cards below the gap move: the held card's height plus the gap between cards. */
  shift: number;
  over: Over | null;
  dropping: boolean;
}
export interface FlipHint {
  id: string;
  rect: DOMRect;
}

const SLOP = 4;
const TOUCH_SLOP = 8;
const HOLD_MS = 220;
const FLY_MS = 200;
const EDGE = 56;

interface Session {
  id: string;
  pointerId: number;
  touch: boolean;
  started: boolean;
  x: number;
  y: number;
  x0: number;
  y0: number;
  offX: number;
  offY: number;
  w: number;
  h: number;
  shift: number;
  tilt: number;
  over: Over | null;
  hold?: ReturnType<typeof setTimeout>;
  settle?: ReturnType<typeof setTimeout>;
  raf?: number;
  done: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * `resolve` turns the slot under the pointer into where the card would really land, or null when
 * dropping there changes nothing. `onDrop` makes the move.
 */
export function useCardDrag({ resolve, onDrop }: {
  resolve: (id: string, slot: Slot) => Slot | null;
  onDrop: (id: string, slot: Slot) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const cb = useRef({ resolve, onDrop });
  cb.current = { resolve, onDrop };
  const session = useRef<Session | null>(null);
  const floatEl = useRef<HTMLElement | null>(null);
  const flipHint = useRef<FlipHint | null>(null);

  const place = useCallback(() => {
    const s = session.current;
    const el = floatEl.current;
    if (!s || !el) return;
    el.style.transform = `translate3d(${s.x - s.offX}px, ${s.y - s.offY}px, 0)`;
    el.style.setProperty('--tilt', `${s.tilt}deg`);
  }, []);

  /** Which slot the pointer is over. Cards past the open gap are measured where they're drawn, so the gap stays put while the pointer is in it. */
  const hitTest = useCallback(() => {
    const s = session.current;
    if (!s?.started) return;
    const col = [...document.querySelectorAll<HTMLElement>('[data-col]')].find(c => {
      const r = c.getBoundingClientRect();
      return s.x >= r.left && s.x <= r.right;
    });
    if (!col) return; // in the gutter between columns: keep the current slot
    const status = col.dataset.col as Status;
    const body = col.querySelector<HTMLElement>('.col-body');
    if (!body) return;
    const br = body.getBoundingClientRect();
    const y = s.y - br.top + body.scrollTop;
    const wraps = [...body.querySelectorAll<HTMLElement>(':scope > .card-wrap[data-item]')];
    const gapAt = s.over?.status === status ? s.over.beforeId : undefined;
    let shifted = false;
    let beforeId: string | null = null;
    for (const w of wraps) {
      if (w.dataset.item === gapAt) shifted = true;
      if (w.dataset.item === s.id) continue;
      if (y < w.offsetTop + (shifted ? s.shift : 0) + w.offsetHeight / 2) {
        beforeId = w.dataset.item!;
        break;
      }
    }
    const slot = cb.current.resolve(s.id, { status, beforeId });
    let over: Over | null = null;
    if (slot) {
      const at = slot.beforeId ? wraps.find(w => w.dataset.item === slot.beforeId) : undefined;
      const last = wraps[wraps.length - 1];
      const zoneTop = at ? at.offsetTop : last ? last.offsetTop + last.offsetHeight + (s.shift - s.h) : parseFloat(getComputedStyle(body).paddingTop);
      over = { ...slot, zoneTop };
    }
    if (over?.status === s.over?.status && over?.beforeId === s.over?.beforeId) return;
    s.over = over;
    setDrag(d => (d ? { ...d, over } : d));
  }, []);

  // Scroll the column (or the board, sideways) when the card is held near an edge.
  const autoScroll = useCallback(() => {
    const s = session.current;
    if (!s?.started) return;
    let moved = false;
    const col = [...document.querySelectorAll<HTMLElement>('[data-col]')].find(c => {
      const r = c.getBoundingClientRect();
      return s.x >= r.left && s.x <= r.right;
    });
    const body = col?.querySelector<HTMLElement>('.col-body');
    if (body) {
      const r = body.getBoundingClientRect();
      const dy = s.y < r.top + EDGE ? -(r.top + EDGE - s.y) : s.y > r.bottom - EDGE ? s.y - (r.bottom - EDGE) : 0;
      if (dy) {
        const before = body.scrollTop;
        body.scrollTop += clamp(dy / EDGE, -1, 1) * 14;
        moved ||= body.scrollTop !== before;
      }
    }
    const board = document.querySelector<HTMLElement>('.board');
    if (board) {
      const r = board.getBoundingClientRect();
      const dx = s.x < r.left + EDGE ? -(r.left + EDGE - s.x) : s.x > r.right - EDGE ? s.x - (r.right - EDGE) : 0;
      if (dx) {
        const before = board.scrollLeft;
        board.scrollLeft += clamp(dx / EDGE, -1, 1) * 14;
        moved ||= board.scrollLeft !== before;
      }
    }
    if (moved) hitTest();
    s.raf = requestAnimationFrame(autoScroll);
  }, [hitTest]);

  const finish = useCallback((commit: boolean) => {
    const s = session.current;
    if (!s) return;
    s.done();
    if (!s.started) {
      session.current = null;
      return;
    }
    // The pointerup ends on a card (or the ghost), and its click would open the sheet.
    const eat = (e: Event) => e.stopPropagation();
    window.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);

    const over = commit ? s.over : null;
    let to: DOMRect | undefined;
    if (over) {
      const body = document.querySelector<HTMLElement>(`[data-col="${over.status}"] .col-body`);
      if (body) {
        const r = body.getBoundingClientRect();
        to = new DOMRect(r.left + parseFloat(getComputedStyle(body).paddingLeft), r.top - body.scrollTop + over.zoneTop, s.w, s.h);
      }
    } else {
      to = document.querySelector(`.card-wrap[data-item="${CSS.escape(s.id)}"] .card`)?.getBoundingClientRect();
    }
    setDrag(d => (d ? { ...d, over, dropping: true } : d));
    const el = floatEl.current;
    if (el && to) {
      el.style.transition = `transform ${FLY_MS}ms cubic-bezier(.2,.8,.2,1)`;
      el.style.transform = `translate3d(${to.left}px, ${to.top}px, 0)`;
    }
    setTimeout(() => {
      if (over && to) flipHint.current = { id: s.id, rect: to };
      // One render for both, so the card lands in its slot as the gap closes, with no frame between.
      flushSync(() => {
        if (over) cb.current.onDrop(s.id, over);
        setDrag(null);
      });
      document.documentElement.classList.remove('is-dragging');
      session.current = null;
    }, to ? FLY_MS : 0);
  }, []);

  const start = useCallback(() => {
    const s = session.current;
    if (!s || s.started) return;
    s.started = true;
    document.documentElement.classList.add('is-dragging');
    window.getSelection()?.removeAllRanges();
    setDrag({ id: s.id, w: s.w, h: s.h, shift: s.shift, over: null, dropping: false });
    s.raf = requestAnimationFrame(autoScroll);
  }, [autoScroll]);

  const onPointerDown = useCallback((id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || session.current || (e.target as HTMLElement).closest('button, a, input, textarea')) return;
    const card = e.currentTarget;
    const r = card.getBoundingClientRect();
    const body = card.closest('.col-body');
    const gap = body ? parseFloat(getComputedStyle(body).rowGap) || 0 : 0;
    const touch = e.pointerType === 'touch';

    const onMove = (ev: PointerEvent) => {
      const s = session.current;
      if (!s || ev.pointerId !== s.pointerId) return;
      const dx = ev.clientX - s.x;
      s.x = ev.clientX;
      s.y = ev.clientY;
      if (!s.started) {
        const far = Math.hypot(s.x - s.x0, s.y - s.y0);
        if (touch && far > TOUCH_SLOP) finish(false); // a scroll, not a hold
        else if (!touch && far > SLOP) start();
        return;
      }
      // Lean into the motion, then ease back upright when the pointer rests.
      s.tilt = clamp(s.tilt * 0.6 + dx * 0.35, -9, 9);
      clearTimeout(s.settle);
      s.settle = setTimeout(() => {
        s.tilt = 0;
        place();
      }, 90);
      place();
      hitTest();
    };
    const onUp = (ev: PointerEvent) => ev.pointerId === session.current?.pointerId && finish(true);
    const onCancel = (ev: PointerEvent) => ev.pointerId === session.current?.pointerId && finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && session.current?.started) {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };
    // Once a touch drag starts, keep the page from scrolling under it.
    const onTouchMove = (ev: TouchEvent) => session.current?.started && ev.preventDefault();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('touchmove', onTouchMove, { passive: false });

    session.current = {
      id,
      pointerId: e.pointerId,
      touch,
      started: false,
      x: e.clientX,
      y: e.clientY,
      x0: e.clientX,
      y0: e.clientY,
      offX: e.clientX - r.left,
      offY: e.clientY - r.top,
      w: r.width,
      h: r.height,
      shift: r.height + gap,
      tilt: 0,
      over: null,
      done() {
        clearTimeout(this.hold);
        clearTimeout(this.settle);
        if (this.raf) cancelAnimationFrame(this.raf);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('touchmove', onTouchMove);
      },
    };
    if (touch) session.current.hold = setTimeout(start, HOLD_MS);
  }, [finish, hitTest, place, start]);

  useEffect(() => () => {
    session.current?.done();
    document.documentElement.classList.remove('is-dragging');
  }, []);

  const floatRef = useCallback((el: HTMLElement | null) => {
    floatEl.current = el;
    place();
  }, [place]);

  return { drag, onPointerDown, floatRef, flipHint };
}

/** The card in hand, drawn above everything at the pointer. */
export function DragFloat({ drag, floatRef, children }: { drag: DragState; floatRef: (el: HTMLElement | null) => void; children: ReactNode }) {
  return createPortal(
    <div ref={floatRef} className={`drag-float${drag.dropping ? ' dropping' : ''}`} style={{ width: drag.w }}>
      <div className="drag-lift">{children}</div>
    </div>,
    document.body,
  );
}

/**
 * Animates cards from where they were drawn to where they land whenever `watch` changes: the column a
 * card left closes up, and other people's reorders slide instead of jumping. `hint` overrides the
 * starting point of a card that was just dropped (it starts where the card in hand landed).
 */
export class Flip extends Component<{ watch: unknown; hint: RefObject<FlipHint | null>; className: string; children: ReactNode }> {
  root = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(prev: Readonly<{ watch: unknown }>) {
    if (prev.watch === this.props.watch || !this.root.current) return null;
    const rects = new Map<string, DOMRect>();
    for (const el of this.root.current.querySelectorAll<HTMLElement>('.card-wrap[data-item]')) rects.set(el.dataset.item!, el.getBoundingClientRect());
    const hint = this.props.hint.current;
    if (hint) rects.set(hint.id, hint.rect);
    return rects;
  }

  componentDidUpdate(_p: unknown, _s: unknown, before: Map<string, DOMRect> | null) {
    if (!before || !this.root.current) return;
    (this.props.hint as { current: FlipHint | null }).current = null;
    for (const el of this.root.current.querySelectorAll<HTMLElement>('.card-wrap[data-item]')) {
      const was = before.get(el.dataset.item!);
      if (!was || el.classList.contains('arrived')) continue;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      // A card that changed columns someone else's way would fly clipped by its new column; let it just appear.
      if (Math.abs(dx) > now.width / 2 || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) continue;
      el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  render() {
    return <div ref={this.root} className={this.props.className}>{this.props.children}</div>;
  }
}
