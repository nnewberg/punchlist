// Worker secrets, which `wrangler types` can't see. Optional: dev mode runs without GitHub.
interface GitHubSecrets {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}
interface Env extends GitHubSecrets {}
declare namespace Cloudflare {
  interface Env extends GitHubSecrets {}
}
