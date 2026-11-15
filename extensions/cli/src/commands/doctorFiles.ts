/**
 * File checks for `continuous doctor config`: does each settings file parse,
 * and if not, where. Every message here is built from the parser's position
 * and the key path, never from the file's text: a config file holds keys and
 * tokens, and a diagnostic that quotes the broken line prints them.
 */

import * as fs from "node:fs";

import { configYamlSchema } from "@continuedev/config-yaml";
import { POLICY_FILE_KEYS } from "core/tools/permissions/settingsFile.js";
import * as YAML from "yaml";

import { HOOK_EVENT_NAMES } from "../hooks/types.js";
import { parseToolPattern } from "../permissions/permissionsYamlLoader.js";

export interface FileProblem {
  /** What is wrong, without any text from the file. */
  message: string;
  /** 1-based, when the parser gave a position. */
  line?: number;
  column?: number;
  /** The key path the problem is at, such as `models.0.provider`. */
  key?: string;
}

export type FileState = "ok" | "absent" | "broken";

export interface FileCheck<T = unknown> {
  state: FileState;
  errors: FileProblem[];
  warnings: FileProblem[];
  /** The parsed value when the file parsed, even if the schema then failed. */
  value?: T;
}

function absent<T>(): FileCheck<T> {
  return { state: "absent", errors: [], warnings: [] };
}

function readText(file: string): string | undefined | { error: FileProblem } {
  try {
    if (!fs.existsSync(file)) return undefined;
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      error: { message: `could not be read${code ? ` (${code})` : ""}` },
    };
  }
}

function positionOf(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * The offset and kind of the first JSON syntax error, or undefined when the
 * text is valid. `JSON.parse` names the position on some runtimes only, and
 * quotes the text around it on others, so the position comes from here.
 */
export function findJsonError(
  text: string,
): { offset: number; message: string } | undefined {
  let i = 0;
  const fail = (message: string, at = i) => ({ offset: at, message });
  const skip = () => {
    while (i < text.length && " \t\r\n".includes(text[i])) i++;
  };
  const string = (): ReturnType<typeof fail> | undefined => {
    const start = i;
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return undefined;
      }
      if (c === "\n") return fail("a string is not closed", start);
      if (c === "\\") i++;
      i++;
    }
    return fail("a string is not closed", start);
  };
  const value = (): ReturnType<typeof fail> | undefined => {
    skip();
    if (i >= text.length) return fail("a value is missing");
    const c = text[i];
    if (c === "{") {
      i++;
      skip();
      if (text[i] === "}") {
        i++;
        return undefined;
      }
      for (;;) {
        skip();
        if (text[i] !== '"') return fail("expected a property name in quotes");
        const s = string();
        if (s) return s;
        skip();
        if (text[i] !== ":") return fail("expected ':' after a property name");
        i++;
        const v = value();
        if (v) return v;
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return undefined;
        }
        return fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      skip();
      if (text[i] === "]") {
        i++;
        return undefined;
      }
      for (;;) {
        const v = value();
        if (v) return v;
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return undefined;
        }
        return fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    const rest = text.slice(i);
    const literal =
      /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (!literal) return fail("expected a value");
    i += literal[0].length;
    return undefined;
  };
  const first = value();
  if (first) return first;
  skip();
  return i < text.length ? fail("unexpected text after the value") : undefined;
}

export function checkJsonFile(file: string): FileCheck {
  const text = readText(file);
  if (text === undefined) return absent();
  if (typeof text !== "string") {
    return { state: "broken", errors: [text.error], warnings: [] };
  }
  try {
    return { state: "ok", errors: [], warnings: [], value: JSON.parse(text) };
  } catch {
    const found = findJsonError(text);
    const problem: FileProblem = found
      ? {
          message: `not valid JSON: ${found.message}`,
          ...positionOf(text, found.offset),
        }
      : { message: "not valid JSON" };
    return { state: "broken", errors: [problem], warnings: [] };
  }
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/**
 * The first line of a YAML parser message, without its position suffix. The
 * lines after it are a frame quoted from the file and are dropped.
 */
function yamlSentence(message: string): string {
  const first = String(message ?? "").split(/\r?\n/)[0] ?? "";
  return (
    first.replace(/\s+at line \d+, column \d+:?\s*$/, "").trim() ||
    "not valid YAML"
  );
}

interface YamlRead {
  check: FileCheck;
  doc?: YAML.Document.Parsed;
  lines?: YAML.LineCounter;
}

function readYamlFile(file: string): YamlRead {
  const text = readText(file);
  if (text === undefined) return { check: absent() };
  if (typeof text !== "string") {
    return { check: { state: "broken", errors: [text.error], warnings: [] } };
  }
  const lines = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter: lines });
  if (doc.errors.length > 0) {
    return {
      check: {
        state: "broken",
        errors: doc.errors.map((e) => ({
          message: `not valid YAML: ${yamlSentence(e.message)}`,
          ...(e.linePos?.[0]
            ? { line: e.linePos[0].line, column: e.linePos[0].col }
            : {}),
        })),
        warnings: [],
      },
    };
  }
  return {
    check: { state: "ok", errors: [], warnings: [], value: doc.toJS() },
    doc,
    lines,
  };
}

/** Where a key path is in the document, for a schema problem. */
function locate(
  read: YamlRead,
  keyPath: readonly PropertyKey[],
): { line?: number; column?: number } {
  if (!read.doc || !read.lines) return {};
  for (let depth = keyPath.length; depth >= 0; depth--) {
    const node = read.doc.getIn(keyPath.slice(0, depth), true) as
      { range?: [number, number, number] } | undefined;
    if (node?.range) {
      const pos = read.lines.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return {};
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A schema issue as a sentence made of types and key names only. */
function issueSentence(issue: Record<string, any>): string {
  switch (issue.code) {
    case "invalid_type":
      return `expected ${String(issue.expected)}`;
    case "unrecognized_keys":
      return `unknown key${issue.keys?.length === 1 ? "" : "s"}: ${(issue.keys ?? []).join(", ")}`;
    case "invalid_union":
      return "does not match any shape this key accepts";
    case "invalid_value":
      return "is not one of the values this key accepts";
    case "too_small":
      return "is too short or too small";
    case "too_big":
      return "is too long or too large";
    default:
      return `is not valid (${String(issue.code)})`;
  }
}

/** config.yaml: YAML, then the schema the loader uses. */
export function checkConfigYaml(file: string): FileCheck {
  const read = readYamlFile(file);
  if (read.check.state !== "ok") return read.check;
  const value = read.check.value;
  if (value === null || value === undefined) {
    return {
      ...read.check,
      state: "broken",
      errors: [
        { message: "is empty; it needs at least name, version and schema" },
      ],
    };
  }
  const parsed = configYamlSchema.safeParse(value);
  if (parsed.success) return read.check;
  const errors: FileProblem[] = parsed.error.issues.slice(0, 20).map((raw) => {
    const issue = raw as unknown as Record<string, any>;
    const keyPath = (issue.path ?? []) as PropertyKey[];
    return {
      message: issueSentence(issue),
      ...(keyPath.length ? { key: keyPath.map(String).join(".") } : {}),
      ...locate(read, keyPath),
    };
  });
  return { ...read.check, state: "broken", errors };
}

const RULE_LISTS = ["allow", "ask", "exclude"] as const;

/**
 * permissions.yaml: YAML, a mapping, known top-level keys, and rule lists that
 * are lists of patterns. These are the conditions under which the terminal
 * agent reads the file at all: one unknown key and the whole file's rules are
 * skipped.
 */
export function checkPermissionsYaml(file: string): FileCheck {
  const read = readYamlFile(file);
  if (read.check.state !== "ok") return read.check;
  const value = read.check.value;
  if (value === null || value === undefined) return read.check;
  if (!isMapping(value)) {
    return {
      ...read.check,
      state: "broken",
      errors: [{ message: "is not a mapping of keys, so none of it is used" }],
    };
  }
  const errors: FileProblem[] = [];
  const known: readonly string[] = [...RULE_LISTS, ...POLICY_FILE_KEYS];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      errors.push({
        message:
          "unknown top-level key; with it present the allow, ask and exclude lists are not read",
        key,
        ...locate(read, [key]),
      });
    }
  }
  for (const list of RULE_LISTS) {
    const rules = value[list];
    if (rules === undefined || rules === null) continue;
    if (!Array.isArray(rules)) {
      errors.push({
        message: "must be a list of rules",
        key: list,
        ...locate(read, [list]),
      });
      continue;
    }
    rules.forEach((rule, index) => {
      let ok = typeof rule === "string";
      if (ok) {
        try {
          parseToolPattern(rule, "ask");
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        errors.push({
          message: "is not a rule of the form Tool or Tool(pattern)",
          key: `${list}.${index}`,
          ...locate(read, [list, index]),
        });
      }
    });
  }
  return errors.length
    ? { ...read.check, state: "broken", errors }
    : read.check;
}

const HANDLER_TYPES = ["command", "http", "prompt", "agent"];

/**
 * A hooks settings file (settings.json): JSON, an object, and a `hooks` block
 * of events, matcher groups and handlers. An unknown event name is a warning:
 * the file loads, the hook never fires.
 */
export function checkHookSettings(file: string): FileCheck {
  const check = checkJsonFile(file);
  if (check.state !== "ok") return check;
  const value = check.value;
  if (!isMapping(value)) {
    return {
      ...check,
      state: "broken",
      errors: [{ message: "must be a JSON object" }],
    };
  }
  const errors: FileProblem[] = [];
  const warnings: FileProblem[] = [];
  const hooks = value.hooks;
  if (hooks !== undefined && !isMapping(hooks)) {
    errors.push({ message: "must be an object of events", key: "hooks" });
  } else if (isMapping(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      const at = `hooks.${event}`;
      if (!(HOOK_EVENT_NAMES as readonly string[]).includes(event)) {
        warnings.push({
          message: "is not an event this version fires, so its hooks never run",
          key: at,
        });
      }
      if (!Array.isArray(groups)) {
        errors.push({ message: "must be a list of matcher groups", key: at });
        continue;
      }
      groups.forEach((group, g) => {
        const groupAt = `${at}.${g}`;
        if (!isMapping(group) || !Array.isArray(group.hooks)) {
          errors.push({
            message: "must be an object with a hooks list",
            key: groupAt,
          });
          return;
        }
        if (group.matcher !== undefined) {
          let valid = typeof group.matcher === "string";
          if (valid) {
            try {
              new RegExp(group.matcher as string);
            } catch {
              valid = false;
            }
          }
          if (!valid) {
            errors.push({
              message: "is not a valid regular expression",
              key: `${groupAt}.matcher`,
            });
          }
        }
        group.hooks.forEach((handler, h) => {
          const handlerAt = `${groupAt}.hooks.${h}`;
          if (
            !isMapping(handler) ||
            !HANDLER_TYPES.includes(handler.type as string)
          ) {
            errors.push({
              message: `needs a type: ${HANDLER_TYPES.join(", ")}`,
              key: handlerAt,
            });
          } else if (
            handler.type === "command" &&
            (typeof handler.command !== "string" || !handler.command.trim())
          ) {
            errors.push({
              message: "a command hook needs a command",
              key: handlerAt,
            });
          } else if (
            handler.type === "http" &&
            (typeof handler.url !== "string" || !handler.url.trim())
          ) {
            errors.push({
              message: "an http hook needs a url",
              key: handlerAt,
            });
          }
        });
      });
    }
  }
  const limits = value.runLimits;
  if (limits !== undefined && !isMapping(limits)) {
    errors.push({ message: "must be an object", key: "runLimits" });
  }
  return {
    ...check,
    state: errors.length ? "broken" : "ok",
    errors,
    warnings,
  };
}
