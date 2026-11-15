import { JSONContent } from "@tiptap/core";
import { AddToChatPayload, AddToChatRefusal } from "core";
import { Mention } from "../extensions";

export type AddToChatRefusalReason = AddToChatRefusal["reason"] | "no-provider";

export interface AddToChatPlan {
  /** Mention chips, each followed by a space, ready for `insertContent`. */
  content: JSONContent[];
  files: number;
  folders: number;
  /** Items already in the message as the same chip, so not added again. */
  duplicates: number;
  refusals: { name: string; reason: AddToChatRefusalReason }[];
}

/** At most this many refusals are named; the rest are counted. */
const MAX_NAMED_REFUSALS = 3;

function mentionKeys(doc: JSONContent | undefined, out = new Set<string>()) {
  if (!doc) return out;
  if (doc.type === Mention.name && typeof doc.attrs?.query === "string") {
    out.add(`${doc.attrs.itemType}:${doc.attrs.query}`);
  }
  for (const child of doc.content ?? []) mentionKeys(child, out);
  return out;
}

/**
 * Turns an `addToChat` message (sent by the "Add to Continuous Chat"
 * commands in VS Code and the Add to Chat action in JetBrains) into the chips
 * to insert. A file becomes the same `@file` chip the `@` list inserts
 * (`itemType: "file"`, `query: <uri>`), read by the `file` provider when the
 * message is sent; a folder becomes an `@folder` chip, a search scope. A chip
 * already in the message is not added twice, and a folder or file is refused
 * when its provider is not configured, because the chip would add nothing.
 */
export function planAddToChat(
  payload: AddToChatPayload,
  doc: JSONContent | undefined,
  providers: { file: boolean; folder: boolean },
): AddToChatPlan {
  const plan: AddToChatPlan = {
    content: [],
    files: 0,
    folders: 0,
    duplicates: 0,
    refusals: [...(payload.refused ?? [])],
  };
  const already = mentionKeys(doc);

  for (const item of payload.data ?? []) {
    if (!providers[item.type]) {
      plan.refusals.push({ name: item.name, reason: "no-provider" });
      continue;
    }
    const key = `${item.type}:${item.fullPath}`;
    if (already.has(key)) {
      plan.duplicates++;
      continue;
    }
    already.add(key);
    plan.content.push(
      {
        type: Mention.name,
        attrs: {
          id: item.fullPath,
          label: item.name,
          query: item.fullPath,
          itemType: item.type,
        },
      },
      { type: "text", text: " " },
    );
    if (item.type === "folder") plan.folders++;
    else plan.files++;
  }
  return plan;
}

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function refusalSentence(name: string, reason: AddToChatRefusalReason) {
  switch (reason) {
    case "secret":
      return `${name} looks like it holds secrets or keys, so it was not added.`;
    case "outside-workspace":
      return `${name} is outside the workspace, so it was not added.`;
    case "not-found":
      return `${name} was not found in the workspace.`;
    case "unsaved":
      return `${name} is not saved yet, so it was not added.`;
    case "no-provider":
      return `${name} was not added: its context provider is not available in this configuration.`;
  }
}

/** The one sentence announced after an add, and shown for refusals. */
export function describeAddToChat(plan: AddToChatPlan): string {
  const parts: string[] = [];
  const added = [
    plan.files ? count(plan.files, "file", "files") : "",
    plan.folders ? count(plan.folders, "folder", "folders") : "",
  ].filter(Boolean);
  if (added.length) {
    parts.push(`Added ${added.join(" and ")} to the chat input.`);
  }
  if (plan.duplicates) {
    parts.push(
      `${count(plan.duplicates, "item was", "items were")} already in the message.`,
    );
  }
  for (const r of plan.refusals.slice(0, MAX_NAMED_REFUSALS)) {
    parts.push(refusalSentence(r.name, r.reason));
  }
  const unnamed = plan.refusals.length - MAX_NAMED_REFUSALS;
  if (unnamed > 0) {
    parts.push(
      `${count(unnamed, "more item was", "more items were")} not added.`,
    );
  }
  return parts.length
    ? parts.join(" ")
    : "Nothing was added to the chat input.";
}

/** Only the refusal part of the outcome, for a visible notification. */
export function describeAddToChatRefusals(plan: AddToChatPlan): string | null {
  if (!plan.refusals.length) return null;
  return describeAddToChat({
    ...plan,
    content: [],
    files: 0,
    folders: 0,
    duplicates: 0,
  });
}
