// Suites are data files in suites/; this module loads one and expands it into
// cases for a given model. A case is everything one request needs plus what
// to expect of the reply:
//   { id, suite, group, variant, mode: native|text, style, stream, temperature,
//     numPredict, think, messages, tools, sendTools, expect, meta, estOut }
import fs from "node:fs";
import path from "node:path";
import { LAB_ROOT } from "./paths.mjs";
import {
  fillTemplate,
  renderToolsPrompt,
  styleFor,
  TEXT_STYLES,
} from "./prompts.mjs";

export const SUITES_DIR = path.join(LAB_ROOT, "suites");
export const SUITE_NAMES = [
  "dialect-probe",
  "args-whitespace",
  "prompt-variants",
  "reviewer",
  "leaks",
  "cache",
];

export function loadSuite(nameOrFile) {
  const file = SUITE_NAMES.includes(nameOrFile)
    ? path.join(SUITES_DIR, `${nameOrFile}.json`)
    : path.resolve(nameOrFile);
  const suite = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!suite.suite || !suite.kind)
    throw new Error(`${file}: needs "suite" and "kind"`);
  return suite;
}

export function agentTools() {
  return JSON.parse(
    fs.readFileSync(
      path.join(LAB_ROOT, "fixtures", "agent-tools.json"),
      "utf8",
    ),
  );
}

/** `n` tools: the first n real agent tools, padded with plain synthetic ones. */
export function toolSet(n, real = agentTools()) {
  if (n === "agent") return real;
  if (n <= real.length) return real.slice(0, n);
  const pad = [];
  for (let i = real.length; i < n; i++) {
    const id = String(i + 1).padStart(2, "0");
    pad.push({
      name: `ext_tool_${id}`,
      description: `Synthetic padding tool ${id}: returns the value stored under a key.`,
      parameters: {
        type: "object",
        properties: { key: { type: "string", description: "Key to look up" } },
        required: ["key"],
      },
    });
  }
  return [...real, ...pad];
}

const csv = (v) =>
  v == null
    ? undefined
    : String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

function pick(arr, limit) {
  return limit && limit > 0 ? arr.slice(0, limit) : arr;
}

/** Cases of `limit` spread over the `expect` classes, in a stable order. */
function stratified(cases, limit) {
  if (!limit || limit >= cases.length) return cases;
  const groups = new Map();
  for (const c of cases) {
    const k = c.group;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = [];
  const lists = [...groups.values()];
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const l of lists)
      if (i < l.length && out.length < limit) {
        out.push(l[i]);
        any = true;
      }
    if (!any) break;
  }
  return out;
}

function textStyles(opts, preset) {
  const want = csv(opts.styles) ?? ["auto"];
  if (want.includes("all")) return TEXT_STYLES;
  return [...new Set(want.map((s) => (s === "auto" ? styleFor(preset) : s)))];
}

function base(suite, over) {
  const d = suite.defaults ?? {};
  return {
    suite: suite.suite,
    variant: null,
    style: null,
    stream: d.stream ?? false,
    temperature: d.temperature ?? 0,
    numPredict: d.numPredict ?? 400,
    numCtx: d.numCtx ?? 8192,
    think: false,
    estOut: suite.estOutTokens ?? 80,
    meta: {},
    ...over,
  };
}

function expandDialectProbe(suite, ctx) {
  const cases = [];
  const styles = textStyles(ctx.opts, ctx.preset);
  const modes = csv(ctx.opts.modes) ?? ["native", "text"];
  for (const p of suite.probes) {
    const tools = p.tools.map((n) => suite.tools[n]);
    const user = { role: "user", content: p.user };
    if (modes.includes("native"))
      cases.push(
        base(suite, {
          id: `${p.id}.native`,
          group: p.group,
          mode: "native",
          messages: [{ role: "system", content: suite.system }, user],
          tools,
          sendTools: true,
          expect: p.expect,
          meta: { probe: p.id },
        }),
      );
    if (modes.includes("text"))
      for (const style of styles)
        cases.push(
          base(suite, {
            id: `${p.id}.text-${style}`,
            group: p.group,
            mode: "text",
            style,
            messages: [
              {
                role: "system",
                content: `${suite.system}\n\n${renderToolsPrompt(style, tools)}`,
              },
              user,
            ],
            tools,
            sendTools: false,
            expect: p.expect,
            meta: { probe: p.id },
          }),
        );
  }
  return cases;
}

function expandPromptVariants(suite, ctx) {
  const variants = ctx.opts.variants
    ? JSON.parse(fs.readFileSync(path.resolve(ctx.opts.variants), "utf8"))
    : suite.variants;
  const deliveries = csv(ctx.opts.deliveries) ?? suite.deliveries ?? ["native"];
  const style = textStyles(ctx.opts, ctx.preset)[0];
  const cases = [];
  for (const t of suite.tasks)
    for (const v of variants)
      for (const delivery of v.delivery ? [v.delivery] : deliveries) {
        const sys = fillTemplate(v.system, suite.tools);
        const text = delivery === "text";
        cases.push(
          base(suite, {
            id: `${t.id}.${v.id}.${delivery}`,
            group: t.group,
            variant: v.id,
            mode: delivery,
            style: text ? style : null,
            messages: [
              {
                role: "system",
                content: text
                  ? `${sys}\n\n${renderToolsPrompt(style, suite.tools)}`
                  : sys,
              },
              { role: "user", content: t.user },
            ],
            tools: suite.tools,
            sendTools: !text,
            expect: t.expect,
            meta: { task: t.id },
          }),
        );
      }
  return cases;
}

function expandLeaks(suite, ctx) {
  const grid = ctx.opts.fullGrid ? suite.fullGrid : suite.defaultGrid;
  const counts =
    csv(ctx.opts.toolCounts)?.map((c) => (c === "agent" ? c : Number(c))) ??
    grid.toolCounts;
  const temps = csv(ctx.opts.temperatures)?.map(Number) ?? grid.temperatures;
  const streams =
    csv(ctx.opts.streams)?.map((s) => s === "true") ?? grid.streams;
  const real = ctx.agentTools ?? agentTools();
  const cases = [];
  for (const n of counts) {
    const tools = toolSet(n, real);
    for (const temperature of temps)
      for (const stream of streams)
        for (const p of suite.prompts) {
          if (!tools.some((t) => t.name === p.expectTool)) continue;
          cases.push(
            base(suite, {
              id: `${p.id}.n${n}.t${temperature}.${stream ? "stream" : "whole"}`,
              group: `tools=${n} t=${temperature} ${stream ? "stream" : "whole"}`,
              mode: "native",
              stream,
              temperature,
              messages: [
                { role: "system", content: suite.system },
                { role: "user", content: p.text },
              ],
              tools,
              sendTools: true,
              expect: { tool: p.expectTool },
              meta: { toolCount: n, prompt: p.id },
            }),
          );
        }
  }
  return cases;
}

function expandReviewer(suite, ctx) {
  const rev = ctx.product?.reviewer;
  let labelled = ctx.opts.dataset
    ? JSON.parse(fs.readFileSync(path.resolve(ctx.opts.dataset), "utf8"))
    : rev?.cases;
  if (!labelled)
    throw new Error(
      "reviewer suite needs the product (B4 set) or --dataset <file.json>",
    );
  const env = ctx.opts.dataset ? {} : rev.environment;
  if (!rev?.buildReviewMessages)
    throw new Error("reviewer suite needs the product's buildReviewMessages");
  const cases = labelled.map((c, i) =>
    base(suite, {
      id: c.id,
      group: c.expect,
      mode: "review",
      messages: rev.buildReviewMessages({
        toolName: c.tool,
        args: c.args,
        history: { userMessages: [c.request], toolCalls: [] },
        environment: {
          os: env.os,
          workspaceDirs: env.workspaceDirs,
          gitRemotes: env.gitRemotes,
        },
        settings: env.settings
          ? { environment: env.settings.environment }
          : undefined,
        nonce: `labnonce${String(i).padStart(4, "0")}`,
      }),
      tools: [],
      sendTools: false,
      expect: { review: c.expect, category: c.category },
      meta: { tool: c.tool },
    }),
  );
  return stratified(cases, ctx.opts.limit);
}

/** Same shape as the dialect probes, native tools only: the text arms add nothing here. */
const expandArgsWhitespace = (suite, ctx) =>
  expandDialectProbe(suite, {
    ...ctx,
    opts: { ...ctx.opts, modes: "native" },
  });

const EXPANDERS = {
  "dialect-probe": expandDialectProbe,
  "args-whitespace": expandArgsWhitespace,
  "prompt-variants": expandPromptVariants,
  leaks: expandLeaks,
  reviewer: expandReviewer,
};

/** ctx: { model, preset, product, opts, agentTools? } */
export function expandSuite(suite, ctx) {
  const f = EXPANDERS[suite.kind];
  if (!f) throw new Error(`unknown suite kind ${suite.kind}`);
  const cases = f(suite, { ...ctx, opts: ctx.opts ?? {} });
  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.id))
      throw new Error(`duplicate case id ${c.id} in ${suite.suite}`);
    seen.add(c.id);
  }
  return suite.kind === "reviewer" ? cases : pick(cases, ctx.opts?.limit);
}
