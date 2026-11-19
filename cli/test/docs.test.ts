import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETUP_REFRESH, setupPrompt } from '../../shared/setupPrompt';
import { REFRESH_ARGS } from '../setup';

// The setup prompt in the READMEs is the one the code builds (PL-020), so the instructions people copy
// can't drift from what works.

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('the setup prompt', () => {
  it.each(['README.md', 'plugins/punchlist/README.md'])('appears exactly in %s', path => {
    expect(read(path)).toContain(setupPrompt());
  });

  it('refreshes the marketplace the same way punch setup does', () => {
    expect(SETUP_REFRESH[1]).toBe(['claude', ...REFRESH_ARGS].join(' '));
  });
});
