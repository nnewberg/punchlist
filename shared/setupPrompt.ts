// The one prompt that sets Punchlist up (PL-020): pasted into Claude Code in a repo, it gets a fresh copy
// of the plugin's marketplace (which needs no Node.js) and hands over to that copy's `punch setup`, which
// installs or updates the plugin and does the rest. Refreshing first matters: a marketplace added
// earlier without auto-update stays at the commit it was added at, and an old plugin has no `setup`.
// The web board shows the prompt, and both READMEs carry it exactly (a CLI test checks), so the
// instructions can't drift from what works.

export const MARKETPLACE_REPO = 'nnewberg/punchlist';
export const SETUP_REFRESH = [`claude plugin marketplace add ${MARKETPLACE_REPO}`, 'claude plugin marketplace update punchlist'];

export function setupPrompt(): string {
  return [
    `Set up Punchlist for this repo. Run \`${SETUP_REFRESH[0]}\` (fine if it's already added), then \`${SETUP_REFRESH[1]}\`.`,
    'Then run `claude plugin marketplace list --json`, take the installLocation of the punchlist marketplace, and run `<installLocation>/plugins/punchlist/bin/punch setup`.',
    'Do the one next step it prints, then run it again, until it says "Setup complete". Ask me before committing anything.',
  ].join(' ');
}
