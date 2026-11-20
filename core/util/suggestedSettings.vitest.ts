import { describe, expect, it } from "vitest";
import { suggestSettings, type CurrentSettings } from "./suggestedSettings";

const none: CurrentSettings = { tools: "auto" };
const keys = (s: ReturnType<typeof suggestSettings>) => s.map((x) => x.key);

describe("suggestSettings: the window", () => {
  it("suggests a running or maximum window that differs", () => {
    const s = suggestSettings(
      { listedLimits: { contextLength: 131072, kind: "max" } },
      none,
    );
    expect(s).toEqual([
      expect.objectContaining({ key: "contextLength", value: 131072 }),
    ]);
    expect(
      suggestSettings(
        { listedLimits: { contextLength: 8192, kind: "loaded" } },
        { ...none, contextLength: 32768 },
      )[0].reason,
    ).toMatch(/runs this model/);
  });
  it("suggests nothing when the setting already matches", () => {
    expect(
      suggestSettings(
        { listedLimits: { contextLength: 8192, kind: "loaded" } },
        { ...none, contextLength: 8192 },
      ),
    ).toEqual([]);
  });
  it("does not set a window from the trained one, but lowers a setting past it", () => {
    const trained = { contextLength: 65536, kind: "trained" as const };
    expect(suggestSettings({ listedLimits: trained }, none)).toEqual([]);
    expect(
      suggestSettings(
        { listedLimits: trained },
        { ...none, contextLength: 200000 },
      ),
    ).toEqual([
      expect.objectContaining({ key: "contextLength", value: 65536 }),
    ]);
    expect(
      suggestSettings(
        { listedLimits: trained },
        { ...none, contextLength: 32768 },
      ),
    ).toEqual([]);
  });
});

describe("suggestSettings: tools", () => {
  it("suggests the recovery dialect for calls written as text", () => {
    const s = suggestSettings(
      { probe: { kind: "text", recoveryDialect: "qwen-xml" } },
      none,
    );
    expect(s).toEqual([
      expect.objectContaining({ key: "toolDialect", value: "qwen-xml" }),
    ]);
  });
  it("does not repeat a dialect that is already set", () => {
    expect(
      suggestSettings(
        { probe: { kind: "text", recoveryDialect: "qwen-xml" } },
        { ...none, toolDialect: "qwen-xml" },
      ),
    ).toEqual([]);
  });
  it("suggests no dialect when the server parses the calls (none offered)", () => {
    expect(suggestSettings({ probe: { kind: "text" } }, none)).toEqual([]);
  });
  it("suggests system-message tools when the model refuses native ones", () => {
    expect(suggestSettings({ probe: { kind: "none" } }, none)).toEqual([
      expect.objectContaining({ key: "tools", value: "off" }),
    ]);
    expect(
      suggestSettings({ probe: { kind: "none" } }, { ...none, tools: "off" }),
    ).toEqual([]);
  });
  it("suggests auto-detect when native calls work but tools are forced off", () => {
    expect(
      suggestSettings({ probe: { kind: "native" } }, { ...none, tools: "off" }),
    ).toEqual([expect.objectContaining({ key: "tools", value: "auto" })]);
    expect(suggestSettings({ probe: { kind: "native" } }, none)).toEqual([]);
  });
  it("suggests nothing when the probe could not tell", () => {
    expect(suggestSettings({ probe: { kind: "unknown" } }, none)).toEqual([]);
  });
});

describe("suggestSettings: together", () => {
  it("lists every change, in the order window, dialect, tools", () => {
    const s = suggestSettings(
      {
        listedLimits: { contextLength: 4096, kind: "loaded" },
        probe: { kind: "text", recoveryDialect: "hermes" },
      },
      none,
    );
    expect(keys(s)).toEqual(["contextLength", "toolDialect"]);
  });
  it("is empty for no findings", () => {
    expect(suggestSettings({}, none)).toEqual([]);
  });
});
