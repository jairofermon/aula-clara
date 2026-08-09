// Secrets opcionais não aparecem no arquivo gerado pelo Wrangler. Eles são
// declarados separadamente para que `wrangler types` continue reproduzível.
interface CloudflareEnv {
  GROQ_API_KEY: string;
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY: string;
}

declare namespace Cloudflare {
  interface Env {
    GROQ_API_KEY: string;
    GEMINI_API_KEY: string;
    OPENROUTER_API_KEY: string;
  }
}
