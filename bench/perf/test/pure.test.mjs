import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addTo,
  bucketOfPath,
  bucketsOfMetafileOutput,
  charsPerSource,
  topEntries,
} from "../src/buckets.mjs";
import { median, percentile, round, summarize } from "../src/stats.mjs";

test("median of odd and even samples, without sorting the input", () => {
  const odd = [5, 1, 3];
  assert.equal(median(odd), 3);
  assert.deepEqual(odd, [5, 1, 3]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test("percentile is nearest-rank", () => {
  const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(s, 95), 100);
  assert.equal(percentile(s, 90), 90);
  assert.equal(percentile(s, 50), 50);
  assert.equal(percentile(s, 0), 10);
  assert.equal(percentile([7], 95), 7);
  assert.ok(Number.isNaN(percentile([], 95)));
  assert.throws(() => percentile(s, 101), RangeError);
});

test("summarize reports n, min, median, mean, p95, max and sample stddev", () => {
  const r = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(r.n, 8);
  assert.equal(r.min, 2);
  assert.equal(r.max, 9);
  assert.equal(r.median, 4.5);
  assert.equal(r.mean, 5);
  assert.equal(r.p95, 9);
  assert.equal(round(r.stddev, 3), 2.138);
  assert.equal(summarize([3]).stddev, 0);
  assert.equal(summarize([]).n, 0);
});

test("round keeps the asked number of digits", () => {
  assert.equal(round(1.2345), 1.2);
  assert.equal(round(1.2345, 2), 1.23);
  assert.equal(round(12, 0), 12);
});

test("bucketOfPath names the innermost package, scoped or not", () => {
  assert.equal(bucketOfPath("node_modules/zod/v4/core/api.js"), "npm:zod");
  assert.equal(
    bucketOfPath("../../core/node_modules/@ai-sdk/openai/dist/index.js"),
    "npm:@ai-sdk/openai",
  );
  assert.equal(bucketOfPath("node_modules/a/node_modules/b/index.js"), "npm:b");
  assert.equal(bucketOfPath("..\\..\\node_modules\\yaml\\x.js"), "npm:yaml");
});

test("bucketOfPath names the source area of first-party files", () => {
  assert.equal(bucketOfPath("../../core/util/history.ts"), "src:core");
  assert.equal(
    bucketOfPath("../../packages/fetch/dist/index.js"),
    "src:packages/fetch",
  );
  assert.equal(bucketOfPath("src/index.ts"), "src:src");
  assert.equal(bucketOfPath("../gui/src/App.tsx"), "src:gui");
  assert.equal(bucketOfPath("stubs.js"), "other");
});

test("bucketsOfMetafileOutput sums bytesInOutput per bucket", () => {
  const totals = bucketsOfMetafileOutput({
    bytes: 60,
    inputs: {
      "node_modules/zod/a.js": { bytesInOutput: 10 },
      "node_modules/zod/b.js": { bytesInOutput: 20 },
      "src/index.ts": { bytesInOutput: 30 },
    },
  });
  assert.deepEqual(totals, { "npm:zod": 30, "src:src": 30 });
  assert.deepEqual(bucketsOfMetafileOutput({}), {});
});

test("charsPerSource gives each segment the columns up to the next one", () => {
  // line 0: col 0 -> source 0, col 4 -> source 1 (to the end of a 10 character line)
  // line 1: col 0 -> source 1 (to the end of a 6 character line)
  // "AAAA" = [0,0,0,0]; "ICAA" = [4,1,0,0]; "AAAA" on a new line keeps source 1
  const out = charsPerSource("AAAA,ICAA;AAAA", [10, 6]);
  assert.deepEqual(
    [...out],
    [
      [0, 4],
      [1, 12],
    ],
  );
});

test("charsPerSource skips segments without a source and empty lines", () => {
  // col 0 unmapped ("A"), col 3 -> source 0 ("GAAA"), then an empty line
  const out = charsPerSource("A,GAAA;;", [8, 0, 0]);
  assert.deepEqual([...out], [[0, 5]]);
  assert.throws(() => charsPerSource("!", [1]), /VLQ/);
});

test("addTo and topEntries", () => {
  const totals = {};
  addTo(totals, "a", 1);
  addTo(totals, "b", 5);
  addTo(totals, "a", 2);
  assert.deepEqual(topEntries(totals), [
    ["b", 5],
    ["a", 3],
  ]);
  assert.deepEqual(topEntries(totals, 1), [["b", 5]]);
});
