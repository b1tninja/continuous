import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  endpointHost,
  fingerprintOf,
  measuredFactsOf,
  probeStatusFor,
  readMeasuredEntries,
  recordProbe,
  recordingEnabled,
  responseShape,
  withProbe,
} from "./measuredFacts.js";
import {
  actionAllowed,
  ENABLE_TOOLS_MIN_N,
  resolveFact,
  type SurfaceRow,
} from "./surfaceFacts.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "mf-")), "facts.json");
const base = {
  provider: "lmstudio",
  apiBase: "http://box.lan:1234/v1",
  model: "m",
  api: "openai-chat",
  outcome: "native" as const,
  fingerprint: "abc",
  now: "2026-11-11",
};

describe("endpointHost", () => {
  it("keeps the host name only", () => {
    expect(endpointHost("https://u:p@Api.Example.com:8443/v1/x?key=1#f")).toBe(
      "api.example.com",
    );
    expect(endpointHost("http://127.0.0.1:1234/v1")).toBe("127.0.0.1");
  });
  it("refuses what is not a URL, or a host that looks like a secret", () => {
    expect(endpointHost(undefined)).toBeUndefined();
    expect(endpointHost("not a url")).toBeUndefined();
    expect(
      endpointHost("https://sk-ant-abcdefghijklmnopqrstuvwxyz.example.com"),
    ).toBeUndefined();
  });
});

describe("response shape", () => {
  it("hashes key structure, never values", () => {
    const a = { id: "x1", choices: [{ message: { content: "secret one" } }] };
    const b = { id: "y2", choices: [{ message: { content: "other" } }] };
    expect(responseShape(a)).not.toContain("secret");
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
    expect(fingerprintOf(a)).not.toBe(fingerprintOf({ id: "x1" }));
  });
});

describe("recordProbe", () => {
  it("accumulates while the fingerprint holds and restarts when it changes", () => {
    const file = tmp();
    recordProbe(base, file);
    const two = recordProbe({ ...base, now: "2026-11-12" }, file);
    expect(two).toMatchObject({ k: 2, n: 2, firstSeen: "2026-11-11" });
    const mixed = recordProbe(
      { ...base, outcome: "text", dialect: "qwen-xml" },
      file,
    );
    expect(mixed).toMatchObject({
      value: "native",
      k: 2,
      n: 3,
      dialect: "qwen-xml",
    });
    const changed = recordProbe({ ...base, fingerprint: "zzz" }, file);
    expect(changed).toMatchObject({ k: 1, n: 1 });
    expect(readMeasuredEntries(file)).toHaveLength(1);
  });

  it("writes nothing without a usable host, and no key or URL ever", () => {
    const file = tmp();
    expect(recordProbe({ ...base, apiBase: undefined }, file)).toBeUndefined();
    recordProbe({ ...base, apiBase: "http://u:p@h.lan/v1?k=sk-123" }, file);
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/sk-123|u:p|http|\/v1/);
  });

  it.skipIf(process.platform === "win32")("is owner-only", () => {
    const file = tmp();
    recordProbe(base, file);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("expires after 30 days and says so in the status", () => {
    const file = tmp();
    recordProbe(base, file);
    const q = { provider: "lmstudio", apiBase: base.apiBase, model: "m" };
    expect(probeStatusFor(q, "2026-11-20", file)).toMatchObject({
      kind: "native",
      n: 1,
    });
    expect(probeStatusFor(q, "2026-12-30", file).stale).toBe(true);
    expect(
      probeStatusFor({ ...q, model: "other" }, "2026-11-20", file),
    ).toEqual({ kind: "unknown" });
  });
});

describe("the evidence floor for a local probe", () => {
  const strongRow: SurfaceRow = {
    id: "lmstudio-measured",
    provider: "lmstudio",
    engine: "*",
    api: "openai-chat",
    facts: {
      toolsHonoured: {
        value: true,
        level: "measured",
        source: "run",
        readOn: "2026-11-01",
        k: 8,
        n: 8,
      },
    },
  };
  const query = { provider: "lmstudio", api: "openai-chat" };

  it("a single probe is declared-weak and unlocks nothing that needs n >= 8", () => {
    const entry = withProbe(undefined, base, "box.lan");
    const facts = measuredFactsOf(entry);
    expect(facts.toolsHonoured).toMatchObject({
      level: "declared",
      k: 1,
      n: 1,
    });
    const r = resolveFact("toolsHonoured", {
      ...query,
      rows: [],
      measured: facts,
      now: "2026-11-12",
    });
    expect(r.layer).toBe("measured");
    expect(actionAllowed("enableTools", r)).toBe(false);
    expect(actionAllowed("enableRecovery", r)).toBe(false);
  });

  it("a weak probe does not outrank a stronger surface fact", () => {
    const facts = measuredFactsOf(
      withProbe(undefined, { ...base, outcome: "text" }, "box.lan"),
    );
    const r = resolveFact("toolsHonoured", {
      ...query,
      rows: [strongRow],
      measured: facts,
    });
    expect(r).toMatchObject({
      layer: "surface",
      value: true,
      level: "measured",
    });
  });

  it("n probes that all agree become measured, and may enable tools only then", () => {
    let e = withProbe(undefined, base, "box.lan");
    for (let i = 1; i < ENABLE_TOOLS_MIN_N; i++) {
      e = withProbe(e, base, "box.lan");
    }
    const r = resolveFact("toolsHonoured", {
      ...query,
      rows: [],
      measured: measuredFactsOf(e),
      now: "2026-11-12",
    });
    expect(r.level).toBe("measured");
    expect(actionAllowed("enableTools", r)).toBe(true);
    expect(actionAllowed("enableRecovery", r)).toBe(false);
  });
});

describe("recordingEnabled", () => {
  it("is on by default and off with probes.record: false", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const file = join(dir, "config.yaml");
    expect(recordingEnabled(file)).toBe(true);
    writeFileSync(file, "name: x\nprobes:\n  record: false\n");
    expect(recordingEnabled(file)).toBe(false);
    writeFileSync(file, "name: x\n");
    expect(recordingEnabled(file)).toBe(true);
  });
});
