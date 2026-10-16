import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardRef } from './repo';

// `punch init` (FR-23): a short pointer in the repo's CLAUDE.md saying where the board is, so nobody
// (person or agent) keeps status in docs again. Never more than five lines, and only added once.

const MARK = '<!-- punchlist -->';

export function pointerLines(url: string, b: BoardRef): string[] {
  return [
    `## Punchlist ${MARK}`,
    `This repo's TODOs live on a shared board: ${url}/${b.owner}/${b.repo}`,
    'Read and change it with the `punch` CLI (or the Punchlist plugin): `punch list --compact`, `punch add`, `punch start`.',
    "Don't copy item status into this file or into docs; the board is the record.",
  ];
}

export interface InitPlan {
  path: string;
  exists: boolean;
  already: boolean;
  lines: string[];
}

export function planInit(root: string, url: string, b: BoardRef): InitPlan {
  const path = join(root, 'CLAUDE.md');
  const exists = existsSync(path);
  const already = exists && readFileSync(path, 'utf8').includes(MARK);
  return { path, exists, already, lines: pointerLines(url, b) };
}

export function applyInit(plan: InitPlan) {
  const current = plan.exists ? readFileSync(plan.path, 'utf8') : '';
  const sep = current === '' ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(plan.path, `${current}${sep}${plan.lines.join('\n')}\n`);
}
