import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { resolveId, STATUS_LABEL } from '../shared/ops';
import { checkImport } from '../shared/import';
import type { BoardEvent, Column, ImportFile, Me, MyWorkBoard, Op } from '../shared/types';
import { ApiError, boardPath, Client, flush, NetworkError, readBoard, write, type ApplyResult, type FlushReport } from './api';
import { baseUrl, configDir, DEFAULT_URL, deleteToken, getToken, loadConfig, machine, readJson, saveConfig, setToken, writeJson } from './config';
import { c, formatCompact, formatImportPlan, formatList, formatMine, formatShow } from './format';
import { applyInit, planInit, pluginSettings } from './init';
import { readHookInput, runHook } from './hooks';
import { searchItems } from './search';
import { parseStatus, UsageError } from './args';
import { boardFromCwd, parseBoardArg, repoRoot, type BoardRef } from './repo';

declare const __PUNCH_VERSION__: string | undefined;
const VERSION = typeof __PUNCH_VERSION__ !== 'undefined' ? __PUNCH_VERSION__ : 'dev';

const USAGE = `punch: the shared TODO board for this repo

Usage: punch <command> [args] [--json] [--board owner/repo]

  list [--compact] [--status s] [--mine] [--all]   the board (--compact: the agent view)
  show ID                       one item, with notes and history
  add "title" [-b body] [-s status] [-t tag]... [--deferred]   add an item (default: Backlog)
  search "words"                the closest items, Done ones from the last 30 days too
  move ID status [--top | --before ID]             move it (backlog, next, progress, done)
  start ID [--steal]            claim it and move it to In Progress
  release ID                    give it back
  block ID reason / unblock ID
  close ID [-m note]            mark it Done
  reopen ID
  note ID text                  add a note
  drop ID                       delete it (it stays searchable and can be restored)
  mine                          what's yours across every board
  open [ID]                     open the board in the browser
  export [-o file]              the board as JSON
  import FILE [--yes]           add items from an import file, after a dry run (PRD §7.9)
  login [--start | --finish]    sign in with GitHub (--start/--finish: in two steps, for Claude)
  logout / whoami
  init                          point this repo's CLAUDE.md at the board
  hook EVENT                    run by the Claude Code plugin: session-start, heartbeat, session-end

IDs can be typed loosely: bt-30, BT-030 and BT030 are the same item.
Set PUNCH_SESSION (or --session) when an agent runs punch, so changes record the session.
--deferred marks an item as work Claude left for later.`;

const { values: o, positionals } = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        board: { type: 'string' },
        url: { type: 'string' },
        session: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        body: { type: 'string', short: 'b' },
        status: { type: 'string', short: 's' },
        tag: { type: 'string', short: 't', multiple: true },
        top: { type: 'boolean' },
        before: { type: 'string' },
        steal: { type: 'boolean' },
        message: { type: 'string', short: 'm' },
        mine: { type: 'boolean' },
        all: { type: 'boolean' },
        compact: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        out: { type: 'string', short: 'o' },
        dev: { type: 'string' },
        deferred: { type: 'boolean' },
        start: { type: 'boolean' },
        finish: { type: 'boolean' },
      },
    });
  } catch (e) {
    console.error(c.red((e as Error).message));
    console.error(c.dim('Run `punch --help` for usage.'));
    process.exit(2);
  }
})();

const [cmd, ...args] = positionals;
const url = baseUrl(o.url);
const session = o.session ?? process.env.PUNCH_SESSION ?? undefined;

const print = (s: string) => process.stdout.write(`${s}\n`);
const info = (s: string) => process.stderr.write(`${s}\n`);
const printJson = (data: unknown) => print(JSON.stringify(data, null, 2));

function need(value: string | undefined, what: string): string {
  if (!value?.trim()) throw new UsageError(`Missing ${what}. Run \`punch --help\`.`);
  return value.trim();
}

function board(): BoardRef {
  if (o.board) {
    const b = parseBoardArg(o.board);
    if (!b) throw new UsageError(`--board should look like owner/repo, not "${o.board}"`);
    return b;
  }
  const b = boardFromCwd();
  if (!b) throw new UsageError('This isn’t a git repo with a GitHub origin. Run punch inside one, or pass --board owner/repo.');
  return b;
}

async function client(): Promise<Client> {
  return new Client({ url, token: await getToken(url), session });
}

function openBrowser(target: string) {
  const [bin, ...rest] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
  try {
    spawn(bin!, [...rest, target], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // printing the URL is enough
  }
}

function reportFlush(r: FlushReport | null) {
  if (!r) return;
  for (const s of r.sent) {
    const created = s.ops[0]?.op === 'create' && s.results[0]?.ok ? s.results[0].item.id : null;
    info(c.dim(`Sent queued: ${s.label}${created ? ` → ${created}` : ''}`));
  }
  for (const f of r.refused) info(c.red(`Queued change refused: ${f.label}: ${f.message}`));
  if (r.remaining) info(c.yellow(`Still offline: ${r.remaining} change${r.remaining === 1 ? '' : 's'} queued.`));
}

// ---- Commands that change the board ----

async function change(label: string, ops: Op[], done: (results: ApplyResult[]) => string) {
  const b = board();
  const api = await client();
  reportFlush(await flush(api, b));
  const out = await write(api, b, label, ops);
  if (!out.sent) {
    if (o.json) printJson({ queued: true, label });
    else print(`${c.yellow('Offline, so it’s queued:')} ${label}. It goes out with your next punch command.`);
    return;
  }
  if (o.json) printJson(out.results.length === 1 ? out.results[0] : out.results);
  else print(done(out.results));
}

const lastItem = (results: ApplyResult[]) => {
  const r = results[results.length - 1];
  if (!r?.ok) throw new Error('No result');
  return r.item;
};
const said = (verb: string) => (results: ApplyResult[]) => {
  const it = lastItem(results);
  const noop = results.every(r => r.ok && 'noop' in r);
  return noop ? c.dim(`${it.id} was already ${STATUS_LABEL[it.status]}: nothing changed.`) : `${verb} ${c.bold(it.id)} ${it.title} ${c.dim(`(${STATUS_LABEL[it.status]})`)}`;
};

// ---- Signing in (FR-3, FR-25a) ----

/**
 * A GitHub device-flow sign-in waiting for its code to be entered. Kept on disk so that Claude can
 * start one, show the person the code, and finish it in a second command.
 */
interface PendingLogin {
  url: string;
  handle: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_at: number;
}

const pendingFile = () => join(configDir(), 'login-pending.json');

async function startLogin(): Promise<PendingLogin> {
  const start = await new Client({ url, token: null }).request<{ user_code: string; verification_uri: string; handle: string; interval: number; expires_in: number }>('POST', '/auth/device/start');
  const pending: PendingLogin = { url, handle: start.handle, user_code: start.user_code, verification_uri: start.verification_uri, interval: start.interval, expires_at: Date.now() + start.expires_in * 1000 };
  writeJson(pendingFile(), pending, 0o600);
  openBrowser(start.verification_uri);
  return pending;
}

async function finishLogin(pending: PendingLogin | null): Promise<string> {
  if (!pending || pending.url !== url) throw new UsageError('No sign-in in progress. Run `punch login --start` first.');
  const anon = new Client({ url, token: null });
  let interval = pending.interval;
  for (;;) {
    if (Date.now() > pending.expires_at) {
      rmSync(pendingFile(), { force: true });
      throw new Error('The code expired. Run `punch login` again.');
    }
    await new Promise(r => setTimeout(r, interval * 1000));
    try {
      const r = await anon.request<{ status: string; token?: string; user?: string; interval?: number }>('POST', '/auth/device/poll', { handle: pending.handle, machine: machine() });
      if (r.status === 'ok' && r.token && r.user) {
        rmSync(pendingFile(), { force: true });
        return signedIn(r.token, r.user);
      }
      if (r.interval) interval = r.interval;
    } catch (e) {
      if (e instanceof ApiError) throw new Error((e.data as { message?: string } | null)?.message ?? e.message);
      throw e;
    }
  }
}

async function signedIn(token: string, user: string): Promise<string> {
  const where = await setToken(url, token);
  saveConfig({ ...loadConfig(), ...(url !== DEFAULT_URL || loadConfig().url ? { url } : {}), user, machine: machine() });
  return `Signed in as ${c.bold(user)}${url === DEFAULT_URL ? '' : ` on ${url}`}. ${c.dim(where === 'keychain' ? 'Token saved in your keychain.' : `No keychain here, so the token is in a private file in ${configDir()}.`)}`;
}

// ---- Commands ----

async function run() {
  if (o.version) return print(VERSION);
  if (!cmd || o.help || cmd === 'help') return print(USAGE);

  switch (cmd) {
    case 'login': {
      if (o.dev) {
        const anon = new Client({ url, token: null });
        const { token, user } = await anon.request<{ token: string; user: string }>('POST', '/auth/dev-token', { as: o.dev, machine: machine() });
        return print(await signedIn(token, user));
      }
      if (o.finish) return print(await finishLogin(readJson<PendingLogin>(pendingFile())));
      const pending = await startLogin();
      if (o.start) {
        if (o.json) return printJson({ user_code: pending.user_code, verification_uri: pending.verification_uri, expires_at: pending.expires_at });
        return print(`Enter ${c.bold(pending.user_code)} at ${pending.verification_uri} (opened in your browser), then run \`punch login --finish\`.`);
      }
      print(`To sign in, enter this code on GitHub: ${c.bold(pending.user_code)}`);
      print(`  ${pending.verification_uri}`);
      return print(await finishLogin(pending));
    }

    case 'logout': {
      const token = await getToken(url);
      if (token) await new Client({ url, token }).request('DELETE', '/v1/me/tokens/current').catch(() => {});
      await deleteToken(url);
      return print('Signed out on this machine.');
    }

    case 'whoami': {
      const me = await (await client()).request<Me>('GET', '/v1/me');
      if (o.json) return printJson(me);
      print(`${c.bold(me.user)} on ${url}`);
      for (const b of me.boards) print(`  ${b.owner}/${b.repo} ${c.dim(`(${b.prefix}) ${b.role === 'view' ? 'view only' : ''}`)}`);
      return;
    }

    case 'list':
    case 'ls': {
      const b = board();
      const api = await client();
      reportFlush(await flush(api, b));
      const { snapshot, offlineSince } = await readBoard(api, b);
      if (offlineSince) info(c.yellow(`Offline: showing the board as of ${new Date(offlineSince).toLocaleString()}.`));
      if (o.json) return printJson(snapshot);
      if (o.compact) return print(formatCompact(snapshot, { me: loadConfig().user, session }));
      return print(formatList(snapshot, { ...(o.status ? { status: parseStatus(o.status) } : {}), ...(o.mine ? { mine: loadConfig().user } : {}), all: !!o.all }));
    }

    case 'show': {
      const b = board();
      const api = await client();
      const { snapshot, offlineSince } = await readBoard(api, b);
      const items = new Map(snapshot.items.map(i => [i.id, i]));
      const ref = need(args[0], 'an item ID');
      const it = resolveId(items, ref);
      if (!it) throw new Error(`No item ${ref} on ${b.owner}/${b.repo}.`);
      let history: BoardEvent[] = [];
      if (!offlineSince) history = (await api.request<{ events: BoardEvent[] }>('GET', `${boardPath(b)}/items/${encodeURIComponent(it.id)}/history`, undefined, b)).events;
      if (o.json) return printJson({ item: it, history });
      return print(formatShow(it, items, history));
    }

    case 'add': {
      const title = need(args.join(' '), 'a title');
      const status = o.status ? parseStatus(o.status) : 'backlog';
      if (status === 'dropped') throw new UsageError('New items can’t start deleted.');
      const op: Op = { op: 'create', title, status: status as Column, ...(o.body ? { body: o.body } : {}), ...(o.tag?.length ? { tags: o.tag } : {}), ...(o.deferred ? { source: 'claude-deferred' as const } : {}) };
      return change(`add "${title}"`, [op], said('Added'));
    }

    case 'search':
    case 'find': {
      const query = need(args.join(' '), 'some words to look for');
      const { snapshot, offlineSince } = await readBoard(await client(), board());
      if (offlineSince) info(c.yellow(`Offline: searching the board as of ${new Date(offlineSince).toLocaleString()}.`));
      const found = searchItems(snapshot.items, query);
      if (o.json) return printJson({ matches: found.map(m => ({ score: m.score, item: m.item })) });
      if (!found.length) return print(c.dim(`Nothing on the board matches "${query}".`));
      return print(found.map(m => `${c.dim(m.item.id.padEnd(8))} ${m.item.title}  ${c.dim(`${STATUS_LABEL[m.item.status]} · ${Math.round(m.score * 100)}% of the words`)}`).join('\n'));
    }

    case 'move': {
      const id = need(args[0], 'an item ID');
      const status = parseStatus(need(args[1], 'a status'));
      return change(`move ${id} to ${STATUS_LABEL[status]}`, [{ op: 'move', id, status, ...(o.top ? { beforeId: 'top' } : o.before ? { beforeId: o.before } : {}) }], said('Moved'));
    }

    case 'start':
    case 'claim': {
      const id = need(args[0], 'an item ID');
      return change(`start ${id}`, [{ op: 'claim', id, ...(o.steal ? { steal: true } : {}) }], said('Started'));
    }

    case 'release': {
      const id = need(args[0], 'an item ID');
      return change(`release ${id}`, [{ op: 'release', id }], said('Released'));
    }

    case 'block': {
      const id = need(args[0], 'an item ID');
      const reason = need(args.slice(1).join(' '), 'a reason');
      return change(`block ${id}`, [{ op: 'block', id, reason }], said('Blocked'));
    }

    case 'unblock': {
      const id = need(args[0], 'an item ID');
      return change(`unblock ${id}`, [{ op: 'unblock', id }], said('Unblocked'));
    }

    case 'close':
    case 'done': {
      const id = need(args[0], 'an item ID');
      const text = o.message ?? (args.length > 1 ? args.slice(1).join(' ') : undefined);
      const ops: Op[] = [...(text ? [{ op: 'note' as const, id, text }] : []), { op: 'move', id, status: 'done' }];
      return change(`close ${id}`, ops, said('Closed'));
    }

    case 'reopen': {
      const id = need(args[0], 'an item ID');
      return change(`reopen ${id}`, [{ op: 'reopen', id }], said('Reopened'));
    }

    case 'note': {
      const id = need(args[0], 'an item ID');
      const text = need(args.slice(1).join(' ') || o.message, 'the note text');
      return change(`note on ${id}`, [{ op: 'note', id, text }], r => `Noted on ${c.bold(lastItem(r).id)} ${lastItem(r).title}`);
    }

    case 'drop':
    case 'delete': {
      const id = need(args[0], 'an item ID');
      return change(`drop ${id}`, [{ op: 'drop', id }], r => `Deleted ${c.bold(lastItem(r).id)} ${lastItem(r).title} ${c.dim('(still searchable; `punch reopen` brings it back)')}`);
    }

    case 'mine': {
      const r = await (await client()).request<{ boards: MyWorkBoard[] }>('GET', '/v1/me/work');
      return o.json ? printJson(r) : print(formatMine(r.boards));
    }

    case 'open': {
      let target = url;
      try {
        const b = board();
        target = `${url}/${b.owner}/${b.repo}${args[0] ? `?open=${encodeURIComponent(args[0].toUpperCase())}` : ''}`;
      } catch (e) {
        if (!(e instanceof UsageError) || args[0]) throw e;
      }
      openBrowser(target);
      return print(target);
    }

    case 'export': {
      const b = board();
      const { snapshot, offlineSince } = await readBoard(await client(), b);
      if (offlineSince) info(c.yellow(`Offline: exporting the cached board from ${new Date(offlineSince).toLocaleString()}.`));
      const data = JSON.stringify({ exported_at: new Date().toISOString(), board: snapshot.board, items: snapshot.items }, null, 2);
      if (o.out) {
        writeFileSync(o.out, `${data}\n`);
        return print(`Wrote ${snapshot.items.length} items to ${o.out}`);
      }
      return print(data);
    }

    case 'import': {
      const path = need(args[0], 'an import file');
      let file: ImportFile;
      try {
        file = JSON.parse(readFileSync(path, 'utf8')) as ImportFile;
      } catch (e) {
        throw new UsageError(`Can't read ${path} as JSON: ${(e as Error).message}`);
      }
      const b = o.board ? board() : file.board ? (parseBoardArg(file.board) ?? board()) : board();
      const api = await client();
      const { snapshot, offlineSince } = await readBoard(api, b);
      if (offlineSince) throw new Error('Importing needs the server, and it can’t be reached.');
      const plan = checkImport(snapshot.board.prefix, new Map(snapshot.items.map(i => [i.id, i])), file.items);
      const name = `${b.owner}/${b.repo}`;
      if (o.json && !o.yes) return printJson({ board: name, items: file.items.map((it, i) => ({ id: plan.ids[i], title: it.title, status: it.status, why: it.why })), errors: plan.errors });
      if (!o.json) print(formatImportPlan(file.items, plan.ids, name));
      if (plan.errors.length) throw new Error(`Can't import:\n${plan.errors.map(e => `  - ${e}`).join('\n')}`);
      if (!o.yes) {
        if (!process.stdin.isTTY) throw new UsageError('That was the dry run. Pass --yes to import.');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`\nImport these ${file.items.length} items into ${name}? [y/N] `);
        rl.close();
        if (!/^y/i.test(answer.trim())) return print('Imported nothing.');
      }
      const out = await api.request<{ ok: true; ids: string[] }>('POST', `${boardPath(b)}/import`, { board: name, items: file.items }, b);
      if (o.json) return printJson(out);
      return print(`Imported ${out.ids.length} items into ${name}.`);
    }

    case 'init': {
      const b = board();
      const api = await client();
      await api.request('GET', boardPath(b), undefined, b); // the board exists and you can see it
      const root = repoRoot();
      if (!root) throw new UsageError('Run punch init inside the repo.');
      const plan = planInit(root, url, b);
      if (plan.already) return print(`${plan.path} already points at the board.`);
      print(`This adds ${plan.lines.length} lines to ${plan.exists ? '' : 'a new '}${plan.path}:\n`);
      print(plan.lines.map(l => c.dim(`  ${l}`)).join('\n'));
      if (!o.yes) {
        if (!process.stdin.isTTY) throw new UsageError('Pass --yes to add them without asking.');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('\nAdd them? [y/N] ');
        rl.close();
        if (!/^y/i.test(answer.trim())) return print('Left CLAUDE.md alone.');
      }
      applyInit(plan);
      print(`Added the board pointer to ${plan.path}. Commit it when you're ready.`);
      return print(`\nTo offer teammates the Claude Code plugin when they open this repo, commit this to .claude/settings.json:\n${c.dim(pluginSettings())}`);
    }

    case 'hook': {
      const event = need(args[0], 'a hook event');
      const out = await runHook(event, await readHookInput(), {
        url,
        envFile: process.env.CLAUDE_ENV_FILE,
        pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
        pluginData: process.env.CLAUDE_PLUGIN_DATA,
      });
      if (out) print(out);
      return;
    }

    default:
      throw new UsageError(`Unknown command "${cmd}". Run \`punch --help\`.`);
  }
}

run().then(
  () => process.exit(0),
  e => {
    if (o.json && !(e instanceof UsageError)) printJson({ ok: false, error: e instanceof ApiError ? (e.opError ?? { message: e.message }) : { message: (e as Error).message } });
    else info(c.red(`${(e as Error).message}${e instanceof NetworkError ? '.' : ''}`));
    process.exit(e instanceof UsageError ? 2 : 1);
  },
);
