import { afterEach, describe, expect, it } from "vitest";
import { secretCases } from "../../util/secretScan/fixtures";
import { fetchUrlContentTool } from "../definitions/fetchUrlContent";
import { searchWebTool } from "../definitions/searchWeb";
import { evaluateToolPolicyWithRules, type EvaluateInput } from "./evaluate";
import {
  normalizePolicy,
  POLICY_AREAS,
  POLICY_LEVELS,
  POLICY_PRESET_ORDER,
  POLICY_PRESET_WEB,
  POLICY_PRESETS,
  presetOf,
  withoutReviewer,
  type PolicyLevels,
  type WebLevel,
  WEB_LEVELS,
} from "./policy";
import { applyPolicyUpdate, parsePolicyFile } from "./settingsFile";
import {
  WebGrantStore,
  webGrantsFor,
  resetWebGrantsForTests,
} from "./webGrants";
import {
  capWebAtDefault,
  decideWebCall,
  decideWebRedirect,
  effectiveWebLevel,
  urlsInUserMessages,
  webCallContext,
  webHeadlessLine,
  webPolicyAlias,
  withholdWebTools,
  type WebCallFacts,
  type WebOutcome,
} from "./webPolicy";

afterEach(() => resetWebGrantsForTests());

const careful = POLICY_PRESETS.careful.levels;
const withWeb = (web: WebLevel | undefined): PolicyLevels =>
  web === undefined ? { ...careful } : { ...careful, web };

// ---------------------------------------------------------------------------
// The level table (section 8.2), as decided by the pure decision order

type Situation =
  | "allowed host"
  | "other host"
  | "granted host"
  | "URL in message"
  | "robots disallow"
  | "private start"
  | "confusable host"
  | "reputation hit";

const SITUATIONS: Record<Situation, Partial<WebCallFacts>> = {
  "allowed host": { hostAllowed: { reason: "Allowed by your rule." } },
  "other host": {},
  "granted host": { sessionGrant: true },
  "URL in message": { urlInUserMessage: true },
  "robots disallow": {
    protection: { kind: "robots", reason: "robots.txt disallows this URL" },
  },
  "private start": {
    protection: { kind: "private", reason: "a private network address" },
  },
  "confusable host": {
    protection: { kind: "confusable", reason: "a confusable host name" },
  },
  "reputation hit": {
    protection: { kind: "reputation", reason: "a reputation list names it" },
  },
};

/** The table, row by row: what each level does in each situation. */
const TABLE: Record<WebLevel, Record<Situation, WebOutcome>> = {
  off: {
    "allowed host": "withheld",
    "other host": "withheld",
    "granted host": "withheld",
    "URL in message": "withheld",
    "robots disallow": "withheld",
    "private start": "withheld",
    "confusable host": "withheld",
    "reputation hit": "withheld",
  },
  manual: {
    "allowed host": "ask",
    "other host": "ask",
    "granted host": "ask",
    "URL in message": "ask",
    "robots disallow": "ask",
    "private start": "ask",
    "confusable host": "ask",
    "reputation hit": "ask",
  },
  cautious: {
    "allowed host": "run",
    "other host": "ask",
    "granted host": "run",
    "URL in message": "run",
    "robots disallow": "ask",
    "private start": "ask",
    "confusable host": "ask",
    "reputation hit": "ask",
  },
  listed: {
    "allowed host": "run",
    "other host": "refused",
    "granted host": "refused",
    "URL in message": "refused",
    "robots disallow": "refused",
    "private start": "refused",
    "confusable host": "refused",
    "reputation hit": "refused",
  },
  automatic: {
    "allowed host": "run",
    "other host": "review",
    "granted host": "run",
    "URL in message": "run",
    // The reviewer never decides these: they ask the person
    "robots disallow": "ask",
    "private start": "ask",
    "confusable host": "ask",
    "reputation hit": "ask",
  },
  permissive: {
    "allowed host": "run",
    "other host": "run",
    "granted host": "run",
    "URL in message": "run",
    "robots disallow": "ask",
    "private start": "ask",
    "confusable host": "ask",
    "reputation hit": "ask",
  },
  idgaf: {
    "allowed host": "run",
    "other host": "run",
    "granted host": "run",
    "URL in message": "run",
    "robots disallow": "run",
    "private start": "run",
    "confusable host": "run",
    "reputation hit": "run",
  },
};

describe("the Web level table (8.2)", () => {
  for (const level of WEB_LEVELS) {
    for (const [situation, facts] of Object.entries(SITUATIONS)) {
      const expected = TABLE[level][situation as Situation];
      it(`${level}, ${situation}: ${expected}`, () => {
        const d = decideWebCall({ level, host: "docs.example", ...facts });
        expect(d.outcome).toBe(expected);
        expect(d.reason).toBeTruthy();
      });
    }
  }

  it("IDGAF records what it ran past", () => {
    const d = decideWebCall({
      level: "idgaf",
      host: "docs.example",
      ...SITUATIONS["robots disallow"],
    });
    expect(d.recorded).toContain("robots.txt disallows");
  });

  it("Listed says why and that retrying unchanged will not help", () => {
    const d = decideWebCall({ level: "listed", host: "new.example" });
    expect(d.reason).toContain("new.example");
    expect(d.reason).toContain("never asks");
    expect(d.reason).toContain("Do not retry it unchanged");
  });

  it("a deny rule and a session block refuse below IDGAF, and IDGAF runs past them", () => {
    for (const level of WEB_LEVELS.filter((l) => l !== "off")) {
      const denied = decideWebCall({ level, denied: "Blocked by host:x." });
      const blocked = decideWebCall({ level, sessionBlock: true });
      const want = level === "idgaf" ? "run" : "refused";
      expect(denied.outcome).toBe(want);
      expect(blocked.outcome).toBe(want);
    }
  });

  it("an ask rule asks, and is refused at Listed", () => {
    for (const level of WEB_LEVELS.filter((l) => l !== "off")) {
      const d = decideWebCall({
        level,
        askRule: "Your rule asks.",
        hostAllowed: { reason: "allowed" },
      });
      const want =
        level === "idgaf" ? "run" : level === "listed" ? "refused" : "ask";
      expect(d.outcome).toBe(want);
    }
  });

  it("the tool's own setting runs it, except at Listed and Manual", () => {
    const run = (level: WebLevel) =>
      decideWebCall({ level, toolSettingRuns: true }).outcome;
    expect(run("cautious")).toBe("run");
    expect(run("automatic")).toBe("run");
    expect(run("permissive")).toBe("run");
    expect(run("listed")).toBe("refused");
    expect(run("manual")).toBe("ask");
  });
});

describe("redirect to an unseen host, by level", () => {
  it("follows the table", () => {
    const want: Record<WebLevel, string> = {
      off: "refused",
      manual: "ask",
      cautious: "ask",
      listed: "refused",
      automatic: "review",
      permissive: "follow-labelled",
      idgaf: "follow-labelled",
    };
    for (const level of WEB_LEVELS) {
      expect(decideWebRedirect(level, { hostSeen: false })).toBe(want[level]);
    }
  });

  it("a seen host is followed below Off, and unattended asks are refused", () => {
    for (const level of WEB_LEVELS.filter((l) => l !== "off")) {
      expect(decideWebRedirect(level, { hostSeen: true })).toBe("follow");
    }
    expect(
      decideWebRedirect("cautious", { hostSeen: false, unattended: true }),
    ).toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// Hard checks: bind at every level, IDGAF included (8.6)

describe("hard checks at IDGAF", () => {
  it("the fetch's own refusal, a floor rule and robots respect bind at IDGAF", () => {
    for (const level of WEB_LEVELS.filter((l) => l !== "off")) {
      expect(decideWebCall({ level, hardRefusal: "Refused: x." }).outcome).toBe(
        "refused",
      );
      expect(
        decideWebCall({ level, floorRule: "host:evil.example" }).outcome,
      ).toBe("refused");
      expect(
        decideWebCall({ level, robotsRespectDisallow: true }).outcome,
      ).toBe("refused");
    }
  });

  const fetchAt = (
    url: string,
    levels: PolicyLevels,
    extra: Partial<EvaluateInput> = {},
  ) =>
    evaluateToolPolicyWithRules({
      tool: fetchUrlContentTool,
      toolName: "fetch_url_content",
      basePolicy: "allowedWithPermission",
      parsedArgs: { url },
      permissions: undefined,
      approval: { levels },
      ...extra,
    });

  const idgaf = POLICY_PRESETS.idgaf.levels;

  it("cloud metadata addresses are refused at IDGAF, in every spelling", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/",
      "http://[64:ff9b::169.254.169.254]/",
      "http://[fd00:ec2::254]/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://METADATA.GOOGLE.INTERNAL./",
      "http://100.100.100.200/",
      "http://2852039166/",
    ]) {
      const r = fetchAt(url, idgaf);
      expect(r.policy, url).toBe("disabled");
      expect(r.source, url).toBe("safety-floor");
      expect(r.reason, url).toContain("cloud metadata");
      expect(r.idgafOverride, url).toBeUndefined();
    }
  });

  it("a credential in the URL, userinfo and a non-http scheme are refused at IDGAF", () => {
    const key = secretCases().find((c) => c.ruleId === "github-pat")!.value;
    expect(fetchAt(`https://example.com/?k=${key}`, idgaf).policy).toBe(
      "disabled",
    );
    expect(fetchAt("https://user:pw@example.com/", idgaf).policy).toBe(
      "disabled",
    );
    expect(fetchAt("ftp://example.com/x", idgaf).policy).toBe("disabled");
  });

  it("the person's floor rule binds at IDGAF on Web", () => {
    const r = fetchAt("https://evil.example/", idgaf, {
      approval: { levels: idgaf, floor: ["fetchUrl(https://evil.example/*)"] },
    });
    expect(r.policy).toBe("disabled");
    expect(r.source).toBe("floor");
    expect(r.reason).toContain("floor rule");
  });

  it("a private start URL runs at IDGAF and is recorded", () => {
    const r = fetchAt("http://10.0.0.5/", idgaf);
    expect(r.policy).toBe("allowedWithoutPermission");
    expect(r.idgafOverride?.protection).toBe("private-url");
  });

  it("a deny rule is ignored at IDGAF on Web (it is recorded)", () => {
    const r = fetchAt("https://blocked.example/", idgaf, {
      permissions: { deny: ["fetchUrl(https://blocked.example/*)"] },
    });
    expect(r.policy).toBe("allowedWithoutPermission");
    expect(r.idgafOverride?.policy).toBe("disabled");
  });

  it("metadata is refused at every level, not asked as a private address", () => {
    for (const preset of POLICY_PRESET_ORDER) {
      const r = fetchAt(
        "http://169.254.169.254/",
        POLICY_PRESETS[preset].levels,
      );
      expect(r.policy, preset).toBe("disabled");
    }
    // A caller that sends no levels at all gets the refusal too
    const bare = evaluateToolPolicyWithRules({
      tool: fetchUrlContentTool,
      toolName: "fetch_url_content",
      basePolicy: "allowedWithPermission",
      parsedArgs: { url: "http://169.254.169.254/" },
      permissions: undefined,
    });
    expect(bare.policy).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// Presets, Custom and the fallback to Tool use

describe("presets set Web", () => {
  it("Careful and Accept edits are Cautious, Hands off Permissive, Reviewer Automatic, IDGAF IDGAF", () => {
    expect(POLICY_PRESET_WEB).toEqual({
      careful: "cautious",
      acceptEdits: "cautious",
      handsOff: "permissive",
      reviewer: "automatic",
      idgaf: "idgaf",
    });
  });

  it("each preset's Web level is what following its Tool use gives", () => {
    for (const name of POLICY_PRESET_ORDER) {
      expect(effectiveWebLevel(POLICY_PRESETS[name].levels).level).toBe(
        POLICY_PRESET_WEB[name],
      );
    }
  });

  it("an absent Web matches the preset; the preset's own Web level matches too", () => {
    for (const name of POLICY_PRESET_ORDER) {
      const levels = POLICY_PRESETS[name].levels;
      expect(presetOf(levels)).toBe(name);
      expect(presetOf({ ...levels, web: POLICY_PRESET_WEB[name] })).toBe(name);
    }
  });

  it("Off and Listed make the chip read Custom", () => {
    for (const name of POLICY_PRESET_ORDER) {
      for (const web of ["off", "listed"] as const) {
        expect(presetOf({ ...POLICY_PRESETS[name].levels, web })).toBe(
          undefined,
        );
      }
    }
    // Another preset's Web level is Custom as well
    expect(presetOf({ ...careful, web: "permissive" })).toBe(undefined);
  });
});

describe("unset Web follows Tool use", () => {
  it("for every shared level", () => {
    for (const tools of POLICY_LEVELS) {
      const w = effectiveWebLevel({ ...careful, tools });
      expect(w).toEqual({ level: tools, source: "tools" });
    }
  });

  it("no levels at all is Cautious, as for every area", () => {
    expect(effectiveWebLevel(undefined).level).toBe("cautious");
  });

  it("a set Web level wins, and web.enabled: false wins over both", () => {
    expect(effectiveWebLevel(withWeb("listed"))).toEqual({
      level: "listed",
      source: "levels.web",
    });
    expect(
      effectiveWebLevel(withWeb("permissive"), { enabled: false }),
    ).toEqual({ level: "off", source: "web.enabled" });
  });

  it("no saved setting changes meaning: a fetch at the old levels decides as before", () => {
    // Careful, no rules: the fetch tool asks, as it always did
    const r = evaluateToolPolicyWithRules({
      tool: fetchUrlContentTool,
      toolName: "fetch_url_content",
      basePolicy: "allowedWithPermission",
      parsedArgs: { url: "https://docs.example.com/" },
      permissions: undefined,
      approval: { levels: careful },
    });
    expect(r.policy).toBe("allowedWithPermission");
    // Hands off runs it, Manual asks
    expect(
      evaluateToolPolicyWithRules({
        tool: fetchUrlContentTool,
        toolName: "fetch_url_content",
        basePolicy: "allowedWithPermission",
        parsedArgs: { url: "https://docs.example.com/" },
        permissions: undefined,
        approval: { levels: POLICY_PRESETS.handsOff.levels },
      }).policy,
    ).toBe("allowedWithoutPermission");
  });

  it("normalizePolicy keeps a Web level and reports an unknown one", () => {
    const ok = normalizePolicy({ levels: { web: "Listed" } });
    expect(ok.policy.levels.web).toBe("listed");
    expect(ok.problems).toEqual([]);
    const bad = normalizePolicy({ levels: { web: "sometimes" } });
    expect(bad.policy.levels.web).toBeUndefined();
    expect(bad.problems[0]).toContain("follows Tool use");
    // Off and Listed are Web levels only
    const tools = normalizePolicy({ levels: { tools: "listed" } });
    expect(tools.policy.levels.tools).toBe("cautious");
    expect(tools.problems).toHaveLength(1);
  });

  it("without a reviewer, Automatic on Web is Cautious", () => {
    const p = withoutReviewer({ levels: withWeb("automatic") });
    expect(p.levels.web).toBe("cautious");
  });

  it("--safe caps Web at Cautious and keeps the tighter levels", () => {
    expect(capWebAtDefault("permissive")).toBe("cautious");
    expect(capWebAtDefault("idgaf")).toBe("cautious");
    expect(capWebAtDefault("automatic")).toBe("cautious");
    for (const l of ["off", "listed", "manual", "cautious"] as const) {
      expect(capWebAtDefault(l)).toBe(l);
    }
    expect(capWebAtDefault(undefined)).toBeUndefined();
  });

  it("web.policy, WB27's placeholder, is read as levels.web with a notice", () => {
    expect(webPolicyAlias("listed").level).toBe("listed");
    expect(webPolicyAlias("listed").notice).toContain("deprecated");
    expect(webPolicyAlias("idgaf").level).toBeUndefined();
    expect(webPolicyAlias({ mode: "x" }).notice).toContain("ignored");
    expect(effectiveWebLevel(careful, { policyAlias: "listed" })).toEqual({
      level: "listed",
      source: "web.policy",
    });
    // levels.web wins over the alias
    expect(
      effectiveWebLevel(withWeb("manual"), { policyAlias: "listed" }).level,
    ).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// The two off switches

describe("off switches", () => {
  const fetch = (levels: PolicyLevels, extra: Partial<EvaluateInput> = {}) =>
    evaluateToolPolicyWithRules({
      tool: fetchUrlContentTool,
      toolName: "fetch_url_content",
      basePolicy: "allowedWithPermission",
      parsedArgs: { url: "https://docs.example.com/" },
      permissions: { allow: ["fetchUrl"] },
      approval: { levels },
      ...extra,
    });

  it("levels.web: off refuses a web call that still arrives, at every Tool use level", () => {
    for (const tools of POLICY_LEVELS) {
      const r = fetch({ ...careful, tools, web: "off" });
      expect(r.policy, tools).toBe("disabled");
      expect(r.reason).toContain("Web is Off");
    }
  });

  it("levels.web: off leaves other tools alone", () => {
    const r = evaluateToolPolicyWithRules({
      tool: { readonly: true } as never,
      toolName: "read_file",
      basePolicy: "allowedWithoutPermission",
      parsedArgs: { filepath: "a.ts" },
      permissions: undefined,
      approval: { levels: withWeb("off") },
    });
    expect(r.policy).toBe("allowedWithoutPermission");
  });

  it("web.enabled: false refuses at every level, IDGAF included, and names the setting", () => {
    for (const name of POLICY_PRESET_ORDER) {
      const r = fetch(POLICY_PRESETS[name].levels, {
        web: { enabled: false },
      });
      expect(r.policy, name).toBe("disabled");
      expect(r.reason).toContain("web.enabled: false");
    }
  });

  it("search is refused too when Off", () => {
    const r = evaluateToolPolicyWithRules({
      tool: searchWebTool,
      toolName: "search_web",
      basePolicy: "allowedWithPermission",
      parsedArgs: { query: "vitest" },
      permissions: undefined,
      approval: { levels: withWeb("off") },
    });
    expect(r.policy).toBe("disabled");
  });

  it("a tool the person switched off stays as it is", () => {
    const r = fetch(withWeb("idgaf"), { basePolicy: "disabled" });
    expect(r.policy).toBe("disabled");
  });

  it("withholdWebTools drops only the web tools", () => {
    const tools = [
      { function: { name: "read_file" } },
      { function: { name: "fetch_url_content" } },
      { function: { name: "search_web" } },
    ];
    expect(withholdWebTools(tools, true).map((t) => t.function.name)).toEqual([
      "read_file",
    ]);
    expect(withholdWebTools(tools, false)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The level table through the permission layer

describe("the level table through evaluate", () => {
  const evaluate = (
    level: WebLevel,
    url: string,
    extra: Partial<EvaluateInput> = {},
  ) =>
    evaluateToolPolicyWithRules({
      tool: fetchUrlContentTool,
      toolName: "fetch_url_content",
      basePolicy: "allowedWithPermission",
      parsedArgs: { url },
      permissions: { allow: ["fetchUrl(https://allowed.example/*)"] },
      approval: { levels: withWeb(level) },
      ...extra,
    }).policy;

  const RUN = "allowedWithoutPermission";
  const ASK = "allowedWithPermission";
  const NO = "disabled";

  it("allowed host", () => {
    const url = "https://allowed.example/page";
    expect(evaluate("manual", url)).toBe(ASK);
    expect(evaluate("cautious", url)).toBe(RUN);
    expect(evaluate("listed", url)).toBe(RUN);
    expect(evaluate("automatic", url)).toBe(RUN);
    expect(evaluate("permissive", url)).toBe(RUN);
    expect(evaluate("idgaf", url)).toBe(RUN);
    expect(evaluate("off", url)).toBe(NO);
  });

  it("other host", () => {
    const url = "https://other.example/page";
    expect(evaluate("manual", url)).toBe(ASK);
    expect(evaluate("cautious", url)).toBe(ASK);
    expect(evaluate("listed", url)).toBe(NO);
    // Automatic hands the open call to the reviewer, which the caller asks
    expect(evaluate("automatic", url)).toBe(ASK);
    expect(evaluate("permissive", url)).toBe(RUN);
    expect(evaluate("idgaf", url)).toBe(RUN);
  });

  it("granted host: Cautious runs it, Listed does not", () => {
    const grants = new WebGrantStore();
    grants.allowOnce("granted.example");
    const url = "https://granted.example/page";
    expect(evaluate("cautious", url, { web: { grants } })).toBe(RUN);
    expect(evaluate("automatic", url, { web: { grants } })).toBe(RUN);
    expect(evaluate("listed", url, { web: { grants } })).toBe(NO);
    expect(evaluate("manual", url, { web: { grants } })).toBe(ASK);
    // Another host is not granted by it
    expect(
      evaluate("cautious", "https://api.granted.example/", { web: { grants } }),
    ).toBe(ASK);
  });

  it("the exact URL in the person's message runs at Cautious", () => {
    const url = "https://docs.example.org/guide/install";
    const web = webCallContext({
      userMessages: [`Read ${url}, then summarise it.`],
    });
    expect(evaluate("cautious", url, { web })).toBe(RUN);
    expect(evaluate("listed", url, { web })).toBe(NO);
    expect(evaluate("manual", url, { web })).toBe(ASK);
    // A different path on the same host is not the URL they wrote
    expect(
      evaluate("cautious", "https://docs.example.org/other", { web }),
    ).toBe(ASK);
  });

  it("private start asks below IDGAF and is refused at Listed", () => {
    const url = "http://10.0.0.5/";
    const allowAll = { permissions: { allow: ["fetchUrl"] } };
    expect(evaluate("cautious", url, allowAll)).toBe(ASK);
    expect(evaluate("permissive", url, allowAll)).toBe(ASK);
    expect(evaluate("automatic", url, allowAll)).toBe(ASK);
    expect(evaluate("listed", url, allowAll)).toBe(NO);
    expect(evaluate("idgaf", url, allowAll)).toBe(RUN);
  });

  it("a session block refuses below IDGAF", () => {
    const grants = new WebGrantStore();
    grants.blockOnce("allowed.example");
    const url = "https://allowed.example/page";
    for (const level of [
      "manual",
      "cautious",
      "listed",
      "automatic",
      "permissive",
    ] as const) {
      expect(evaluate(level, url, { web: { grants } }), level).toBe(NO);
    }
    expect(evaluate("idgaf", url, { web: { grants } })).toBe(RUN);
  });

  it("trustedDomains stands in for host: allow rules until WB21, at Cautious too", () => {
    const url = "https://docs.trusted.example/x";
    const extra = {
      permissions: undefined,
      trustedDomains: ["trusted.example"],
    };
    expect(evaluate("cautious", url, extra)).toBe(RUN);
    expect(evaluate("listed", url, extra)).toBe(RUN);
    expect(evaluate("automatic", url, extra)).toBe(RUN);
    expect(evaluate("manual", url, extra)).toBe(ASK);
    // Not trusted: the level decides (and ask-unknown-host asks)
    expect(evaluate("listed", "https://other.example/", extra)).toBe(NO);
    expect(evaluate("cautious", "https://other.example/", extra)).toBe(ASK);
    expect(evaluate("permissive", "https://other.example/", extra)).toBe(ASK);
    // Whole labels: a look-alike is not the trusted domain
    expect(evaluate("cautious", "https://eviltrusted.example/", extra)).toBe(
      ASK,
    );
  });

  it("host: allow rules from the person's permissions.yaml, on whole labels", () => {
    const web = { hostAllow: ["host:docs.example.com", "host:*.cdn.example"] };
    const ok = (url: string, level: WebLevel = "cautious") =>
      evaluate(level, url, { permissions: undefined, web });
    expect(ok("https://docs.example.com/a")).toBe(RUN);
    expect(ok("https://docs.example.com/a", "listed")).toBe(RUN);
    expect(ok("https://DOCS.example.com./a")).toBe(RUN);
    // The exact host only
    expect(ok("https://example.com/")).toBe(ASK);
    expect(ok("https://api.docs.example.com/")).toBe(ASK);
    expect(ok("https://evil-docs.example.com/")).toBe(ASK);
    expect(ok("https://docs.example.com.evil.test/")).toBe(ASK);
    // `*.` is subdomains only, never the domain itself or part of a label
    expect(ok("https://a.b.cdn.example/")).toBe(RUN);
    expect(ok("https://cdn.example/")).toBe(ASK);
    expect(ok("https://xcdn.example/")).toBe(ASK);
    expect(ok("https://other.example/", "listed")).toBe(NO);
  });

  it("search counts its configured backend as an allowed domain", () => {
    const search = (level: WebLevel) =>
      evaluateToolPolicyWithRules({
        tool: searchWebTool,
        toolName: "search_web",
        basePolicy: "allowedWithPermission",
        parsedArgs: { query: "vitest docs" },
        permissions: undefined,
        approval: { levels: withWeb(level) },
      }).policy;
    expect(search("cautious")).toBe(RUN);
    expect(search("listed")).toBe(RUN);
    expect(search("manual")).toBe(ASK);
  });

  it("a Web level of its own leaves Tool use alone, and the other way round", () => {
    // Tools Permissive, Web Listed: an unlisted host is refused
    const levels: PolicyLevels = {
      ...POLICY_PRESETS.handsOff.levels,
      web: "listed",
    };
    expect(
      evaluateToolPolicyWithRules({
        tool: fetchUrlContentTool,
        toolName: "fetch_url_content",
        basePolicy: "allowedWithPermission",
        parsedArgs: { url: "https://other.example/" },
        permissions: undefined,
        approval: { levels },
      }).policy,
    ).toBe(NO);
    // Tools Cautious, Web Permissive: the fetch runs, with Web named
    const r = evaluateToolPolicyWithRules({
      tool: fetchUrlContentTool,
      toolName: "fetch_url_content",
      basePolicy: "allowedWithPermission",
      parsedArgs: { url: "https://other.example/" },
      permissions: undefined,
      approval: { levels: withWeb("permissive") },
    });
    expect(r.policy).toBe(RUN);
    expect(r.reason).toContain("Web is Permissive");
  });
});

// ---------------------------------------------------------------------------
// Headless: asks are refused, so Cautious acts as Listed

describe("unattended", () => {
  it("Cautious acts as Listed on every situation that would ask", () => {
    for (const [situation, facts] of Object.entries(SITUATIONS)) {
      const listed = decideWebCall({ level: "listed", ...facts }).outcome;
      const cautious = decideWebCall({
        level: "cautious",
        unattended: true,
        ...facts,
      }).outcome;
      // The person's own grant and words still run; nothing else that asks does
      if (situation === "granted host" || situation === "URL in message") {
        expect(cautious).toBe("run");
      } else {
        expect(cautious, situation).toBe(listed);
      }
    }
  });

  it("an unattended ask is refused with the reason", () => {
    const d = decideWebCall({
      level: "cautious",
      host: "new.example",
      unattended: true,
    });
    expect(d.outcome).toBe("refused");
    expect(d.reason).toContain("new.example");
    expect(d.reason).toContain("unattended");
  });

  it("the start-up line says so", () => {
    expect(webHeadlessLine(effectiveWebLevel(careful))).toBe(
      "Web Cautious (unattended: only allowed domains)",
    );
    expect(
      webHeadlessLine(effectiveWebLevel(careful, { enabled: false })),
    ).toBe("Web Off (config.yaml: web.enabled)");
    expect(webHeadlessLine(effectiveWebLevel(withWeb("listed")))).toBe(
      "Web Listed",
    );
    expect(webHeadlessLine(effectiveWebLevel(withWeb("manual")))).toContain(
      "every fetch refused",
    );
  });

  it("a host that passes unattended in the context is refused in the layer", () => {
    const r = evaluateToolPolicyWithRules({
      tool: fetchUrlContentTool,
      toolName: "fetch_url_content",
      basePolicy: "allowedWithPermission",
      parsedArgs: { url: "https://new.example/" },
      permissions: undefined,
      approval: { levels: careful },
      web: { unattended: true },
    });
    expect(r.policy).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// Grants

describe("session grants", () => {
  it("allow and block replace each other, by exact host, normalised", () => {
    const g = new WebGrantStore();
    g.allowOnce("Docs.Example.COM.");
    expect(g.isGranted("docs.example.com")).toBe(true);
    expect(g.isGranted("example.com")).toBe(false);
    g.blockOnce("docs.example.com");
    expect(g.isGranted("docs.example.com")).toBe(false);
    expect(g.isBlocked("docs.example.com")).toBe(true);
    g.remove("docs.example.com");
    expect(g.list()).toEqual({ granted: [], blocked: [] });
  });

  it("each session has its own store", () => {
    webGrantsFor("a").allowOnce("x.example");
    expect(webGrantsFor("a").isGranted("x.example")).toBe(true);
    expect(webGrantsFor("b").isGranted("x.example")).toBe(false);
  });
});

describe("URLs in the person's messages", () => {
  it("finds them, drops closing punctuation and canonicalises", () => {
    expect(
      urlsInUserMessages([
        "See https://Example.com/a?b=1. And (https://x.example/y).",
        "not a url: ftp://x.example",
      ]),
    ).toEqual(["https://example.com/a?b=1", "https://x.example/y"]);
  });
});

// ---------------------------------------------------------------------------
// permissions.yaml: levels.web

describe("levels.web in permissions.yaml", () => {
  it("is read, Off and Listed included", () => {
    expect(
      parsePolicyFile("levels:\n  web: listed\n").settings.levels.web,
    ).toBe("listed");
    expect(parsePolicyFile("levels:\n  web: off\n").settings.levels.web).toBe(
      "off",
    );
  });

  it("is absent when not written, so Web follows Tool use", () => {
    const { settings, notices } = parsePolicyFile(
      "levels:\n  tools: cautious\n",
    );
    expect(settings.levels.web).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it("IDGAF is never read from disk, and an unknown value is reported", () => {
    const idgaf = parsePolicyFile("levels:\n  web: idgaf\n");
    expect(idgaf.settings.levels.web).toBeUndefined();
    expect(idgaf.notices[0]).toContain("one session only");
    const odd = parsePolicyFile("levels:\n  web: sometimes\n");
    expect(odd.settings.levels.web).toBeUndefined();
    expect(odd.notices[0]).toContain("follows Tool use");
  });

  it("is written, never as IDGAF, and cleared by undefined; left out it is kept", () => {
    const written = applyPolicyUpdate("", { levels: withWeb("listed") });
    expect(parsePolicyFile(written).settings.levels.web).toBe("listed");
    const kept = applyPolicyUpdate(written, { levels: { ...careful } });
    expect(parsePolicyFile(kept).settings.levels.web).toBe("listed");
    const cleared = applyPolicyUpdate(written, {
      levels: { ...careful, web: undefined },
    });
    expect(parsePolicyFile(cleared).settings.levels.web).toBeUndefined();
    const idgaf = applyPolicyUpdate(written, { levels: withWeb("idgaf") });
    expect(parsePolicyFile(idgaf).settings.levels.web).toBe("listed");
  });

  it("the five areas keep their own levels whatever Web is", () => {
    const { settings } = parsePolicyFile(
      "levels:\n  tools: permissive\n  web: listed\n",
    );
    for (const area of POLICY_AREAS) {
      expect(settings.levels[area]).toBeDefined();
    }
    expect(settings.levels.tools).toBe("permissive");
  });
});

// ---------------------------------------------------------------------------
// No built-in pre-approved domains (Claude Code's CVE-2026-54316 came from one)

describe("no host is allowed without the person", () => {
  const POPULAR = [
    "github.com",
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    "docs.python.org",
    "developer.mozilla.org",
    "www.npmjs.com",
    "registry.npmjs.org",
    "pypi.org",
    "docs.anthropic.com",
    "platform.claude.com",
    "docs.continue.dev",
    "stackoverflow.com",
    "en.wikipedia.org",
    "www.google.com",
    "learn.microsoft.com",
    "docs.rs",
    "pkg.go.dev",
    "localhost",
  ];

  const at = (
    level: WebLevel,
    host: string,
    extra: Partial<EvaluateInput> = {},
  ) =>
    evaluateToolPolicyWithRules({
      tool: fetchUrlContentTool,
      toolName: "fetch_url_content",
      basePolicy: "allowedWithPermission",
      parsedArgs: { url: `https://${host}/` },
      permissions: undefined,
      approval: { levels: withWeb(level) },
      ...extra,
    }).policy;

  it("at Cautious and Listed every host asks or is refused, with no rule, grant or list", () => {
    for (const host of POPULAR) {
      expect(at("cautious", host), host).toBe("allowedWithPermission");
      expect(at("listed", host), host).toBe("disabled");
      expect(at("manual", host), host).toBe("allowedWithPermission");
    }
  });

  it("an empty context, an empty grant store and empty lists allow nothing", () => {
    const web = webCallContext({
      grants: new WebGrantStore(),
      userMessages: [],
      hostAllow: [],
    });
    for (const host of POPULAR) {
      expect(at("listed", host, { web, trustedDomains: [] }), host).toBe(
        "disabled",
      );
    }
  });

  it("the decision has no host of its own: only facts the caller gives allow", () => {
    for (const host of POPULAR) {
      const d = decideWebCall({ level: "listed", host });
      expect(d.outcome, host).toBe("refused");
    }
  });

  it("only search, whose backend the person configured, counts as allowed by itself", () => {
    const search = evaluateToolPolicyWithRules({
      tool: searchWebTool,
      toolName: "search_web",
      basePolicy: "allowedWithPermission",
      parsedArgs: { query: "x" },
      permissions: undefined,
      approval: { levels: withWeb("listed") },
    });
    expect(search.reason).toContain("search backend you configured");
  });
});
