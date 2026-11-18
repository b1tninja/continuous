import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";
import {
  sanitizePromptVariant,
  type ReviewerPromptVariant,
} from "./auto/promptV3";

/**
 * `toolPermissions.auto.reviewerPrompt`: which reviewer prompt Auto uses
 * (ROADMAP B83). Read straight from the person's own config.yaml and from no
 * other file, so a repository, a hub block or an assistant cannot switch the
 * reviewer's prompt. `v3` is the tightened prompt; anything else, or no file,
 * is the shipped prompt. Cached per file by modification time and size, like
 * userLimits.ts.
 */
interface Cached {
  mtimeMs: number;
  size: number;
  value: ReviewerPromptVariant;
}

const cache = new Map<string, Cached>();

export function readUserReviewerPrompt(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): ReviewerPromptVariant {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.value;
    }
    const root = YAML.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    const value = sanitizePromptVariant(
      root?.toolPermissions?.auto?.reviewerPrompt,
    );
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    cache.delete(file);
    return "default";
  }
}
