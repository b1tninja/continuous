import fs from "fs";
import os from "os";
import path from "path";

import {
  decideNotification,
  enableAttentionNotifications,
  loadNotificationSettings,
  notifyPerson,
  NOTIFICATIONS_OFF,
  parseNotificationSettings,
  REPEAT_WINDOW_MS,
  resetAttentionNotifications,
  type DecisionInput,
  type NotificationSettings,
} from "./attention.js";
import { desktopCommand } from "./osNotify.js";

const ON: NotificationSettings = {
  bell: true,
  desktop: true,
  when: "unfocused",
  longTurnSeconds: 30,
};

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  event: { kind: "approval", tool: "Bash" },
  settings: ON,
  interactive: true,
  focus: "unknown",
  now: 1_000_000,
  lastSent: new Map(),
  ...over,
});

describe("decideNotification", () => {
  it("is off by default", () => {
    expect(
      decideNotification(input({ settings: NOTIFICATIONS_OFF })),
    ).toBeUndefined();
    expect(parseNotificationSettings(undefined)).toEqual(NOTIFICATIONS_OFF);
  });

  it("notifies when an approval waits, naming the tool only", () => {
    expect(decideNotification(input())).toEqual({
      key: "approval:Bash",
      bell: true,
      desktop: true,
      title: "Continuous: approval needed",
      body: "Bash is waiting for your approval.",
    });
  });

  it("keeps a tool name to safe characters", () => {
    const notice = decideNotification(
      input({ event: { kind: "approval", tool: "x$(rm -rf /);`y`" } }),
    );
    expect(notice?.body).toBe("xrm-rfy is waiting for your approval.");
  });

  it("never notifies outside the terminal UI (-p, serve, no TTY)", () => {
    expect(decideNotification(input({ interactive: false }))).toBeUndefined();
  });

  it("unfocused: skips a focused terminal, notifies when focus is unknown", () => {
    expect(decideNotification(input({ focus: "focused" }))).toBeUndefined();
    expect(decideNotification(input({ focus: "unfocused" }))).toBeDefined();
    expect(decideNotification(input({ focus: "unknown" }))).toBeDefined();
    expect(
      decideNotification(
        input({ focus: "focused", settings: { ...ON, when: "always" } }),
      ),
    ).toBeDefined();
  });

  it("a finished turn notifies only when it was long", () => {
    const turn = (ms: number) =>
      decideNotification(
        input({ event: { kind: "turn-finished", durationMs: ms } }),
      );
    expect(turn(29_000)).toBeUndefined();
    expect(turn(95_000)?.body).toBe("The turn finished after 1m 35s.");
  });

  it("drops a repeat within the window, not after it", () => {
    const lastSent = new Map([["approval:Bash", 1_000_000]]);
    expect(
      decideNotification(input({ lastSent, now: 1_000_000 + 1000 })),
    ).toBeUndefined();
    expect(
      decideNotification(
        input({ lastSent, now: 1_000_000 + REPEAT_WINDOW_MS + 1 }),
      ),
    ).toBeDefined();
    expect(
      decideNotification(
        input({ lastSent, event: { kind: "approval", tool: "Write" } }),
      ),
    ).toBeDefined();
  });

  it("bell only or desktop only", () => {
    const bellOnly = decideNotification(
      input({ settings: { ...ON, desktop: false } }),
    );
    expect(bellOnly).toMatchObject({ bell: true, desktop: false });
  });
});

describe("settings", () => {
  it("reads notifications from the person's own settings.json only", () => {
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-notify-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-proj-"));
    const saved = process.env.CONTINUOUS_GLOBAL_DIR;
    process.env.CONTINUOUS_GLOBAL_DIR = globalDir;
    try {
      fs.writeFileSync(
        path.join(globalDir, "settings.json"),
        JSON.stringify({
          notifications: { bell: true, when: "always", longTurnSeconds: 5 },
        }),
      );
      // A project's settings cannot turn notifications on
      fs.mkdirSync(path.join(cwd, ".continuous"));
      fs.writeFileSync(
        path.join(cwd, ".continuous", "settings.json"),
        JSON.stringify({ notifications: { desktop: true } }),
      );
      expect(loadNotificationSettings(cwd)).toEqual({
        bell: true,
        desktop: false,
        when: "always",
        longTurnSeconds: 5,
      });
    } finally {
      if (saved === undefined) delete process.env.CONTINUOUS_GLOBAL_DIR;
      else process.env.CONTINUOUS_GLOBAL_DIR = saved;
      fs.rmSync(globalDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("parses bad values as off or the default", () => {
    expect(
      parseNotificationSettings({
        bell: "yes",
        desktop: 1,
        when: "sometimes",
        longTurnSeconds: -4,
      }),
    ).toEqual(NOTIFICATIONS_OFF);
  });
});

describe("notifyPerson", () => {
  afterEach(() => resetAttentionNotifications());

  it("does nothing until the terminal UI enables it", () => {
    const bell = vi.fn();
    expect(
      notifyPerson({ kind: "question" }, { writeBell: bell }),
    ).toBeUndefined();
    expect(bell).not.toHaveBeenCalled();
  });

  it("rings and raises once, then drops the repeat", () => {
    const tty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      enableAttentionNotifications(ON);
      const bell = vi.fn();
      const desktop = vi.fn();
      const io = { writeBell: bell, desktop, now: () => 5 };
      notifyPerson({ kind: "question" }, io);
      notifyPerson({ kind: "question" }, io);
      expect(bell).toHaveBeenCalledTimes(1);
      expect(desktop).toHaveBeenCalledWith(
        "Continuous: question",
        "A question is waiting for your answer.",
      );
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: tty,
        configurable: true,
      });
    }
  });

  it("swallows a failing notifier", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    enableAttentionNotifications({ ...ON, bell: false });
    expect(() =>
      notifyPerson(
        { kind: "question" },
        {
          desktop: () => {
            throw new Error("no dbus");
          },
        },
      ),
    ).not.toThrow();
  });
});

describe("desktopCommand", () => {
  const title = "T $(x)";
  const body = "B `y` ' \" ;";

  it("passes the text as data, never inside the script", () => {
    for (const platform of ["win32", "darwin"] as const) {
      const cmd = desktopCommand(platform, title, body)!;
      expect(cmd.env).toEqual({
        CN_NOTIFY_TITLE: title,
        CN_NOTIFY_BODY: body,
      });
      expect(cmd.args.join(" ")).not.toContain(title);
      expect(cmd.args.join(" ")).not.toContain(body);
    }
    expect(desktopCommand("win32", title, body)?.command).toBe(
      "powershell.exe",
    );
    expect(desktopCommand("darwin", title, body)?.command).toBe("osascript");
  });

  it("uses notify-send with separate arguments on Linux, nothing elsewhere", () => {
    expect(desktopCommand("linux", title, body)).toEqual({
      command: "notify-send",
      args: ["--app-name=Continuous", "--", title, body],
    });
    expect(desktopCommand("aix", title, body)).toBeUndefined();
  });
});
