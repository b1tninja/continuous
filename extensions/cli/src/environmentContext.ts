import fs from "fs";

import type { Session, SessionEnvironment } from "core/index.js";
import {
  readUserEnvironmentDetail,
  resolveEnvironmentDetail,
} from "core/util/environmentDetail.js";
import {
  placeEnvironment,
  withDateNotice,
  withTrailingText,
  type EnvironmentNotice,
} from "core/util/environmentMessages.js";
import {
  CONTEXT_CLOSE,
  ENVIRONMENT_BLOCK_OPEN as BLOCK_OPEN,
  renderEnvironment,
  type Detail,
  type EnvironmentDisclosure,
  type EnvironmentSnapshot,
  type Surface,
} from "core/util/environmentPrompt.js";
import {
  baseSnapshot,
  gatherEnvironment,
  isEnvironmentSnapshot,
  localDayOf,
  type GatherInput,
} from "core/util/environmentSnapshot.js";
import type { ChatCompletionMessageParam } from "openai/resources.mjs";

import { getCurrentSession } from "./session.js";

/**
 * What the CLI tells the model about this machine and folder, from one
 * snapshot per session (core/util/environmentSnapshot.ts) rendered by the one
 * renderer (core/util/environmentPrompt.ts):
 *
 * - `systemLine` in the system message: the platform and a pointer to the
 *   block, the same in every folder;
 * - `toolSentence` in the Bash tool: the shell, the same in every folder;
 * - `firstMessageBlock` on the first user message: the date, the masked
 *   working folder and the git facts at the start, fenced and capped.
 *
 * The snapshot is gathered once, asynchronously (git calls stop after 2 s),
 * and saved with the session, so a resumed session keeps its bytes. The
 * system line and the tool sentence need no git, so they are the session's
 * bytes even before the gather finishes.
 */

export const ENVIRONMENT_BLOCK_OPEN = BLOCK_OPEN;
export const ENVIRONMENT_BLOCK_CLOSE = CONTEXT_CLOSE;

/** The three strings a request carries. */
export interface EnvironmentStrings {
  systemLine: string;
  toolSentence: string;
  firstMessageBlock: string;
}

/**
 * When running on Windows, but inside WSL, shell commands need to run using
 * the WSL environment.
 */
export function isRunningInWsl(): boolean {
  // WSL only applies when platform reports as Linux
  if (process.platform !== "linux") {
    return false;
  }

  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }

  // Check /proc/version for Microsoft/WSL indicators
  try {
    const procVersion = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return procVersion.includes("microsoft") || procVersion.includes("wsl");
  } catch {
    return false;
  }
}

let surface: Surface = "cli";
let detailSetting: Detail | undefined;
let inherited: EnvironmentStrings | undefined;
let cached: { sessionId?: string; env: SessionEnvironment } | undefined;
let pending:
  { sessionId?: string; promise: Promise<SessionEnvironment> } | undefined;
let rendered:
  | { snapshot: EnvironmentSnapshot; key: string; d: EnvironmentDisclosure }
  | undefined;

/** `cli` by default; headless, serve and ACP render the same bytes. */
export function setEnvironmentSurface(next: Surface): void {
  surface = next;
}

export function environmentSurface(): Surface {
  return surface;
}

/** The detail level for sessions started from now on. */
export function setEnvironmentDetail(detail: Detail | undefined): void {
  detailSetting = detail;
}

/**
 * `--env-detail`, else `environment.detail` in the person's own config.yaml,
 * else `standard` (core/util/environmentDetail.ts). An assistant's config may
 * only lower it.
 */
export function environmentDetail(): Detail {
  return resolveEnvironmentDetail({
    flag: detailSetting,
    user: readUserEnvironmentDetail(),
    lowerOnly: [assistantDetail],
  });
}

let assistantDetail: Detail | undefined;

/** `environment.detail` of the loaded assistant config: it may only lower the level. */
export function setAssistantEnvironmentDetail(detail: Detail | undefined) {
  assistantDetail = detail;
}

function currentSession(): Session | undefined {
  try {
    return getCurrentSession();
  } catch {
    return undefined;
  }
}

function gatherInput(): GatherInput {
  return {
    cwd: process.cwd(),
    hostWsl: process.platform === "linux" ? isRunningInWsl() : undefined,
  };
}

function savedOf(session: Session | undefined): SessionEnvironment | undefined {
  const saved = session?.environment;
  return saved && isEnvironmentSnapshot(saved.snapshot) ? saved : undefined;
}

/**
 * The session's environment: the saved one, the one gathered for this
 * session, or, until the gather has finished, a snapshot without git (its
 * system line and tool sentence are the same bytes).
 */
export function sessionEnvironment(): SessionEnvironment {
  const session = currentSession();
  const saved = savedOf(session);
  if (saved) return saved;
  if (cached && cached.sessionId === session?.sessionId) return cached.env;
  return { snapshot: baseSnapshot(gatherInput()), detail: environmentDetail() };
}

/**
 * Gathers the session's snapshot once and saves it on the session. A resumed
 * session's saved snapshot is reused as it is.
 */
export async function ensureSessionEnvironment(): Promise<SessionEnvironment> {
  const session = currentSession();
  const saved = savedOf(session);
  if (saved) return saved;
  const id = session?.sessionId;
  if (!cached || cached.sessionId !== id) {
    if (!pending || pending.sessionId !== id) {
      const detail = environmentDetail();
      pending = {
        sessionId: id,
        promise: gatherEnvironment(gatherInput()).then((snapshot) => ({
          snapshot,
          detail,
        })),
      };
    }
    const env = await pending.promise;
    cached = { sessionId: id, env };
  }
  if (session && !session.environment) session.environment = cached.env;
  return cached.env;
}

/** The rendered disclosure for the session (or the parent's, for a subagent). */
export function environmentDisclosure(
  env: SessionEnvironment = sessionEnvironment(),
): EnvironmentStrings {
  if (inherited) return inherited;
  return environmentReport(env);
}

/** The whole rendering for one snapshot: the three strings and the field report. */
export function environmentReport(
  env: SessionEnvironment = sessionEnvironment(),
): EnvironmentDisclosure {
  const key = `${surface}\0${env.detail}`;
  if (rendered && rendered.snapshot === env.snapshot && rendered.key === key) {
    return rendered.d;
  }
  const d = renderEnvironment(env.snapshot, { surface, detail: env.detail });
  rendered = { snapshot: env.snapshot, key, d };
  return d;
}

/**
 * A subagent tells its model what the parent told its own: the same three
 * strings, not a new gather, so the subagent can read the parent's cached
 * prefix (ENV17). `undefined` goes back to the session's own.
 */
export function inheritEnvironment(
  strings: EnvironmentStrings | undefined,
): void {
  inherited = strings
    ? {
        systemLine: strings.systemLine,
        toolSentence: strings.toolSentence,
        firstMessageBlock: strings.firstMessageBlock,
      }
    : undefined;
}

/** The strings a subagent run is carrying, if one is running. */
export function inheritedEnvironment(): EnvironmentStrings | undefined {
  return inherited;
}

/** The block for the first user message of this session. */
export function environmentContextBlock(): string {
  return environmentDisclosure().firstMessageBlock;
}

/** Forget everything, so the next request gathers again. For tests. */
export function resetEnvironmentContextBlock(): void {
  cached = undefined;
  pending = undefined;
  rendered = undefined;
  inherited = undefined;
  detailSetting = undefined;
  assistantDetail = undefined;
  surface = "cli";
}

/**
 * The request's messages with the environment block appended to the first
 * user message. Nothing is written back to the history: the block is added at
 * request time, like the task list block, and built from the session's saved
 * snapshot, so a resumed session carries the bytes it started with. Messages
 * without a user message are returned as they are.
 */
export function withEnvironmentBlock(
  messages: ChatCompletionMessageParam[],
  environmentBlock: string = environmentContextBlock(),
  notices: readonly EnvironmentNotice[] = environmentNotices(),
): ChatCompletionMessageParam[] {
  const withBlock = withFirstBlock(messages, environmentBlock);
  if (notices.length === 0 || withBlock === messages) return withBlock;
  // Each date notice stays on the user message it was first added to
  return placeEnvironment(
    withBlock,
    (m) => m.role === "user",
    (m, add) =>
      ({
        ...m,
        content: withTrailingText(m.content, add.notices.join("\n\n")),
      }) as ChatCompletionMessageParam,
    undefined,
    notices,
  );
}

/** The date notices this session has sent, each on its user message. */
export function environmentNotices(): readonly EnvironmentNotice[] {
  return savedOf(currentSession())?.notices ?? [];
}

/**
 * Records a date notice when the person's local day has moved on since the
 * session started (or since the last notice): on the newest of the request's
 * `userTurns` user messages, saved with the session, so later requests carry
 * it on the same message and earlier bytes never change (ENV32).
 */
export function noteDateRollover(
  userTurns: number,
  today: string = localDayOf(),
): void {
  const env = savedOf(currentSession());
  if (!env) return;
  const before = env.notices ?? [];
  const next = withDateNotice(env.snapshot, before, userTurns, today);
  if (next !== before) env.notices = [...next];
}

function withFirstBlock(
  messages: ChatCompletionMessageParam[],
  environmentBlock: string,
): ChatCompletionMessageParam[] {
  const index = messages.findIndex((m) => m.role === "user");
  if (index === -1) return messages;
  const first = messages[index];
  const content = first.content;
  let appended: ChatCompletionMessageParam;
  if (typeof content === "string") {
    appended = {
      ...first,
      content: content ? `${content}\n\n${environmentBlock}` : environmentBlock,
    };
  } else if (Array.isArray(content)) {
    appended = {
      ...first,
      content: [...content, { type: "text", text: environmentBlock }],
    } as ChatCompletionMessageParam;
  } else {
    return messages;
  }
  return [...messages.slice(0, index), appended, ...messages.slice(index + 1)];
}
