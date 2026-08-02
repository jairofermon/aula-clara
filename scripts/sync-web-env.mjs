import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve(".env");
const destination = resolve("apps/web/.env.local");
const allowed = new Set([
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SIGNED_URL_TTL_SECONDS",
  "MAX_UPLOAD_SIZE_MB"
]);
const selected = readFileSync(source, "utf8")
  .split(/\r?\n/u)
  .filter((line) => allowed.has(line.split("=", 1)[0] ?? ""));

writeFileSync(destination, `${selected.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`Configuração pública copiada para ${destination}; segredos foram excluídos.`);
