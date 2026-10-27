declare module "*.html" {
  const html: string;
  export default html;
}

interface Env {
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ANTHROPIC_API_KEY: string;
  INGEST_TOKEN: string;
  COOKIE_SECRET: string;
}
