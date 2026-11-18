/**
 * Which arguments of an MCP tool name a path, read from the tool's own JSON
 * schema (`inputSchema`, in core `function.parameters`). Deterministic
 * evidence only, from what the server declared:
 *
 * - `format: "uri"`, `"uri-reference"` or `"file-uri"` (a value that is a
 *   non-file URL is still not a path: deputyTargets drops it)
 * - a description that uses a conservative path vocabulary ("path to",
 *   "file path", "directory to", "folder of"...)
 * - the property's name, which deputyTargets already judges
 *
 * The schema is the server's claim, so it can only add arguments to judge,
 * never remove one: a server that describes its path as something else is
 * still covered by the name rule. The result is ask-only evidence.
 */
export type JsonSchema = Record<string, any>;

const PATH_FORMATS = new Set(["uri", "uri-reference", "file-uri", "iri"]);

const PATH_WORDS =
  /\b(?:(?:absolute|relative|full|local|file|directory|dir|folder)\s+paths?|paths?\s+(?:to|of|for|in)\b|(?:file|folder|directory)\s*name|(?:directory|folder|dir)\s+(?:to|of|containing|where)\b|file\s+(?:to|at)\b|filesystem\s+location|file:\/\/)/i;

/** Does this property's own schema say its string is a path or a file URI? */
export function schemaSaysPath(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== "object" || depth > 4) return false;
  const s = node as JsonSchema;
  if (typeof s.format === "string" && PATH_FORMATS.has(s.format)) return true;
  if (typeof s.description === "string" && PATH_WORDS.test(s.description)) {
    return true;
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (
      Array.isArray(s[key]) &&
      s[key].some((n: unknown) => schemaSaysPath(n, depth + 1))
    ) {
      return true;
    }
  }
  return false;
}

/** The sub-schema for `key` of an object value, and for the items of an array. */
export function propertySchema(
  parent: unknown,
  key: string,
): JsonSchema | undefined {
  const props = (parent as JsonSchema | undefined)?.properties;
  const node = props && typeof props === "object" ? props[key] : undefined;
  return node && typeof node === "object" ? node : undefined;
}

export function itemsSchema(node: unknown): JsonSchema | undefined {
  const items = (node as JsonSchema | undefined)?.items;
  return items && typeof items === "object" && !Array.isArray(items)
    ? items
    : undefined;
}

/**
 * Does the schema say the string at `key` (or the strings of an array there)
 * is a path? The array case looks at the array's own description and format
 * as well as the items'.
 */
export function keyIsPathBySchema(parent: unknown, key: string): boolean {
  const node = propertySchema(parent, key);
  if (!node) return false;
  return schemaSaysPath(node) || schemaSaysPath(itemsSchema(node));
}
