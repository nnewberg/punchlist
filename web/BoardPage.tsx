import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { person } from '../shared/config';
import { isRecentDone, matchesQuery } from '../shared/derive';
import { columnItems } from '../shared/ops';
import type { BoardInfo, Column as ColumnKey, Status } from '../shared/types';
import { useBoard, type RemoteChange } from './boardClient';
import { Card } from './components/Card';
import { DetailSheet } from './components/DetailSheet';
import { emptyFilters, FilterMenu, filterCount, Header, type Filters } from './components/Header';
import { Toast, type ToastData } from './components/Toast';
import { Glyph, PlusIcon } from './components/ui';

const COLUMNS: { key: Status; title: string; sub?: string }[] = [
  { key: 'backlog', title: 'Backlog' },
  { key: 'up_next', title: 'Up Next' },
  { key: 'in_progress', title: 'In Progress' },
  { key: 'done', title: 'Done', sub: 'recent' },
];

const ARRIVE_MS = 6500;

export function BoardPage({ me, boards }: { me: string; boards: BoardInfo[] }) {
  const { owner = '', repo = '' } = useParams();
  const boardRef = useMemo(() => ({ owner, repo }), [owner, repo]);
  const { client, items, viewers, conn, loaded, missing } = useBoard(boardRef, me);
  const board = boards.find(b => b.owner === owner && b.repo === repo);

  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const setOpen = useCallback(
    (id: string | null) => setParams(p => {
      const n = new URLSearchParams(p);
      if (id) n.set('open', id);
      else n.delete('open');
      return n;
    }),
    [setParams],
  );

  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [showOlder, setShowOlder] = useState(false);
  const [composer, setComposer] = useState<ColumnKey | null>(null);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<ToastData | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ status: Status; beforeId: string | null } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setShowOlder(false);
    setComposer(null);
    setQuery('');
    setFilters(emptyFilters());
  }, [owner, repo]);

  // The live moment: someone else's change lands an item in Done and it "punches" in.
  useEffect(() => {
    if (!client) return;
    client.onRemote = ({ event, item, prev }: RemoteChange) => {
      if (item.status !== 'done' || prev?.status === 'done') return;
      const cite = [...item.citations].reverse().find(c => c.kind === 'closes');
      const who = cite?.author ?? event.actor.user ?? item.claim?.user ?? null;
      const name = who ? person(who).name : 'GitHub';
      const via = event.actor.via === 'github' && cite ? (cite.pr ? `${name}'s PR #${cite.pr}` : `${name}'s push ${cite.commit}`) : name;
      setArrived(s => new Set(s).add(item.id));
      setTimeout(() => setArrived(s => {
        const n = new Set(s);
        n.delete(item.id);
        return n;
      }), ARRIVE_MS);
      setToast({ key: event.seq, user: who, text: `${via} closed ${item.id}`, undoSeq: event.seq });
    };
    client.onReject = error => setToast({ key: Date.now(), user: null, text: error.message, warn: true });
  }, [client]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || openId) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'n') {
        e.preventDefault();
        setComposer('backlog');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId]);

  const all = useMemo(() => [...items.values()], [items]);
  const searching = query.trim() !== '' || filterCount(filters) > 0;
  const visible = useMemo(
    () => all.filter(it =>
      matchesQuery(it, query)
      && (!filters.tags.size || it.tags.some(t => filters.tags.has(t)))
      && (!filters.holders.size || filters.holders.has(it.claim?.user ?? ''))
      && (!filters.sources.size || filters.sources.has(it.source.kind))),
    [all, query, filters],
  );
  const facets = useMemo(() => ({
    tags: [...new Set(all.flatMap(i => i.tags))].sort(),
    holders: [...new Set(all.map(i => i.claim?.user ?? ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b))),
    sources: [...new Set(all.map(i => i.source.kind))].sort(),
  }), [all]);

  if (!loaded) return <Shell me={me} boards={boards} />;
  if (missing || !board || !client) {
    return (
      <Shell me={me} boards={boards}>
        <div className="signedout"><div style={{ color: 'var(--fg3)' }}>No board at {owner}/{repo}.</div></div>
      </Shell>
    );
  }

  const columns = [...COLUMNS, ...(filters.dropped ? [{ key: 'dropped' as const, title: 'Dropped' }] : [])];
  const openItem = openId ? items.get(openId) : undefined;

  const move = (status: Status, beforeId: string | null) => {
    const id = dragId;
    setDragId(null);
    setDropAt(null);
    if (!id || id === beforeId) return;
    const cur = items.get(id);
    if (!cur || (cur.status === status && status === 'done')) return;
    void client.send({ op: 'move', id, status, beforeId: status === 'done' ? null : beforeId });
  };

  return (
    <div className="app">
      <Header
        board={board}
        boards={boards}
        me={me}
        viewers={viewers}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        filter={<FilterMenu filters={filters} onChange={setFilters} {...facets} />}
        onNew={() => setComposer('backlog')}
      />
      <div className="board">
        {columns.map(col => {
          let list = columnItems(visible, col.key);
          let older = 0;
          if (col.key === 'done' && !searching && !showOlder) {
            const recent = list.filter(i => isRecentDone(i));
            older = list.length - recent.length;
            list = recent;
          }
          const isCol = col.key !== 'done' && col.key !== 'dropped';
          return (
            <div
              key={col.key}
              className={`col${dropAt?.status === col.key && dropAt.beforeId === null ? ' drop-target' : ''}`}
              onDragOver={(e: DragEvent) => {
                if (!dragId) return;
                e.preventDefault();
                if (dropAt?.status !== col.key || dropAt.beforeId !== null) setDropAt({ status: col.key, beforeId: null });
              }}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                move(col.key, null);
              }}
            >
              <div className="col-hd">
                <Glyph status={col.key} />
                <span className="title">{col.title}</span>
                <span className="count">{list.length}</span>
                {col.sub && <span className="sub">{col.sub}</span>}
                {isCol && <button className="icon-btn end" aria-label={`Add to ${col.title}`} onClick={() => setComposer(col.key as ColumnKey)}><PlusIcon /></button>}
              </div>
              <div className="col-body">
                {composer === col.key && (
                  <Composer
                    onCancel={() => setComposer(null)}
                    onSubmit={title => {
                      void client.send({ op: 'create', title, status: col.key as ColumnKey });
                      setComposer(null);
                    }}
                  />
                )}
                {list.map(it => (
                  <Card
                    key={it.id}
                    item={it}
                    items={items}
                    arrived={arrived.has(it.id)}
                    onOpen={() => setOpen(it.id)}
                    dnd={{
                      dragging: dragId === it.id,
                      dropBefore: !!dragId && dropAt?.beforeId === it.id && dragId !== it.id && col.key !== 'done',
                      onDragStart: e => {
                        e.dataTransfer.setData('text/plain', it.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragId(it.id);
                      },
                      onDragEnd: () => {
                        setDragId(null);
                        setDropAt(null);
                      },
                      onDragOver: e => {
                        if (!dragId) return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (dropAt?.beforeId !== it.id) setDropAt({ status: it.status, beforeId: it.id });
                      },
                      onDrop: e => {
                        e.preventDefault();
                        e.stopPropagation();
                        move(it.status, it.id);
                      },
                    }}
                  />
                ))}
                {list.length === 0 && composer !== col.key && <div className="col-empty">{searching ? 'No matches' : ''}</div>}
                {older > 0 && <button className="older" onClick={() => setShowOlder(true)}>Show {older} older</button>}
                {showOlder && col.key === 'done' && !searching && <button className="older" onClick={() => setShowOlder(false)}>Show recent only</button>}
              </div>
            </div>
          );
        })}
      </div>
      {conn === 'offline' && <div className="status-line"><span className="d" />Reconnecting…</div>}
      {openItem && (
        <DetailSheet key={openItem.id} item={openItem} items={items} board={board} client={client} onClose={() => setOpen(null)} onOpen={id => setOpen(id)} />
      )}
      {toast && (
        <Toast
          data={toast}
          onDone={() => setToast(t => (t?.key === toast.key ? null : t))}
          onUndo={toast.undoSeq ? () => (void client.send({ op: 'undo', seq: toast.undoSeq! }), setToast(null)) : undefined}
        />
      )}
    </div>
  );
}

function Shell({ me, boards, children }: { me: string; boards: BoardInfo[]; children?: ReactNode }) {
  return (
    <div className="app">
      <Header me={me} boards={boards} query="" onQuery={() => {}} title="" />
      {children}
    </div>
  );
}

function Composer({ onSubmit, onCancel }: { onSubmit: (title: string) => void; onCancel: () => void }) {
  return (
    <div className="composer">
      <textarea
        autoFocus
        rows={2}
        placeholder="What needs doing?"
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const v = e.currentTarget.value.trim();
            if (v) onSubmit(v);
          }
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={e => !e.currentTarget.value.trim() && onCancel()}
      />
      <div className="hint">⏎ add · esc cancel</div>
    </div>
  );
}

