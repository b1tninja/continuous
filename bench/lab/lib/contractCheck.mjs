// The lab's side of the product contract (core/util/labContract.ts). The
// adapter loads the module and the golden vectors from the product checkout
// and hands them here; this file imports nothing from the product. A product
// build whose contract version or vectors disagree is refused at start.
import { wilson as ownWilson } from "./stats.mjs";

/** The contract version this lab was written against. */
export const EXPECTED_CONTRACT_VERSION = 3;

const close = (a, b) => Math.abs(a - b) < 1e-12;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Problems found running `golden` against `contract`, or [] when they agree.
 * Also runs the wilson vectors against the lab's own copy (lib/stats.mjs), so
 * the two copies of the interval maths cannot drift apart unnoticed.
 */
export function checkContract(
  contract,
  golden,
  expected = EXPECTED_CONTRACT_VERSION,
) {
  if (!contract) return ["contract module not loaded"];
  if (!golden) return ["golden vectors not found"];
  const problems = [];
  if (contract.LAB_CONTRACT_VERSION !== expected) {
    problems.push(
      `contract version ${contract.LAB_CONTRACT_VERSION} but this lab expects ${expected}`,
    );
  }
  if (golden.contractVersion !== contract.LAB_CONTRACT_VERSION) {
    problems.push(
      `golden vectors are for version ${golden.contractVersion}, module is ${contract.LAB_CONTRACT_VERSION}`,
    );
  }
  const attempt = (what, fn) => {
    try {
      if (!fn()) problems.push(`${what} disagrees`);
    } catch (e) {
      problems.push(`${what} threw: ${e.message}`);
    }
  };
  for (const v of golden.wilson ?? []) {
    for (const [who, fn] of [
      ["product", contract.wilson],
      ["lab", ownWilson],
    ]) {
      attempt(`wilson(${v.k}, ${v.n}) in the ${who}`, () => {
        const r = fn(v.k, v.n);
        return (
          r.k === v.rate.k &&
          r.n === v.rate.n &&
          ["rate", "lo", "hi"].every((f) => close(r[f], v.rate[f]))
        );
      });
    }
    attempt(
      `formatRate(${v.k}, ${v.n})`,
      () => contract.formatRate(contract.wilson(v.k, v.n)) === v.text,
    );
  }
  for (const v of golden.slug ?? [])
    attempt(
      `slug(${JSON.stringify(v.input)})`,
      () => contract.slug(v.input) === v.output,
    );
  for (const v of golden.fixtureId ?? [])
    attempt(
      `captureFixtureId(${v.input.promptId})`,
      () => contract.captureFixtureId(v.input) === v.output,
    );
  for (const v of golden.validateProbeResult ?? [])
    attempt(`validateProbeResult(${JSON.stringify(v.input)})`, () =>
      same(contract.validateProbeResult(v.input), v.problems),
    );
  for (const v of golden.validateServerIdentity ?? [])
    attempt(`validateServerIdentity(${JSON.stringify(v.input)})`, () =>
      same(contract.validateServerIdentity(v.input), v.problems),
    );
  for (const v of golden.serverIdentityLabel ?? [])
    attempt(
      `serverIdentityLabel(${JSON.stringify(v.input)})`,
      () => contract.serverIdentityLabel(v.input) === v.output,
    );
  return problems;
}
