import { sessionUser } from './auth';
import { userByLogin, type User } from './directory';

// Who's asking. Normally the GitHub sign-in session (auth.ts). In DEV_MODE a tab can also pick a
// sample person with `?as=<login>` (sent as a header on fetch, a query param on the WebSocket), so two
// tabs can be two people; with neither, dev mode signs you in as nick.

export interface Identity {
  user: User;
  /** A renewed session cookie to send back, when the session was just extended. */
  setCookie?: string;
}

export async function resolveUser(request: Request, env: Env): Promise<Identity | null> {
  if (env.DEV_MODE !== '1') return sessionUser(request, env);
  const asked = request.headers.get('X-Punch-Dev-User') ?? new URL(request.url).searchParams.get('as');
  const stub = asked ? await userByLogin(env, asked) : null;
  if (stub) return { user: stub };
  const session = await sessionUser(request, env);
  if (session) return session;
  const nick = await userByLogin(env, 'nick');
  return nick ? { user: nick } : null;
}
