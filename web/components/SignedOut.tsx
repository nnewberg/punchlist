import { Logo } from './ui';

// FR-3a: signed-out visitors see only this — no board names, counts or repos.
export function SignedOut() {
  return (
    <div className="app">
      <div className="signedout">
        <div className="mark">
          <Logo size="lg" />
          <div className="name">Punchlist</div>
        </div>
        {/* GitHub OAuth lands in the next pass; until then the dev identity stub is the only way in. */}
        <button className="gh-btn" title="GitHub sign-in is not wired up yet">
          <span style={{ width: 16, height: 16, borderRadius: '50%', background: 'var(--bg)', display: 'inline-block' }} />
          Sign in with GitHub
        </button>
      </div>
    </div>
  );
}
