import { execFileSync } from 'node:child_process';

// Which board a command is about (FR-5): the GitHub repo in `origin`, unless --board says otherwise.

export interface BoardRef {
  owner: string;
  repo: string;
}

/** `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@github.com/o/r.git` → {o, r}. */
export function parseRemote(remote: string): BoardRef | null {
  const m = /^(?:[\w.+-]+@github\.com:|(?:ssh|https?|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function parseBoardArg(arg: string): BoardRef | null {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(arg.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : parseRemote(arg);
}

function git(args: string[], cwd?: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export const repoRoot = (cwd?: string) => git(['rev-parse', '--show-toplevel'], cwd);

export function boardFromCwd(cwd?: string): BoardRef | null {
  const remote = git(['remote', 'get-url', 'origin'], cwd);
  return remote ? parseRemote(remote) : null;
}
