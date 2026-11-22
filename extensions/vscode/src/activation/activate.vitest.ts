import { afterEach, describe, expect, it, vi } from "vitest";

const { yaml, getExtension, showInformationMessage } = vi.hoisted(() => ({
  yaml: {
    inspect: vi.fn((_key: string): unknown => undefined),
    update: vi.fn(async (_key: string, _value: unknown, _target: number) => {}),
  },
  getExtension: vi.fn((_id: string): unknown => undefined),
  showInformationMessage: vi.fn((..._args: unknown[]): unknown => undefined),
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: { getConfiguration: () => yaml },
  window: { showInformationMessage },
  extensions: { getExtension },
  commands: { executeCommand: vi.fn() },
}));
vi.mock("core/util/paths", () => ({
  getContinueRcPath: vi.fn(),
  getTsConfigPath: vi.fn(),
}));
vi.mock("core/util/GlobalContext", () => ({
  GlobalContext: class {
    get() {
      return undefined;
    }
    update() {}
  },
}));
vi.mock("../extension/VsCodeExtension", () => ({
  VsCodeExtension: class {
    registerCustomContextProvider() {}
  },
}));
vi.mock("../sessionCleanup", () => ({ registerSessionCleanup: vi.fn() }));
vi.mock("../util/util", () => ({
  isUnsupportedPlatform: () => ({ isUnsupported: false }),
}));
vi.mock("../util/migrateSettings", () => ({
  migrateContinueSettings: vi.fn(async () => {}),
}));
vi.mock("./InlineTipManager", () => ({ default: vi.fn() }));

import { activateExtension } from "./activate";

const context = {
  globalState: { get: () => true, update: async () => {} },
} as any;

const STALE =
  "file:///Users/u/.vscode/extensions/b1tninja.continuous-2.4.4/config-yaml-schema.json";

/** One warning, on one line, that says which extension it is from. */
function expectOneNamedLine(warn: ReturnType<typeof vi.spyOn>) {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]).toHaveLength(1);
  expect(warn.mock.calls[0][0]).toMatch(/^Continuous: [^\n]*yaml\.schemas/);
  expect(warn.mock.calls[0][0]).not.toContain("\n");
}

describe("activateExtension and the yaml.schemas clean-up", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    yaml.inspect.mockReset();
    yaml.update.mockReset();
  });

  it("activates when the setting cannot be written", async () => {
    // What VS Code answers when no extension contributes yaml.schemas (#981)
    yaml.inspect.mockReturnValue({ globalValue: { [STALE]: ["*.yaml"] } });
    yaml.update.mockRejectedValue(
      new Error(
        "Unable to write to User Settings because yaml.schemas is not a registered configuration.\n    at validate (workbench.desktop.main.js:5898:9744)",
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const api = await activateExtension(context);

    expect(api.registerCustomContextProvider).toBeTypeOf("function");
    expect(yaml.update).toHaveBeenCalledTimes(1);
    expectOneNamedLine(warn);
  });

  it("activates when the setting cannot be read", async () => {
    yaml.inspect.mockImplementation(() => {
      throw new Error("settings are unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const api = await activateExtension(context);

    expect(api.registerCustomContextProvider).toBeTypeOf("function");
    expectOneNamedLine(warn);
  });

  it("logs nothing when there is nothing to clean up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await activateExtension(context);

    expect(yaml.update).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("activateExtension and the side-by-side notice", () => {
  // A first start: nothing stored yet
  const firstStart = {
    globalState: { get: () => undefined, update: async () => {} },
  } as any;

  afterEach(() => {
    vi.restoreAllMocks();
    getExtension.mockReset();
    showInformationMessage.mockReset();
  });

  it("activates while the notice waits for an answer", async () => {
    getExtension.mockImplementation((id: string) =>
      id === "Continue.continue" ? { id } : undefined,
    );
    showInformationMessage.mockReturnValue(new Promise(() => {}));

    const api = await activateExtension(firstStart);

    expect(api.registerCustomContextProvider).toBeTypeOf("function");
    await vi.waitFor(() =>
      expect(showInformationMessage).toHaveBeenCalledTimes(1),
    );
    expect(showInformationMessage.mock.calls[0][0]).toContain(
      "the Continue extension is also installed",
    );
  });

  it("activates when the extension list cannot be read", async () => {
    getExtension.mockImplementation(() => {
      throw new Error("extensions are unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const api = await activateExtension(firstStart);

    expect(api.registerCustomContextProvider).toBeTypeOf("function");
    expect(warn).toHaveBeenCalledWith(
      "Continuous: could not show the side-by-side notice: extensions are unavailable",
    );
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});
