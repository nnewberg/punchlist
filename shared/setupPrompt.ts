// The one prompt that sets Punchlist up (PL-020): pasted into Claude Code in a repo, it installs the
// plugin (which needs no Node.js) and hands over to `punch setup`, which does the rest and says what's
// next. The web board shows it, and both READMEs carry it exactly (a CLI test checks), so the
// instructions can't drift from what works.

export const SETUP_INSTALL = 'claude plugin install punchlist --marketplace nnewberg/punchlist --scope project';

export function setupPrompt(): string {
  return [
    `Set up Punchlist for this repo. Run \`${SETUP_INSTALL}\`.`,
    'Then run `claude plugin list --json`, take the installPath of the punchlist@punchlist entry for this repo, and run `<installPath>/bin/punch setup`.',
    'Do the one next step it prints, then run it again, until it says "Setup complete". Ask me before committing anything.',
  ].join(' ');
}
