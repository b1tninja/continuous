import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PALETTE_COMMAND_IDS,
  PALETTE_NOTHING_TO_DO,
  PALETTE_ROUTES,
  paletteCommands,
  type PaletteHost,
} from "./paletteCommands";

const packageJSON = require("../package.json");
const contributes = packageJSON.contributes;
const declared: string[] = contributes.commands.map((c: any) => c.command);

/** The extension's source, without tests, where commands are registered. */
function sourceText(dir = __dirname): string {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return [sourceText(full)];
      }
      return entry.name.endsWith(".ts") && !entry.name.includes(".vitest.")
        ? [fs.readFileSync(full, "utf8")]
        : [];
    })
    .join("\n");
}
const source = sourceText();

function escape(id: string) {
  return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A key of the commands map names the id, or a registerCommand call does,
 * directly or through a constant that holds it.
 */
function isRegistered(id: string): boolean {
  if ((PALETTE_COMMAND_IDS as readonly string[]).includes(id)) {
    return true;
  }
  const quoted = `"${escape(id)}"`;
  if (new RegExp(`^\\s*${quoted}\\s*:`, "m").test(source)) {
    return true;
  }
  if (new RegExp(`registerCommand\\(\\s*${quoted}`).test(source)) {
    return true;
  }
  const constant = new RegExp(`const (\\w+)\\s*=\\s*${quoted}`).exec(source);
  return (
    !!constant &&
    new RegExp(`registerCommand\\w*\\(\\s*${constant[1]}\\b`).test(source)
  );
}

describe("Command Palette manifest", () => {
  it("declares no command id twice", () => {
    const duplicates = declared.filter((id, i) => declared.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  it("has a handler for every declared command", () => {
    expect(declared.filter((id) => !isRegistered(id))).toEqual([]);
  });

  it("lists only declared commands in the palette menu", () => {
    const listed = contributes.menus.commandPalette.map((m: any) => m.command);
    expect(listed.filter((id: string) => !declared.includes(id))).toEqual([]);
  });

  it("declares each new command in the Continuous category, with no default key", () => {
    const keyed = contributes.keybindings.map((k: any) => k.command);
    for (const id of PALETTE_COMMAND_IDS) {
      const command = contributes.commands.find((c: any) => c.command === id);
      expect(command, id).toMatchObject({ category: "Continuous" });
      expect(command.title, id).toBeTruthy();
      expect(keyed, id).not.toContain(id);
    }
    // Spread into the commands map, so registered with the rest
    expect(source).toMatch(/\.\.\.paletteCommands\(\{/);
  });

  it("has dropped the enterprise license command and the second Focus declaration", () => {
    const manifest = JSON.stringify(contributes);
    expect(manifest).not.toContain("enterEnterpriseLicenseKey");
    expect(source).not.toContain("enterEnterpriseLicenseKey");
    expect(source).not.toContain("mdm/setLicenseKey");
    const focus = contributes.commands.filter(
      (c: any) => c.command === "continuous.focusContinuousInput",
    );
    expect(focus).toHaveLength(1);
    expect(focus[0].title).toBe(
      "Add Highlighted Code to Context and Clear Chat",
    );
  });
});

function host(answer: unknown, ready = true) {
  const h = {
    showPanel: vi.fn(async () => ready),
    request: vi.fn(async () => answer),
    info: vi.fn(),
  };
  return { h, commands: paletteCommands(h as unknown as PaletteHost) };
}

describe("Command Palette commands", () => {
  it("opens each page through the panel's navigateTo route", async () => {
    const cases = [
      ["continuous.openPermissions", PALETTE_ROUTES.permissions],
      ["continuous.openAuditInbox", PALETTE_ROUTES.auditInbox],
      ["continuous.openStats", PALETTE_ROUTES.stats],
    ] as const;
    for (const [id, route] of cases) {
      const { h, commands } = host(undefined);
      await commands[id]();
      expect(h.showPanel).toHaveBeenCalled();
      expect(h.request).toHaveBeenCalledWith("navigateTo", {
        path: route,
        toggle: false,
      });
    }
    expect(PALETTE_ROUTES.auditInbox).toBe(
      "/config?tab=permissions&view=inbox",
    );
  });

  it("sends each chat action to the panel, and says so when there was nothing to act on", async () => {
    const cases = [
      ["continuous.stopResponse", "stopResponse"],
      ["continuous.resumeResponse", "resumeResponse"],
      ["continuous.stopLoop", "stopLoop"],
      ["continuous.showAgents", "showAgents"],
      ["continuous.testConnection", "testConnection"],
    ] as const;
    for (const [id, message] of cases) {
      const applied = host(true);
      await applied.commands[id]();
      expect(applied.h.request).toHaveBeenCalledWith(message, undefined);
      expect(applied.h.info).not.toHaveBeenCalled();

      const nothing = host(false);
      await nothing.commands[id]();
      expect(nothing.h.info).toHaveBeenCalledWith(
        PALETTE_NOTHING_TO_DO[message],
      );
    }
  });

  it("Start Loop says so only when a loop already runs", async () => {
    for (const answer of ["resumed", "chosen"]) {
      const { h, commands } = host(answer);
      await commands["continuous.startLoop"]();
      expect(h.request).toHaveBeenCalledWith("startLoop", undefined);
      expect(h.info).not.toHaveBeenCalled();
    }
    const { h, commands } = host("running");
    await commands["continuous.startLoop"]();
    expect(h.info).toHaveBeenCalledWith(PALETTE_NOTHING_TO_DO.startLoop);
  });

  it("sends nothing when the panel cannot be shown, and stays quiet when it does not answer", async () => {
    const closed = host(true, false);
    await closed.commands["continuous.stopResponse"]();
    expect(closed.h.request).not.toHaveBeenCalled();

    const silent = host(undefined);
    await silent.commands["continuous.stopResponse"]();
    expect(silent.h.info).not.toHaveBeenCalled();
  });
});
