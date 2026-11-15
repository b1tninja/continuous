import {
  listSessionsForWorkspace,
  loadSessionById,
  setResumeSessionId,
} from "../session.js";
import { logger } from "../util/logger.js";

import { chat } from "./chat.js";
import { pickSession } from "./resumePicker.js";

interface ListSessionsOptions {
  format?: "json";
}

/**
 * List recent chat sessions and allow selection. Sessions of the folder the
 * CLI runs in come first (newest at the top, selected), then the other
 * folders, each under its own header (session.ts orderSessionsForWorkspace).
 */
export async function listSessionsCommand(
  options: ListSessionsOptions = {},
): Promise<void> {
  // Handle JSON format output first
  if (options.format === "json") {
    const sessions = await listSessionsForWorkspace();
    console.log(
      JSON.stringify(
        {
          sessions: sessions.map((session) => ({
            id: session.sessionId,
            timestamp: session.dateCreated,
            workspaceDirectory: session.workspaceDirectory,
            title: session.title,
            firstUserMessage: session.firstUserMessage,
            isRemote: session.isRemote,
            remoteId: session.remoteId,
            inWorkspace: session.inWorkspace ?? false,
            workspaceGroup: session.workspaceGroup,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // For TUI mode, fetch more sessions than we might display so the UI can choose based on screen height
  const sessions = await listSessionsForWorkspace();

  // Handle empty sessions case
  if (sessions.length === 0) {
    console.log(
      "No previous sessions found. Start a new conversation with: cn",
    );
    return;
  }

  const sessionId = await pickSession(sessions);
  if (!sessionId) return;

  // Handle local session
  const sessionHistory = loadSessionById(sessionId);
  if (!sessionHistory) {
    logger.error(`Session ${sessionId} could not be loaded.`);
    return;
  }

  logger.info(`Loading session: ${sessionId}`);

  // The session chat() resumes: this one, not the newest of the folder
  setResumeSessionId(sessionId);
  await chat(undefined, {
    resume: true,
    headless: false,
  });
}
