// Small helpers for the secrets the Worker hands out: session cookies and API tokens.

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 32 random bytes, URL-safe. */
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
