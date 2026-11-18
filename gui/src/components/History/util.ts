import { BaseSessionMetadata } from "core";

export const parseDate = (date: string): Date => {
  let dateObj = new Date(date);
  if (isNaN(dateObj.getTime())) {
    dateObj = new Date(parseInt(date));
  }
  return dateObj;
};

export interface SessionGroup {
  label: string;
  sessions: BaseSessionMetadata[];
}

export const groupSessionsByDate = (
  sessions: BaseSessionMetadata[],
): SessionGroup[] => {
  const yesterday = new Date(Date.now() - 1000 * 60 * 60 * 24);
  const lastWeek = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7);
  const lastMonth = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);

  const groups: SessionGroup[] = [];

  const todaySessions = sessions.filter(
    (session) => parseDate(session.dateCreated) > yesterday,
  );
  const weekSessions = sessions.filter((session) => {
    const date = parseDate(session.dateCreated);
    return date <= yesterday && date > lastWeek;
  });
  const monthSessions = sessions.filter((session) => {
    const date = parseDate(session.dateCreated);
    return date <= lastWeek && date > lastMonth;
  });
  const olderSessions = sessions.filter(
    (session) => parseDate(session.dateCreated) <= lastMonth,
  );

  if (todaySessions.length > 0)
    groups.push({ label: "Today", sessions: todaySessions });
  if (weekSessions.length > 0)
    groups.push({ label: "This Week", sessions: weekSessions });
  if (monthSessions.length > 0)
    groups.push({ label: "This Month", sessions: monthSessions });
  if (olderSessions.length > 0)
    groups.push({ label: "Older", sessions: olderSessions });

  return groups;
};

/**
 * Sessions the person archived, apart from the rest, each in the order given.
 * Archiving only hides a session from the date groups: its file is kept.
 */
export function splitArchivedSessions(
  sessions: BaseSessionMetadata[],
  archivedIds: Record<string, number> | undefined,
): { active: BaseSessionMetadata[]; archived: BaseSessionMetadata[] } {
  const active: BaseSessionMetadata[] = [];
  const archived: BaseSessionMetadata[] = [];
  for (const session of sessions) {
    (archivedIds?.[session.sessionId] !== undefined ? archived : active).push(
      session,
    );
  }
  return { active, archived };
}
