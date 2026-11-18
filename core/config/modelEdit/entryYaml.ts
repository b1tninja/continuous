/**
 * The model entry as YAML text for the dialog's Advanced (YAML) tab, and the
 * parse of what the person typed there. Webview-safe (no Node imports).
 *
 * The text shown is the entry's own lines from the file, so its comments and
 * key order are visible, with every plain credential replaced by the mask.
 * What is typed is never written as text: it is parsed, compared with the
 * entry (`opsFromEntryEdit`) and saved through the same patch, review and
 * writer as the other tabs, so the file keeps its own comments and layout.
 */
import * as YAML from "yaml";

import { MASK, SENSITIVE_KEY } from "./modelEditFields";

function isTemplate(value: string): boolean {
  return /^\$\{\{[^}]*\}\}$/.test(value.trim());
}

/** Replace plain credential values in a parsed document, keeping comments. */
function maskDocument(doc: YAML.Document): void {
  YAML.visit(doc, {
    Pair(_, pair) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : "";
      if (!SENSITIVE_KEY.test(key)) return;
      const v = pair.value;
      if (YAML.isScalar(v)) {
        if (
          typeof v.value === "string" &&
          v.value !== "" &&
          !isTemplate(v.value)
        ) {
          v.value = MASK;
          v.type = "PLAIN";
        }
        return;
      }
      if (YAML.isCollection(v)) {
        // A credential written as a map or list: hide every leaf under it
        YAML.visit(v, {
          Scalar(_k, s) {
            if (typeof s.value === "string" && !isTemplate(s.value)) {
              s.value = MASK;
              s.type = "PLAIN";
            }
          },
        });
      }
    },
  });
}

function dedent(text: string, column: number): string {
  const lines = text.split("\n");
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      const lead = /^ */.exec(line)![0].length;
      return line.slice(Math.min(lead, column));
    })
    .join("\n");
}

/**
 * The text of `models[index]` in `fileText`, de-indented, credentials masked
 * and comments kept. Falls back to the masked entry as plain YAML when the
 * source cannot be sliced out.
 */
export function entryYamlText(
  fileText: string,
  index: number,
  maskedEntry: Record<string, unknown>,
): string {
  try {
    const body = fileText.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    const doc = YAML.parseDocument(body);
    const node = doc.getIn(["models", index], true);
    if (YAML.isMap(node) && node.range) {
      const [start, , end] = node.range;
      const lineStart = body.lastIndexOf("\n", start - 1) + 1;
      const column = start - lineStart;
      const slice = dedent(body.slice(start, end), column).replace(/\s+$/, "");
      const own = YAML.parseDocument(slice);
      if (own.errors.length === 0 && YAML.isMap(own.contents)) {
        maskDocument(own);
        const text = own.toString({ flowCollectionPadding: false });
        // The slice must say what the entry says, or the tab would mislead
        if (sameJson(YAML.parse(text), maskedEntry)) return text;
      }
    }
  } catch {
    // fall through to the plain rendering
  }
  return YAML.stringify(maskedEntry);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export type ParsedEntry =
  { ok: true; entry: Record<string, unknown> } | { ok: false; error: string };

/** What the person typed in the Advanced tab, as an entry, or why it is not one. */
export function parseEntryYaml(text: string): ParsedEntry {
  const doc = YAML.parseDocument(text.replace(/\r\n/g, "\n"));
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const line = e.linePos?.[0]?.line;
    return {
      ok: false,
      error: line ? `Line ${line}: ${e.message.split("\n")[0]}` : e.message,
    };
  }
  const value: unknown = doc.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "The entry is a map of settings (name: ..., model: ...).",
    };
  }
  return { ok: true, entry: value as Record<string, unknown> };
}
