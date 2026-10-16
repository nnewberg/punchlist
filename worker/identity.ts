import { PEOPLE } from '../shared/config';

// DEV STUB — stands in for GitHub sign-in (FR-3/3a) until it lands. Each browser tab picks who it is
// with `?as=<user>`, sent as a header (fetch) or query param (WebSocket), so two tabs can be two people.
// Outside DEV_MODE nobody is signed in, so the API returns 401 and the board is never exposed.

export function resolveUser(request: Request, env: Env): string | null {
  if (env.DEV_MODE !== '1') return null;
  const url = new URL(request.url);
  const asked = request.headers.get('X-Punch-Dev-User') ?? url.searchParams.get('as');
  return asked && PEOPLE[asked] ? asked : 'nick';
}
