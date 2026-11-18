import {
  POLICY_AREAS,
  POLICY_LEVELS,
  type PolicyLevel,
} from "core/tools/permissions/policy";

/** The panel's policy/save body: known areas and known levels only. */
export function policySavePayloadOk(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const levels = (data as { levels?: unknown }).levels;
  if (levels === undefined) return true;
  if (!levels || typeof levels !== "object" || Array.isArray(levels)) {
    return false;
  }
  for (const [area, level] of Object.entries(levels)) {
    if (!(POLICY_AREAS as readonly string[]).includes(area)) return false;
    if (!(POLICY_LEVELS as readonly string[]).includes(level as PolicyLevel)) {
      return false;
    }
  }
  return true;
}

const ALLOWED_OPEN_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Links the panel may ask the host to open. */
export function openUrlFromWebviewOk(data: unknown): data is string {
  if (typeof data !== "string" || !data.trim()) return false;
  try {
    const url = new URL(data.trim());
    if (url.protocol === "mailto:") return url.pathname.includes("@");
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export function runCommandFromWebviewOk(
  data: unknown,
): data is { command: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return typeof (data as { command?: unknown }).command === "string";
}

export function writeFileFromWebviewOk(
  data: unknown,
): data is { path: string; contents: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const body = data as { path?: unknown; contents?: unknown };
  return typeof body.path === "string" && typeof body.contents === "string";
}

export function subprocessFromWebviewOk(
  data: unknown,
): data is { command: string; cwd?: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const body = data as { command?: unknown; cwd?: unknown };
  if (typeof body.command !== "string" || body.command.trim() === "") {
    return false;
  }
  return body.cwd === undefined || typeof body.cwd === "string";
}

function fileUriPath(uri: string): string | undefined {
  const match = /^file:([^?#]*)/i.exec(uri.trim());
  if (!match) return undefined;
  let rest = match[1].replace(/\\/g, "/");
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    const slash = rest.indexOf("/");
    if (slash === -1) return undefined;
    const host = rest.slice(0, slash);
    if (host && host.toLowerCase() !== "localhost") return undefined;
    rest = rest.slice(slash);
  }
  if (!rest.startsWith("/")) rest = `/${rest}`;
  return rest;
}

function pathSegments(path: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "" || raw === ".") continue;
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    if (part.includes("/") || part.includes("\\") || part.includes("\0")) {
      return undefined;
    }
    out.push(part);
  }
  return out;
}

/** A filesystem path or file URI as a file URI, or undefined when it is not a local file. */
export function pathOrUriToFileUri(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed.toLowerCase().startsWith("file:") ? trimmed : undefined;
  }
  if (trimmed.startsWith("//")) return undefined;
  if (trimmed.startsWith("/")) return `file://${trimmed}`;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return `file:///${trimmed.replace(/\\/g, "/")}`;
  }
  return undefined;
}

function sameSegment(a: string, b: string): boolean {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * True when `target` (a file URI or absolute path) is the workspace root or
 * a path inside it. `..` is resolved before the check.
 */
export function isInsideWorkspace(
  target: string,
  workspaceDirs: readonly string[],
): boolean {
  const targetUri = pathOrUriToFileUri(target);
  if (!targetUri) return false;
  const targetPath = fileUriPath(targetUri);
  if (targetPath === undefined) return false;
  const targetSegments = pathSegments(targetPath);
  if (!targetSegments) return false;
  for (const dir of workspaceDirs) {
    const dirUri = pathOrUriToFileUri(dir);
    if (!dirUri) continue;
    const dirPath = fileUriPath(dirUri);
    if (dirPath === undefined) continue;
    const dirSegments = pathSegments(dirPath);
    if (!dirSegments || targetSegments.length < dirSegments.length) continue;
    const inside = dirSegments.every((segment, index) =>
      sameSegment(segment, targetSegments[index] ?? ""),
    );
    if (inside) return true;
  }
  return false;
}
