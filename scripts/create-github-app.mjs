#!/usr/bin/env node
// Creates Punchlist's GitHub App in one click, using GitHub's manifest flow.
//
//   node scripts/create-github-app.mjs https://punchlist.<subdomain>.workers.dev [--name "Punchlist"]
//
// Opens a local page that posts the App's manifest to GitHub. After you click "Create GitHub App",
// GitHub sends you back here with a one-time code, which this script trades for the App's
// credentials. It then:
//   - adds them to .dev.vars (for real sign-in in local dev),
//   - writes .github-app.secrets.json for `wrangler secret bulk` (gitignored; delete it after),
//   - sets GITHUB_APP_SLUG in wrangler.jsonc to the App's actual URL name.
// The App is owned by your personal account and set to installable by any account, so it can be
// installed on both nnewberg and futureleisurefoundation; the Worker's ALLOWED_OWNERS ignores
// installs anywhere else.

import { createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';

const PORT = 5174;
const args = process.argv.slice(2);
const base = args.find(a => a.startsWith('https://'))?.replace(/\/+$/, '');
const nameAt = args.indexOf('--name');
const name = nameAt >= 0 ? args[nameAt + 1] : 'Punchlist';
if (!base) {
  console.error('Usage: node scripts/create-github-app.mjs https://punchlist.<subdomain>.workers.dev [--name "Punchlist"]');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const manifest = {
  name,
  url: base,
  description: 'A live, shared TODO board for each repo.',
  public: true,
  redirect_url: `http://localhost:${PORT}/created`,
  callback_urls: [`${base}/auth/callback`, 'http://localhost:5173/auth/callback'],
  setup_url: `${base}/github/setup`,
  setup_on_update: true,
  hook_attributes: { url: `${base}/github/webhook`, active: true },
  // PRD §8: the minimum. Contents and pull requests are for auto-close (M4); asking now avoids a
  // second approval round later.
  default_permissions: { metadata: 'read', contents: 'read', pull_requests: 'read' },
  default_events: ['repository'],
};

const escape = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = body => `<!doctype html><meta charset="utf-8"><title>Create the Punchlist GitHub App</title>
<body style="background:#1b1917;color:#f0e9df;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px;text-align:center">${body}</div>`;

function setVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(`
      <h2>Create the ${escape(name)} GitHub App</h2>
      <p>GitHub will show the App's settings and ask you to confirm. It's created on your personal account.</p>
      <form action="https://github.com/settings/apps/new?state=${state}" method="post">
        <input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
        <button style="font:inherit;padding:10px 18px;border-radius:999px;border:0;background:#f0e9df;color:#1b1917;cursor:pointer">Continue to GitHub</button>
      </form>`));
    return;
  }
  if (url.pathname === '/created') {
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end('State mismatch; start again.');
      return;
    }
    const r = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get('code')}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'punchlist-setup' },
    });
    if (!r.ok) {
      res.writeHead(502).end(`GitHub refused the code (${r.status}). Start again.`);
      console.error(await r.text());
      return;
    }
    const app = await r.json();
    // GitHub hands out PKCS#1; the Worker's WebCrypto wants PKCS#8.
    const pkcs8 = createPrivateKey(app.pem).export({ type: 'pkcs8', format: 'pem' }).toString();
    const secrets = {
      GITHUB_APP_ID: String(app.id),
      GITHUB_APP_PRIVATE_KEY: pkcs8,
      GITHUB_CLIENT_ID: app.client_id,
      GITHUB_CLIENT_SECRET: app.client_secret,
      GITHUB_WEBHOOK_SECRET: app.webhook_secret,
    };

    let devVars = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8') : 'DEV_MODE=1\n';
    for (const [k, v] of Object.entries(secrets)) devVars = setVar(devVars, k, JSON.stringify(v));
    writeFileSync('.dev.vars', devVars);
    writeFileSync('.github-app.secrets.json', JSON.stringify(secrets, null, 2), { mode: 0o600 });
    const cfg = readFileSync('wrangler.jsonc', 'utf8').replace(/"GITHUB_APP_SLUG": "[^"]*"/, `"GITHUB_APP_SLUG": "${app.slug}"`);
    writeFileSync('wrangler.jsonc', cfg);

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(`<h2>Created ${escape(app.name)}</h2><p>Back in the terminal for the next steps. You can close this tab.</p>`));
    console.log(`
Created ${app.name} (${app.html_url})

Saved:
  .dev.vars                  GitHub settings for local dev
  .github-app.secrets.json   for the deployed Worker (delete it once uploaded)
  wrangler.jsonc             GITHUB_APP_SLUG = ${app.slug}

Next:
  1. Upload the secrets:   npx wrangler secret bulk .github-app.secrets.json && rm .github-app.secrets.json
  2. Install the App:      ${app.html_url}/installations/new
     - on nnewberg: bulletin-bee and punchlist
     - on futureleisurefoundation: big-talk
`);
    server.close();
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Opening ${url} …`);
  exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} ${url}`);
});
