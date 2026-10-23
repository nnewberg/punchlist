import { useCallback, useState, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { BoardEntry, BoardInfo } from '../../shared/types';
import { account, boardPath, signOut } from '../api';
import { Avatar, ChevronIcon, FilterIcon, Logo, PlusIcon, SearchIcon, useDismiss } from './ui';

export function Header({ title, board, boards, viewers, me, query, onQuery, searchRef, filter, onNew }: {
  title?: ReactNode;
  board?: BoardInfo & { role?: BoardEntry['role'] };
  boards: BoardInfo[];
  viewers?: string[];
  me: string;
  query: string;
  onQuery: (q: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  filter?: ReactNode;
  onNew?: () => void;
}) {
  return (
    <div className="hdr">
      <Link to="/" className="brand">
        <Logo />
        <span className="wordmark">Punchlist</span>
      </Link>
      {board ? <BoardSwitcher board={board} boards={boards} /> : <span className="hdr-title">{title}</span>}
      {board?.role === 'view' && <span className="badge-ro" title="You have read access to this repo, so you can see the board but not change it">View only</span>}
      <div className="spacer" />
      {viewers && (
        <>
          <div className="viewers" title="Viewing now">
            {viewers.map(v => <Avatar key={v} user={v} />)}
          </div>
          <div className="vdivider" />
        </>
      )}
      <label className="search">
        <SearchIcon />
        <input ref={searchRef} data-not-draft value={query} placeholder="Search" onChange={e => onQuery(e.target.value)} onKeyDown={e => e.key === 'Escape' && (onQuery(''), e.currentTarget.blur())} />
      </label>
      {filter}
      {onNew && (
        <button className="btn btn-accent" onClick={onNew}>
          <PlusIcon />
          <span className="lbl">New item</span>
        </button>
      )}
      <AccountMenu me={me} />
    </div>
  );
}

function AccountMenu({ me }: { me: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const nav = useNavigate();
  const acct = account();
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="account-btn" aria-label="Account" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Avatar user={me} size={26} title="" />
      </button>
      {open && (
        <div className="menu" style={{ top: 34, right: 0 }}>
          <div className="menu-hd">Signed in as <b>{me}</b>{acct?.dev ? ' (dev)' : ''}</div>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => (close(), nav('/me'))}>My work</button>
          {acct?.installUrl && <a className="menu-item" href={acct.installUrl}>Add a repo…</a>}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => void signOut()}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function BoardSwitcher({ board, boards }: { board: BoardInfo; boards: BoardInfo[] }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const nav = useNavigate();
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="switcher" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="owner">{board.owner} /</span>
        <span>{board.repo}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="menu" style={{ top: 34, left: 0 }}>
          {boards.map(b => (
            <button key={boardPath(b)} className={`menu-item${b.owner === board.owner && b.repo === board.repo ? ' current' : ''}`} onClick={() => (close(), nav(boardPath(b)))}>
              <span style={{ color: 'var(--fg3)' }}>{b.owner} /</span> {b.repo}
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg3)' }}>{b.prefix}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => (close(), nav('/me'))}>My work</button>
        </div>
      )}
    </div>
  );
}

export interface Filters {
  tags: Set<string>;
  holders: Set<string>;
  sources: Set<string>;
  dropped: boolean;
}
export const emptyFilters = (): Filters => ({ tags: new Set(), holders: new Set(), sources: new Set(), dropped: false });
export const filterCount = (f: Filters) => f.tags.size + f.holders.size + f.sources.size + (f.dropped ? 1 : 0);

export function FilterMenu({ filters, onChange, tags, holders, sources }: { filters: Filters; onChange: (f: Filters) => void; tags: string[]; holders: string[]; sources: string[] }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const n = filterCount(filters);
  const toggle = (key: 'tags' | 'holders' | 'sources', v: string) => {
    const next = new Set(filters[key]);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange({ ...filters, [key]: next });
  };
  const group = (label: string, key: 'tags' | 'holders' | 'sources', values: string[], fmt: (v: string) => string = v => v) =>
    values.length > 0 && (
      <>
        <div className="menu-label">{label}</div>
        <div className="chips">
          {values.map(v => (
            <button key={v} className="chip" aria-pressed={filters[key].has(v)} onClick={() => toggle(key, v)}>{fmt(v)}</button>
          ))}
        </div>
      </>
    );
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className={`btn${n ? ' active' : ''}`} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <FilterIcon />
        <span className="lbl">Filter{n ? ` · ${n}` : ''}</span>
      </button>
      {open && (
        <div className="menu" style={{ top: 34, right: 0, width: 300 }}>
          {group('Holder', 'holders', holders, v => (v === '' ? 'Unclaimed' : v[0]!.toUpperCase() + v.slice(1)))}
          {group('Tag', 'tags', tags)}
          {group('Source', 'sources', sources)}
          <div className="menu-label">Status</div>
          <div className="chips">
            <button className="chip" aria-pressed={filters.dropped} onClick={() => onChange({ ...filters, dropped: !filters.dropped })}>Show deleted</button>
          </div>
          {n > 0 && (
            <>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => onChange(emptyFilters())}>Clear filters</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
