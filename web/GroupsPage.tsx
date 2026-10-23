import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { matchesQuery } from '../shared/derive';
import type { BoardInfo, Item, MyWorkBoard, Snapshot } from '../shared/types';
import { api, boardApi, boardPath } from './api';
import { Card } from './components/Card';
import { Header } from './components/Header';

interface Entry {
  item: Item;
  caption?: string;
  board: BoardInfo;
}
interface Group {
  title: string;
  sub?: string;
  board?: BoardInfo;
  entries: Entry[];
}

/** Columns of captioned cards. `all` is the full item set, so cards can tell whether a dependency is still open. */
function Groups({ groups, query = '', all }: { groups: Group[]; query?: string; all?: Item[] }) {
  const nav = useNavigate();
  const items = useMemo(() => new Map((all ?? groups.flatMap(g => g.entries.map(e => e.item))).map(i => [i.id, i] as const)), [groups, all]);
  return (
    <div className="board">
      {groups.map((g, gi) => {
        const entries = g.entries.filter(e => matchesQuery(e.item, query));
        return (
          <div key={gi} className="col">
            {g.title && (
              <div className="col-hd">
                <span className="title">{g.title}</span>
                {g.sub && <span className="sub">{g.sub}</span>}
                {g.board && <Link className="end" to={boardPath(g.board)}>Open board →</Link>}
              </div>
            )}
            <div className="col-body">
              {entries.map(e => (
                <Card key={e.item.id} item={e.item} items={items} caption={e.caption} onOpen={() => nav(`${boardPath(e.board)}?open=${encodeURIComponent(e.item.id)}`)} />
              ))}
              {entries.length === 0 && <div className="col-empty">Nothing here</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Captions only the first card of each run, as in the design. */
function section(list: Item[], caption: string, board: BoardInfo, seen: Set<string>): Entry[] {
  return list.filter(i => !seen.has(i.id) && (seen.add(i.id), true)).map((item, i) => ({ item, board, ...(i === 0 ? { caption } : {}) }));
}

// FR-35: everything I or my agents hold, plus each board's Up Next and anything blocked on me.
export function MyWorkPage({ me, boards }: { me: string; boards: BoardInfo[] }) {
  const [data, setData] = useState<MyWorkBoard[] | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    api<{ boards: MyWorkBoard[] }>('/v1/me/work').then(r => setData(r.boards), () => setData([]));
  }, [me]);
  const groups: Group[] = (data ?? []).map(b => {
    const seen = new Set<string>();
    return {
      title: b.board.repo,
      sub: b.board.owner,
      board: b.board,
      entries: [
        ...section(b.held, 'In progress', b.board, seen),
        ...section(b.blockedOnMe, 'Blocked on you', b.board, seen),
        ...section(b.upNext, 'Up next', b.board, seen),
      ],
    };
  });
  return (
    <div className="app" data-view-set={query.trim() !== '' || undefined}>
      <Header title="My work" boards={boards} me={me} query={query} onQuery={setQuery} />
      {data && <Groups groups={groups} query={query} />}
    </div>
  );
}

// Dev-only gallery of every state a card can be in (design: "Card states"), drawn from the seeded boards.
const STATE_GROUPS: [string, string, string][][] = [
  [['futureleisurefoundation/big-talk', 'BT-035', 'Plain item'], ['nnewberg/bulletin-bee', 'BB-031', "Claimed by a person's agent"]],
  [['futureleisurefoundation/big-talk', 'BT-014', 'Claimed through a branch'], ['nnewberg/bulletin-bee', 'BB-040', 'Blocked · external reason']],
  [['futureleisurefoundation/big-talk', 'BT-030', 'Blocked · waiting on another item']],
  [['futureleisurefoundation/big-talk', 'BT-033', 'Done · closed explicitly'], ['futureleisurefoundation/big-talk', 'BT-009', 'Done · closed by a push (no PR)']],
  [['nnewberg/bulletin-bee', 'BB-026', 'Has a recent note']],
];

export function StatesPage({ me, boards }: { me: string; boards: BoardInfo[] }) {
  const [snaps, setSnaps] = useState<Map<string, Snapshot>>(new Map());
  useEffect(() => {
    const keys = [...new Set(STATE_GROUPS.flat().map(([k]) => k))];
    Promise.all(keys.map(k => {
      const [owner, repo] = k.split('/') as [string, string];
      return api<Snapshot>(boardApi({ owner, repo })).then(s => [k, s] as const, () => null);
    })).then(r => setSnaps(new Map(r.filter(x => !!x))));
  }, [me]);
  const groups: Group[] = STATE_GROUPS.map(g => ({
    title: '',
    entries: g.flatMap(([k, id, caption]) => {
      const s = snaps.get(k);
      const item = s?.items.find(i => i.id === id);
      return s && item ? [{ item, caption, board: s.board }] : [];
    }),
  }));
  const all = useMemo(() => [...snaps.values()].flatMap(s => s.items), [snaps]);
  return (
    <div className="app">
      <Header title={<>Card states <span style={{ fontSize: 12, color: 'var(--fg3)', fontWeight: 400 }}>every state a card can be in</span></>} boards={boards} me={me} query="" onQuery={() => {}} />
      <Groups groups={groups} all={all} />
    </div>
  );
}
