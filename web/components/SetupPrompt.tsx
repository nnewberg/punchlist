import { useRef, useState } from 'react';
import { setupPrompt } from '../../shared/setupPrompt';

// The prompt that sets Punchlist up in a repo (PL-020), with a Copy button. Pasted into Claude Code,
// it installs the plugin and runs `punch setup`, which does the rest.
export function SetupPrompt({ lead }: { lead?: string }) {
  const [copied, setCopied] = useState<null | 'copied' | 'selected'>(null);
  const text = useRef<HTMLPreElement>(null);
  const prompt = setupPrompt();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // No clipboard access (an old browser, or not https): select it so ⌘C works.
      const el = text.current;
      if (!el) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      setCopied('selected');
      return;
    }
    setCopied('copied');
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="setup-prompt">
      <div className="setup-lead">{lead ?? 'Open the repo in Claude Code and paste this:'}</div>
      <pre ref={text}>{prompt}</pre>
      <div className="setup-row">
        <span className="setup-hint">It installs the plugin, signs you in and checks everything, then offers a PR so everyone who pulls gets it.</span>
        <button className="btn btn-accent" onClick={() => void copy()} aria-live="polite">{copied === 'copied' ? 'Copied' : copied === 'selected' ? (navigator.platform.startsWith('Mac') ? 'Press ⌘C' : 'Press Ctrl+C') : 'Copy'}</button>
      </div>
    </div>
  );
}
