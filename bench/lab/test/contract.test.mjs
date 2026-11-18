import assert from "node:assert/strict";
import { test } from "node:test";
import { loadProduct } from "../adapter.mjs";
import {
  checkContract,
  EXPECTED_CONTRACT_VERSION,
} from "../lib/contractCheck.mjs";
import { Governor, GovernorError } from "../lib/governor.mjs";
import { validateResult } from "../lib/resultSchema.mjs";

const product = await loadProduct();
const have = !!product.root && !!product.contract;

test(
  "the product's contract module agrees with the golden vectors and this lab",
  { skip: !have && "no product checkout" },
  () => {
    assert.deepEqual(product.contractProblems, []);
    assert.equal(
      product.contract.LAB_CONTRACT_VERSION,
      EXPECTED_CONTRACT_VERSION,
    );
  },
);

test("checkContract reports a version, a vector and a missing module", () => {
  assert.deepEqual(checkContract(null, {}), ["contract module not loaded"]);
  assert.deepEqual(checkContract({}, null), ["golden vectors not found"]);
  const fake = {
    LAB_CONTRACT_VERSION: 99,
    wilson: () => ({ k: 0, n: 0, rate: 0, lo: 0, hi: 1 }),
    formatRate: () => "x",
    slug: (s) => s,
  };
  const golden = {
    contractVersion: 1,
    wilson: [
      {
        k: 1,
        n: 2,
        rate: { k: 1, n: 2, rate: 0.5, lo: 0.1, hi: 0.9 },
        text: "t",
      },
    ],
    slug: [{ input: "A", output: "a" }],
  };
  const p = checkContract(fake, golden).join("\n");
  assert.match(p, /contract version 99 but this lab expects 3/);
  assert.match(p, /golden vectors are for version 1, module is 99/);
  assert.match(p, /wilson\(1, 2\) in the product disagrees/);
  assert.match(p, /formatRate\(1, 2\) disagrees/);
  assert.match(p, /slug\("A"\) disagrees/);
});

const sha = "a".repeat(64);
const good = () => ({
  schemaVersion: 1,
  runId: "run-1",
  labSha: "abc1234",
  productSha: "def5678",
  contractVersion: 1,
  arm: {
    model: "qwen3:8b",
    declaredQuant: "Q4_K_M",
    provider: "ollama",
    engine: "ollama 0.12",
    apiSurface: "ollama-chat",
    clientPath: "lab/transports",
    sampling: { temperature: 0, seed: 1 },
  },
  request: { sha256: sha, bytes: 10 },
  reply: { sha256: sha },
  usage: { inputTokens: 5, outputTokens: 7 },
  classification: { outcome: "structured", dialect: "native-structured" },
  scanStatus: "unscanned",
});

test("result schema v1 accepts a complete record", () => {
  assert.deepEqual(validateResult(good()), []);
});

test("result schema v1 rejects missing, extra and malformed fields", () => {
  const r = good();
  delete r.scanStatus;
  r.extra = 1;
  r.arm.sampling.temperature = null;
  r.request.sha256 = "nope";
  r.schemaVersion = 2;
  r.classification.outcome = "weird";
  const p = validateResult(r).join("\n");
  assert.match(p, /\$\.scanStatus: required/);
  assert.match(p, /\$\.extra: not allowed/);
  assert.match(p, /\$\.arm\.sampling\.temperature: must be number or string/);
  assert.match(p, /\$\.request\.sha256: does not match/);
  assert.match(p, /\$\.schemaVersion: must be 1/);
  assert.match(p, /\$\.classification\.outcome: must be one of/);
  assert.deepEqual(validateResult("x"), ["$: must be object"]);
});

const clock = () => {
  let t = 1000;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};
const limits = { maxSpendUsd: 1, maxRequests: 2, maxWallMs: 10_000 };

test("governor needs all three limits", () => {
  assert.throws(() => new Governor({}), RangeError);
  assert.throws(
    () => new Governor({ ...limits, maxRequests: Infinity }),
    RangeError,
  );
});

test("governor defaults to a dry run: nothing is sent, the plan is counted", async () => {
  const g = new Governor({ ...limits, now: clock() });
  let sent = 0;
  const res = await g.guard(async () => (sent++, {}), { estimateUsd: 0.25 });
  assert.equal(res, undefined);
  assert.equal(sent, 0);
  assert.deepEqual(
    [g.snapshot().planned, g.snapshot().plannedUsd, g.snapshot().requests],
    [1, 0.25, 0],
  );
});

test("governor stops at the request, spend and wall-time limits", async () => {
  const now = clock();
  const g = new Governor({ ...limits, dryRun: false, now });
  let sent = 0;
  const send = async () => (sent++, { costUsd: 0.1 });
  await g.guard(send, { estimateUsd: 0.2 });
  await g.guard(send, { estimateUsd: 0.2 });
  assert.equal(sent, 2);
  assert.ok(Math.abs(g.snapshot().spendUsd - 0.2) < 1e-12);
  await assert.rejects(
    g.guard(send),
    (e) => e instanceof GovernorError && /request limit/.test(e.message),
  );

  const s = new Governor({ ...limits, dryRun: false, now });
  await assert.rejects(s.guard(send, { estimateUsd: 1.5 }), /spend limit/);

  const w = new Governor({ ...limits, dryRun: false, now });
  now.advance(10_000);
  await assert.rejects(w.guard(send), /wall-time limit/);
  assert.equal(sent, 2);
});
