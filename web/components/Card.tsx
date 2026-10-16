import type { PointerEvent } from 'react';
import { person } from '../../shared/config';
import { latestNote, openDeps } from '../../shared/derive';
import type { Item } from '../../shared/types';
import { Avatar, BranchIcon } from './ui';

export interface CardDnd {
  /** Lifted: the card is being dragged, so its slot shows an empty dashed outline. */
  lifted: boolean;
  /** How far down to draw the card, to open a gap above it for the card being dragged. */
  shift: number;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
}

// FR-13, laid out as in the design: the card names only the person working on an item, whether
// they or their agent does the work; a branch claim adds the branch name.
export function Card({ item, items, caption, arrived, focused, onOpen, dnd }: {
  item: Item;
  items: ReadonlyMap<string, Item>;
  caption?: string;
  arrived?: boolean;
  focused?: boolean;
  onOpen: () => void;
  dnd?: CardDnd;
}) {
  const claim = item.claim;
  const deps = openDeps(item, items);
  const blocked = !!item.blocked || deps.length > 0;
  const note = latestNote(item);
  const done = item.status === 'done';
  // FR-13: a fix that exists but hasn't reached the default branch yet.
  const pending = done ? undefined : item.citations.find(c => c.kind === 'pending');
  const hasMeta = !!claim || blocked || !!note || !!pending;

  return (
    <div
      className={`card-wrap${arrived ? ' arrived' : ''}${dnd?.lifted ? ' lifted' : ''}`}
      data-item={item.id}
      style={dnd?.shift ? { translate: `0 ${dnd.shift}px` } : undefined}
    >
      {caption && <div className="caption">{caption}</div>}
      <div
        className="card"
        role="button"
        tabIndex={0}
        data-id={item.id}
        onPointerDown={dnd?.onPointerDown}
        onClick={onOpen}
        onKeyDown={e => e.key === 'Enter' && onOpen()}
      >
        {arrived && <div className="glow" />}
        {focused && <div className="focus" />}
        {arrived && (
          <div className="card-top">
            <span className="just-now">just now</span>
          </div>
        )}
        <div className={`card-title${done ? ' done' : ''}`}>
          {item.title}
          {!hasMeta && <span className="id-inline">{item.id}</span>}
        </div>
        {hasMeta && (
          <div className="card-meta">
            {claim && (
              <span className="claim">
                <Avatar user={claim.user} />
                <span className="name">{person(claim.user).name}</span>
                {claim.kind === 'branch' && claim.ref && (
                  <>
                    <span className="dot">·</span>
                    <span className="branch">
                      <BranchIcon />
                      <span title={claim.ref}>{claim.ref}</span>
                    </span>
                  </>
                )}
              </span>
            )}
            {blocked && (
              <span className="badge-blocked" title={item.blocked?.reason ?? `waiting on ${deps.map(d => d.id).join(', ')}`}>
                <span>⊘</span>
                <b>Blocked</b>
              </span>
            )}
            {pending && (
              <span className="badge-pend" title={pending.message ?? 'A fix is waiting to merge'}>
                <span>◐</span>
                {pending.pr ? `fix in PR #${pending.pr}` : pending.branch === claim?.ref ? 'fix pending' : <>fix on <span className="mono">{pending.branch}</span></>}
              </span>
            )}
            {note && (
              <span className="card-note">
                <span className="pen">✎</span>
                <span className="txt">{note}</span>
              </span>
            )}
            <span className="card-id">{item.id}</span>
          </div>
        )}
      </div>
    </div>
  );
}
