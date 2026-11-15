import fs from "fs";

import { z } from "zod";

import { configError } from "./exitCodes.js";

/** A JSON Schema the final answer of a headless run must match (`--output-schema <file>`). */
export interface OutputSchema {
  file: string;
  check: (value: unknown) => { ok: true } | { ok: false; problems: string[] };
}

/**
 * Reads and compiles the schema. A file that cannot be read, is not JSON or
 * uses a JSON Schema feature the validator does not support is a config
 * error (exit 2), before any model request is sent.
 */
export function loadOutputSchema(file: string): OutputSchema {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    throw configError(
      `--output-schema: cannot read ${file}: ${(e as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw configError(
      `--output-schema: ${file} is not JSON: ${(e as Error).message}`,
    );
  }
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(json as never);
  } catch (e) {
    throw configError(
      `--output-schema: ${file} is not a JSON Schema this version can check: ${(e as Error).message}`,
    );
  }
  return {
    file,
    check: (value) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) return { ok: true };
      return {
        ok: false,
        problems: parsed.error.issues.slice(0, 5).map((issue) => {
          const at = issue.path.length ? issue.path.join(".") : "(root)";
          return `${at}: ${issue.message}`;
        }),
      };
    },
  };
}

/** The answer as JSON: the whole text, or the one fenced ```json block it is wrapped in. */
export function answerAsJson(
  answer: string,
): { ok: true; value: unknown } | { ok: false } {
  const text = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  try {
    return { ok: true, value: JSON.parse(fenced ? fenced[1] : text) };
  } catch {
    return { ok: false };
  }
}

/** Undefined when the answer matches; else one sentence on why not. */
export function outputSchemaProblem(
  schema: OutputSchema,
  answer: string,
): string | undefined {
  const parsed = answerAsJson(answer);
  if (!parsed.ok) {
    return `The final answer is not JSON, so it does not match --output-schema ${schema.file}.`;
  }
  const result = schema.check(parsed.value);
  if (result.ok) return undefined;
  return `The final answer does not match --output-schema ${schema.file}: ${result.problems.join("; ")}`;
}
