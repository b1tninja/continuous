import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store: Record<string, unknown> = {};
vi.mock("core/util/GlobalContext.js", () => ({
  GlobalContext: class {
    get(k: string) {
      return store[k];
    }
    update(k: string, v: unknown) {
      store[k] = v;
    }
  },
}));
const cli = vi.hoisted(() => ({ interactive: true, serve: false }));
vi.mock("../util/cli.js", () => ({
  supportsInteractive: () => cli.interactive,
  isServe: () => cli.serve,
}));

import {
  firstRunBannerText,
  markFirstRunBannerShown,
  shouldShowFirstRunBanner,
} from "./firstRunBannerState.js";

describe("CLI first-run banner", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    cli.interactive = true;
    cli.serve = false;
  });

  it("shows for a first-time interactive user, then never again", () => {
    expect(shouldShowFirstRunBanner()).toBe(true);
    markFirstRunBannerShown();
    expect(store.cliFirstRunBannerShown).toBe(true);
    expect(shouldShowFirstRunBanner()).toBe(false);
  });

  it("never shows headless, without a TTY or in serve", () => {
    cli.interactive = false;
    expect(shouldShowFirstRunBanner()).toBe(false);
    cli.interactive = true;
    cli.serve = true;
    expect(shouldShowFirstRunBanner()).toBe(false);
  });

  it("names the preset and /policy", () => {
    const text = firstRunBannerText(DEFAULT_POLICY_LEVELS);
    expect(text).toContain("Careful preset");
    expect(text).toContain("/policy");
    expect(
      firstRunBannerText({ ...DEFAULT_POLICY_LEVELS, tools: "idgaf" }),
    ).toContain("custom mix");
  });
});
