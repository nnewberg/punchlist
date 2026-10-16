import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { person } from '../../shared/config';
import { age, openDeps } from '../../shared/derive';
import { STATUS_LABEL } from '../../shared/ops';
import type { BoardEvent, BoardInfo, Item, OpError } from '../../shared/types';
import { api, boardApi } from '../api';
import type { BoardClient } from '../boardClient';
import { Avatar, CloseIcon, Field, Glyph, InlineInput, TrashIcon } from './ui';

// Item detail, opened as a centered sheet (design 1b). Everything here is editable in place (FR-12),
// with history and per-event undo from the event log (FR-15). Someone with only read access to the
// repo sees the same sheet without the controls (FR-2).
export function DetailSheet({ item, items, board, client, onClose, onOpen, onDeleted, readOnly = false }: {
  item: Item;
  items: ReadonlyMap<string, Item>;
  board: BoardInfo;
  client: BoardClient;
  onClose: () => void;
  onOpen: (id: string) => void;
  onDeleted: (id: string, seq: number) => void;
  readOnly?: boolean;
}) {
  const ro = readOnly;
  const [history, setHistory] = useState<BoardEvent[]>([]);
  const [adding, setAdding] = useState<null | 'tag' | 'block' | 'dep'>(null);
  const [error, setError] = useState<string | null>(null);
  const send = (op: Parameters<BoardClient['send']>[0]) =>
    client.send(op).then(r => {
      if (!r.ok) setError(r.error.message);
      return r;
    });

  useEffect(() => {
    let live = true;
    if (item.id.startsWith('new-')) return;
    api<{ events: BoardEvent[] }>(`${boardApi(board)}/items/${encodeURIComponent(item.id)}/history`).then(r => live && setHistory(r.events), () => {});
    return () => {
      live = false;
    };
  }, [board, item.id, item.updated_at]);

  useEffect(() => setError(null), [item.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const done = item.status === 'done';
  const dropped = item.status === 'dropped';
  const claim = item.claim;
  const mine = claim?.user === client.me;
  const pendingFix = item.citations.filter(c => c.kind === 'pending' && !c.reverted);
  const closes = item.citations.filter(c => c.kind === 'closes' && !c.reverted);
  const deps = openDeps(item, items);
  const undone = new Set(history.flatMap(e => (e.meta?.undoOf ? [e.meta.undoOf] : [])));

  return (
    <>
      {/* A click outside while typing only leaves the field, so an unsaved draft isn't lost. */}
      <div className="scrim" onClick={() => (document.activeElement?.closest('.sheet textarea, .sheet input') ? (document.activeElement as HTMLElement).blur() : onClose())} />
      <div className="sheet" role="dialog" aria-label={`${item.id} ${item.title}`}>
        <div className="sheet-hd">
          <span className="id">{item.id}</span>
          <span className="pill"><Glyph status={item.status} />{STATUS_LABEL[item.status]}</span>
          {(done || dropped) && !ro && <button className="btn-reopen" onClick={() => send({ op: 'reopen', id: item.id })}>Reopen</button>}
          <span style={{ flex: 1 }} />
          {/* Nothing is destroyed (PRD §6.1): a deleted item leaves the board but stays searchable, and the toast can undo it. */}
          {!dropped && !ro && (
            <button
              className="close-btn trash"
              aria-label="Delete"
              title="Delete"
              onClick={() => {
                onClose();
                void client.send({ op: 'drop', id: item.id }).then(r => r.ok && r.seq && onDeleted(item.id, r.seq));
              }}
            >
              <TrashIcon />
            </button>
          )}
          <button className="close-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        <div className="sheet-body">
          {error && (
            <div className="conflict" style={{ background: 'var(--warnSoft)', color: 'var(--warn)' }}>
              <div style={{ display: 'flex', gap: 8 }}>{error}<span style={{ flex: 1 }} /><button className="btn-link" onClick={() => setError(null)}>Dismiss</button></div>
            </div>
          )}
          <Title item={item} readOnly={ro} onSave={title => send({ op: 'edit', id: item.id, title })} />
          <Body item={item} client={client} readOnly={ro} />

          <div className="fields">
            <Field label="Status">
              <span className="pill"><Glyph status={item.status} />{STATUS_LABEL[item.status]}</span>
            </Field>
            <Field label="Claim">
              {claim ? (
                <>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Avatar user={claim.user} />
                    <span style={{ fontWeight: 500 }}>{person(claim.user).name}</span>
                    {claim.kind === 'branch' && claim.ref && (<><span style={{ color: 'var(--fg3)' }}>·</span><span className="mono" style={{ fontSize: 11.5, color: 'var(--fg2)' }}>{claim.ref}</span></>)}
                    {claim.kind === 'session' && <span className="badge-agent" title={claim.ref ? `Claude session ${claim.ref}` : 'Claude session'}>✦ Claude</span>}
                    {!done && <span style={{ color: 'var(--fg3)' }}>· {age(claim.since)}</span>}
                  </span>
                  {!done && !dropped && !ro && (mine
                    ? <button className="btn-sm" onClick={() => send({ op: 'release', id: item.id })}>Release</button>
                    : <button className="btn-sm" onClick={() => send({ op: 'claim', id: item.id, steal: true })} title={`Take this over from ${person(claim.user).name}; the log records it`}>Take over</button>)}
                </>
              ) : (
                <>
                  <span style={{ color: 'var(--fg3)' }}>Unclaimed</span>
                  {!done && !dropped && !ro && <button className="btn-sm" onClick={() => send({ op: 'claim', id: item.id })}>Claim</button>}
                </>
              )}
            </Field>
            <Field label="Tags">
              {item.tags.map(t => (
                <span key={t} className="tag">{t}{!ro && <button aria-label={`Remove ${t}`} onClick={() => send({ op: 'tag', id: item.id, remove: [t] })}>×</button>}</span>
              ))}
              {ro ? (!item.tags.length && <span style={{ color: 'var(--fg3)' }}>None</span>) : adding === 'tag'
                ? <InlineInput placeholder="tag" onSubmit={v => (send({ op: 'tag', id: item.id, add: v.split(/[\s,]+/) }), setAdding(null))} onCancel={() => setAdding(null)} />
                : <button className="btn-dashed" onClick={() => setAdding('tag')}>+ tag</button>}
            </Field>
            <Field label="Blocked">
              {item.blocked && (
                <span className="badge-warn"><span>⊘</span>{item.blocked.reason}</span>
              )}
              {deps.map(d => (
                <span key={d.id} className="dep">
                  <span className="badge-warn" style={{ flex: 'none' }}><span>⊘</span>waiting on</span>
                  <a onClick={() => onOpen(d.id)}>{d.id}</a>
                  <span className="t">{d.title}</span>
                </span>
              ))}
              {ro ? (!item.blocked && !deps.length && <span style={{ color: 'var(--fg3)' }}>No</span>) : item.blocked
                ? <button className="btn-sm" onClick={() => send({ op: 'unblock', id: item.id })}>Unblock</button>
                : adding === 'block'
                  ? <InlineInput placeholder="Reason" onSubmit={v => (send({ op: 'block', id: item.id, reason: v }), setAdding(null))} onCancel={() => setAdding(null)} />
                  : <>{!deps.length && <span style={{ color: 'var(--fg3)' }}>No</span>}<button className="btn-dashed" onClick={() => setAdding('block')}>+ reason</button></>}
            </Field>
            <Field label="Depends on">
              {item.depends_on.map(id => {
                const d = items.get(id);
                const finished = !d || d.status === 'done' || d.status === 'dropped';
                return (
                  <span key={id} className={`tag dep${finished ? ' finished' : ''}`}>
                    <a onClick={() => onOpen(id)}>{id}</a>
                    {!ro && <button aria-label={`Remove dependency ${id}`} onClick={() => send({ op: 'depends', id: item.id, remove: [id] })}>×</button>}
                  </span>
                );
              })}
              {ro ? (!item.depends_on.length && <span style={{ color: 'var(--fg3)' }}>None</span>) : adding === 'dep'
                ? <InlineInput placeholder={`${board.prefix}-012`} onSubmit={v => (send({ op: 'depends', id: item.id, add: [v] }), setAdding(null))} onCancel={() => setAdding(null)} />
                : <button className="btn-dashed" onClick={() => setAdding('dep')}>+ dependency</button>}
            </Field>
            {pendingFix.map((c, i) => (
              <Field key={`p${i}`} label="Fix">
                <span className="badge-pend"><span>◐</span>on branch <span className="mono" style={{ fontSize: 11.5 }}>{c.branch}</span> · not merged</span>
              </Field>
            ))}
            {done && closes.map((c, i) => (
              <Field key={`c${i}`} label="Closed by">
                {c.commit && <span className="mono" style={{ fontSize: 11.5, color: 'var(--accentFg)' }}>{c.commit}</span>}
                {c.pr && <span className="mono" style={{ fontSize: 11.5, color: 'var(--accentFg)' }}>PR #{c.pr}</span>}
                {c.message && <span style={{ color: 'var(--fg2)' }}>“{c.message}”</span>}
                {c.how === 'inferred' && <span className="badge-pend" title="Matched without an explicit Closes: trailer">inferred{c.confidence != null ? ` · ${Math.round(c.confidence * 100)}%` : ''}</span>}
              </Field>
            ))}
          </div>

          <div>
            <div className="section-label">Notes</div>
            <div className="notes">
              {item.notes.map((n, i) => (
                <div key={i} className="note">
                  <span style={{ marginTop: 1 }}><Avatar user={n.actor} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="who">
                      <b>{person(n.actor).name}</b>
                      {n.via === 'claude' && <span className="badge-agent">✦ Claude</span>}
                      <span className="age">{age(n.at)}</span>
                    </div>
                    <div className="txt">{n.text}</div>
                  </div>
                </div>
              ))}
              {!ro && <NoteInput onSubmit={text => send({ op: 'note', id: item.id, text })} />}
              {ro && !item.notes.length && <div style={{ color: 'var(--fg3)', fontSize: 13 }}>No notes</div>}
            </div>
          </div>

          <div>
            <div className="section-label" style={{ marginBottom: 4 }}>Activity</div>
            {history.map(e => (
              <div key={e.seq} className={`act${undone.has(e.seq) ? ' undone' : ''}`}>
                <span className={`dot${e.actor.via === 'github' ? ' gh' : ''}`} />
                <span className="txt">
                  {e.meta?.text ?? e.op}
                  {e.meta?.ref && <> <span className="ref">{e.meta.ref}</span></>}
                  {e.meta?.msg && <> <span className="msg">“{e.meta.msg}”</span></>}
                  {' '}<span className="who">· {e.actor.user ? person(e.actor.user).name : 'GitHub'}</span>
                </span>
                <span className="age">{age(e.ts)}</span>
                {e.undoable && !undone.has(e.seq) && !ro && (
                  <button className="btn-link" onClick={() => send({ op: 'undo', seq: e.seq })}>Undo</button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function Title({ item, onSave, readOnly }: { item: Item; onSave: (t: string) => void; readOnly: boolean }) {
  const [editing, setEditing] = useState(false);
  if (readOnly) return <div className="det-title ro">{item.title}</div>;
  if (!editing) return <div className="det-title" onClick={() => setEditing(true)} title="Click to edit">{item.title}</div>;
  return (
    <input
      autoFocus
      className="det-title-input"
      defaultValue={item.title}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setEditing(false);
        }
      }}
      onBlur={e => {
        const v = e.currentTarget.value.trim();
        if (v && v !== item.title) onSave(v);
        setEditing(false);
      }}
    />
  );
}

// Body edits carry the version they started from; if someone else saved in between, show their text
// and keep this draft rather than dropping it (FR-8).
function Body({ item, client, readOnly }: { item: Item; client: BoardClient; readOnly: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState(item.body_version);
  const [conflict, setConflict] = useState<Extract<OpError, { code: 'conflict' }> | null>(null);

  useEffect(() => {
    setDraft(null);
    setConflict(null);
  }, [item.id]);

  const start = () => {
    setDraft(item.body);
    setBase(item.body_version);
  };
  const save = async (version = base) => {
    if (draft === null) return;
    const r = await client.send({ op: 'edit', id: item.id, body: draft, baseBodyVersion: version });
    if (r.ok) {
      setDraft(null);
      setConflict(null);
    } else if (r.error.code === 'conflict') setConflict(r.error);
  };

  if (readOnly) {
    return item.body.trim() ? <div className="body-view ro"><div className="md"><Markdown>{item.body}</Markdown></div></div> : null;
  }
  if (draft === null) {
    return (
      <div className="body-view" onClick={e => !(e.target instanceof HTMLAnchorElement) && start()} title="Click to edit">
        {item.body.trim() ? <div className="md"><Markdown>{item.body}</Markdown></div> : <div className="md empty">Add a description…</div>}
      </div>
    );
  }
  return (
    <div className="body-edit">
      {conflict && (
        <div className="conflict">
          <div>{conflict.message}</div>
          <pre>{conflict.theirs || '(empty)'}</pre>
          <div className="row" style={{ display: 'flex', gap: 8 }}>
            <button className="btn-sm" onClick={() => save(conflict.version)}>Keep mine</button>
            <button className="btn-sm" onClick={() => (setDraft(conflict.theirs), setBase(conflict.version), setConflict(null))}>Edit theirs</button>
          </div>
        </div>
      )}
      <textarea
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(null);
            setConflict(null);
          }
        }}
        placeholder="Markdown — one line or a full spec"
      />
      <div className="row">
        <button className="btn btn-accent" onClick={() => save()}>Save</button>
        <button className="btn" onClick={() => (setDraft(null), setConflict(null))}>Cancel</button>
        <span style={{ fontSize: 11, color: 'var(--fg3)' }}>⌘⏎ to save · Markdown</span>
      </div>
    </div>
  );
}

function NoteInput({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [v, setV] = useState('');
  return (
    <input
      className="note-input"
      placeholder="Add a note…"
      value={v}
      onChange={e => setV(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && v.trim()) {
          onSubmit(v.trim());
          setV('');
        }
        if (e.key === 'Escape') e.currentTarget.blur();
      }}
    />
  );
}
