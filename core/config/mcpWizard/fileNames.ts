/*
  File names for one-server block files (`.continuous/mcpServers/<name>.yaml`),
  made from the server's name. `projectBlockFileName` is pure, so the dialog
  can show the path before anything is written. Nothing here reads a disk.
*/

/** Names Windows keeps for devices, with or without an extension. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const MAX_BASE = 64;

/** `GitHub Tools` -> `github-tools`: safe on Windows, macOS and Linux. */
export function blockFileBase(name: string): string {
  let slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_BASE)
    .replace(/[-.]+$/g, "");
  if (!slug) slug = "mcp-server";
  // `con.yaml` is still the console on Windows
  if (WINDOWS_RESERVED.test(slug.split(".")[0])) slug = `mcp-${slug}`;
  return slug;
}

/** `GitHub Tools` -> `github-tools.yaml`. */
export function projectBlockFileName(name: string): string {
  return `${blockFileBase(name)}.yaml`;
}

/**
 * The first of `<name>.yaml`, `<name>-2.yaml`, ... that `exists` does not
 * have, so another file is never overwritten.
 */
export function freeBlockFileName(
  dir: string,
  name: string,
  exists: (file: string) => boolean,
): string {
  const base = blockFileBase(name);
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const taken = (f: string) => exists(`${dir.replace(/[\/]+$/, "")}${sep}${f}`);
  if (!taken(`${base}.yaml`) && !taken(`${base}.yml`)) return `${base}.yaml`;
  for (let i = 2; ; i++) {
    if (!taken(`${base}-${i}.yaml`) && !taken(`${base}-${i}.yml`)) {
      return `${base}-${i}.yaml`;
    }
  }
}
