import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const handlerPath = resolve(
  process.cwd(),
  ".open-next/server-functions/default/apps/web/handler.mjs"
);
const dynamicMiddlewareManifest =
  "getMiddlewareManifest(){return this.minimalMode?null:require(this.middlewareManifestPath)}";
const outOfScopeMiddlewareManifest =
  "getMiddlewareManifest(){return this.minimalMode?null:evalManifest(this.middlewareManifestPath)}";
const embeddedMiddlewareManifest =
  "getMiddlewareManifest(){return this.minimalMode?null:(0,_loadmanifestexternal.loadManifest)(this.middlewareManifestPath)}";

const source = await readFile(handlerPath, "utf8");
const dynamicOccurrences = source.split(dynamicMiddlewareManifest).length - 1;
const outOfScopeOccurrences = source.split(outOfScopeMiddlewareManifest).length - 1;
const occurrences = dynamicOccurrences + outOfScopeOccurrences;

if (occurrences === 0 && source.includes(embeddedMiddlewareManifest)) {
  console.log("OpenNext: middleware manifest já está embutido.");
  process.exit(0);
}

if (occurrences !== 1) {
  throw new Error(
    `OpenNext: esperado 1 carregamento dinâmico do middleware manifest; encontrado ${occurrences}.`
  );
}

await writeFile(
  handlerPath,
  source
    .replace(dynamicMiddlewareManifest, embeddedMiddlewareManifest)
    .replace(outOfScopeMiddlewareManifest, embeddedMiddlewareManifest),
  "utf8"
);
console.log("OpenNext: middleware manifest convertido para carregamento embutido.");
