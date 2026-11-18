// Resolve hook for the RQ7 scan: the sources are TypeScript with `.js`
// specifiers (dialects) or extensionless ones (secretScan). Node strips the
// types itself; this hook only finds the .ts file. Dev only, read-only.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL
  ) {
    const p = fileURLToPath(new URL(specifier, context.parentURL));
    const candidates = [p.replace(/\.js$/, ".ts"), p + ".ts", p + "/index.ts"];
    for (const c of candidates) {
      if (c.endsWith(".ts") && existsSync(c)) {
        return nextResolve(pathToFileURL(c).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
