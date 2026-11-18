import { describe, expect, it } from "vitest";

import { scrubDeep, scrubDeepCounted } from "./scrubForDisk";

/** Built at run time so no secret-shaped literal sits in the source. */
function canary() {
  return {
    anthropic: ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("-"),
    aws: "AKIA" + "QWERTYUIOPASDFGH".slice(0, 16),
    github: "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG3hJ5".slice(0, 36),
  };
}

describe("scrubDeepCounted (V13)", () => {
  it("gives what scrubDeep gives, and the number of values replaced", () => {
    const c = canary();
    const value = {
      title: "deploy",
      history: [
        { text: `key ${c.anthropic} and ${c.github}` },
        { text: `AWS_ACCESS_KEY_ID=${c.aws}` },
        { n: 3, text: "nothing here" },
      ],
    };
    const { value: out, count } = scrubDeepCounted(value);
    expect(out).toEqual(scrubDeep(value));
    expect(count).toBe(3);
    expect(JSON.stringify(out)).not.toContain(c.anthropic);
  });

  it("counts nothing in clean or already scrubbed text", () => {
    const once = scrubDeep({ t: `x ${canary().aws}` });
    expect(scrubDeepCounted(once).count).toBe(0);
    expect(scrubDeepCounted({ t: "ls -la" }).count).toBe(0);
  });
});
