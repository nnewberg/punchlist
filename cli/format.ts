import { age, isRecentDone, openDeps } from '../shared/derive';
import { shortSha } from '../shared/github';
import { columnItems, STATUS_LABEL } from '../shared/ops';
import type { BoardEvent, Item, MyWorkBoard, Snapshot, Status } from '../shared/types';

// How the board reads in a terminal. `formatList` is for people; `formatCompact` is the agent view
// (FR-18): everything Claude needs at the start of a session in about 1,500 tokens.

const useColor = () => !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  magenta: paint('35'),
  orange: paint('38;5;209'),
};

const GLYPH: Record<Status, string> = { backlog: '○', up_next: '◔', in_progress: '◑', done: '●', dropped: '×' };
const ORDER: Status[] = ['in_progress', 'up_next', 'backlog', 'done'];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ago = (iso: string) => (age(iso) === 'now' ? 'just now' : `${age(iso)} ago`);

/** Who is reading: their login and Claude session, to mark what's theirs. */
export interface Viewer {
  me?: string;
  session?: string;
}

/** Who holds it, and how: "aaron · branch bt-014-x", "nick · claude session 3f2a9c01", "nick (you) · this session". */
export function holder(it: Item, v: Viewer = {}): string | null {
  const cl = it.claim;
  if (!cl) return null;
  const how =
    cl.kind === 'branch' && cl.ref ? ` · branch ${cl.ref}`
    : cl.kind === 'session' && v.session && cl.ref === v.session ? ' · this session'
    : cl.kind === 'session' ? ` · claude${cl.ref ? ` session ${cl.ref.slice(0, 8)}` : ''}`
    : '';
  return `${cl.user}${v.me && cl.user === v.me ? ' (you)' : ''}${how}`;
}

function blockedWhy(it: Item, items: ReadonlyMap<string, Item>): string | null {
  if (it.blocked) return it.blocked.reason;
  const deps = openDeps(it, items);
  return deps.length ? `waiting on ${deps.map(d => d.id).join(', ')}` : null;
}

function line(it: Item, items: ReadonlyMap<string, Item>, titleMax = 100): string {
  const parts = [c.dim(it.id.padEnd(8)), clip(it.title, titleMax)];
  const h = holder(it);
  if (h) parts.push(c.magenta(h));
  const why = blockedWhy(it, items);
  if (why) parts.push(c.red(`⊘ ${clip(why, 60)}`));
  if (it.tags.length) parts.push(c.dim(it.tags.map(t => `#${t}`).join(' ')));
  return parts.join('  ');
}

export interface ListOptions {
  status?: Status;
  mine?: string;
  all?: boolean;
}

export function formatList(snap: Snapshot, opts: ListOptions = {}): string {
  const items = new Map(snap.items.map(i => [i.id, i]));
  const statuses = opts.status ? [opts.status] : ORDER;
  const out: string[] = [c.bold(`${snap.board.owner}/${snap.board.repo}`) + c.dim(` (${snap.board.prefix})`)];
  for (const s of statuses) {
    let list = columnItems(snap.items, s);
    if (opts.mine) list = list.filter(i => i.claim?.user === opts.mine || i.created_by === opts.mine);
    let older = 0;
    if (s === 'done' && !opts.all && !opts.status) {
      const recent = list.filter(i => isRecentDone(i));
      older = list.length - recent.length;
      list = recent;
    }
    if (!list.length && !opts.status) continue;
    const head = s === 'done' ? c.green(GLYPH[s]) : s === 'in_progress' ? c.yellow(GLYPH[s]) : s === 'up_next' ? c.orange(GLYPH[s]) : c.dim(GLYPH[s]);
    out.push('', `${head} ${c.bold(STATUS_LABEL[s])} ${c.dim(String(list.length))}`);
    for (const it of list) out.push(`  ${line(it, items)}`);
    if (!list.length) out.push(c.dim('  (none)'));
    if (older) out.push(c.dim(`  … ${older} older (punch list --status done)`));
  }
  return out.join('\n');
}

/** The agent's view of the board (FR-18): counts, who holds what, what's next, what's stuck. No Done. */
export function formatCompact(snap: Snapshot, viewer: Viewer = {}): string {
  const items = new Map(snap.items.map(i => [i.id, i]));
  const col = (s: Status) => columnItems(snap.items, s);
  const inProgress = col('in_progress');
  const upNext = col('up_next');
  const backlog = col('backlog');
  const open = [...inProgress, ...upNext, ...backlog];
  const blocked = open.filter(i => blockedWhy(i, items));
  const doneRecent = col('done').filter(i => isRecentDone(i)).length;
  const t = (it: Item) => `${it.id} ${clip(it.title, 90)}`;
  const out = [
    `Punchlist ${snap.board.owner}/${snap.board.repo} — ${inProgress.length} in progress, ${upNext.length} up next, ${backlog.length} backlog, ${blocked.length} blocked, ${doneRecent} done in 14 days`,
  ];
  const section = (title: string, list: Item[], max: number, fmt: (i: Item) => string, more: string) => {
    if (!list.length) return;
    out.push(`${title}:`);
    for (const it of list.slice(0, max)) out.push(`- ${fmt(it)}`);
    if (list.length > max) out.push(`- … ${list.length - max} more (${more})`);
  };
  section('In progress', inProgress, 20, i => `${t(i)} [${holder(i, viewer) ?? 'unclaimed'}]`, 'punch list --status in_progress');
  section('Up next (top first)', upNext, 15, i => t(i) + (blockedWhy(i, items) ? ' [blocked]' : ''), 'punch list --status up_next');
  section('Blocked', blocked, 10, i => `${i.id}: ${clip(blockedWhy(i, items)!, 100)}`, 'punch list');
  section('Backlog (top first)', backlog, 10, t, 'punch list --status backlog');
  return out.join('\n');
}

export function formatShow(it: Item, items: ReadonlyMap<string, Item>, history: BoardEvent[]): string {
  const facts = [STATUS_LABEL[it.status], holder(it) ?? 'unclaimed'];
  if (it.tags.length) facts.push(it.tags.map(t => `#${t}`).join(' '));
  const why = blockedWhy(it, items);
  if (why) facts.push(c.red(`⊘ ${why}`));
  if (it.depends_on.length) facts.push(`depends on ${it.depends_on.join(', ')}`);
  if (it.aliases.length) facts.push(`also ${it.aliases.join(', ')}`);
  const out = [
    `${c.dim(it.id)}  ${c.bold(it.title)}`,
    facts.join(c.dim(' · ')),
    c.dim(`created by ${it.created_by} ${ago(it.created_at)} via ${it.source.kind}${it.closed_at ? ` · closed ${ago(it.closed_at)}` : ''}`),
  ];
  for (const ci of it.citations.filter(x => !x.reverted && (x.kind === 'closes' || it.status !== 'done'))) {
    const refs = [ci.commit ? shortSha(ci.commit) : null, ci.pr ? `PR #${ci.pr}` : null, ci.kind === 'pending' ? ci.branch : null].filter(Boolean).join(' ');
    out.push(c.dim(`${ci.kind === 'closes' ? 'closed by' : 'fix pending on'} ${refs}${ci.how === 'branch' ? ' (via branch)' : ci.how === 'inferred' ? ' (inferred)' : ''}`));
  }
  if (it.body.trim()) out.push('', it.body.trim());
  if (it.notes.length) {
    out.push('', c.bold('Notes'));
    for (const n of it.notes) out.push(`  ${c.dim(`${n.actor} · ${age(n.at)}`)}  ${n.text}${n.commit ? c.dim(` (${[shortSha(n.commit), n.pr ? `PR #${n.pr}` : ''].filter(Boolean).join(', ')})`) : ''}`);
  }
  if (history.length) {
    out.push('', c.bold('History'));
    for (const e of history.slice(0, 15)) {
      const who = e.actor.user ?? 'github';
      const via = e.actor.via === 'claude' ? ' (claude)' : e.actor.via === 'cli' ? ' (cli)' : '';
      out.push(`  ${c.dim(age(e.ts).padStart(4))}  ${e.meta?.text ?? e.op} ${c.dim(`· ${who}${via} · #${e.seq}`)}`);
    }
  }
  return out.join('\n');
}

export function formatMine(boards: MyWorkBoard[]): string {
  const out: string[] = [];
  for (const b of boards) {
    const items = new Map([...b.held, ...b.upNext, ...b.blockedOnMe].map(i => [i.id, i]));
    out.push(c.bold(`${b.board.owner}/${b.board.repo}`));
    const group = (title: string, list: Item[]) => {
      if (!list.length) return;
      out.push(`  ${c.dim(title)}`);
      for (const it of list) out.push(`    ${line(it, items, 80)}`);
    };
    group('In progress', b.held);
    group('Blocked on you', b.blockedOnMe);
    group('Up next', b.upNext);
    if (!b.held.length && !b.blockedOnMe.length && !b.upNext.length) out.push(c.dim('  nothing here'));
    out.push('');
  }
  return out.join('\n').trimEnd() || 'No boards.';
}
