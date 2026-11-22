import { mcpServerSchema } from "./index.js";

describe("mcpServerSchema timeouts", () => {
  it("accepts a tool call limit beside the connection limit, both in milliseconds", () => {
    const stdio = mcpServerSchema.parse({
      name: "a",
      command: "npx",
      connectionTimeout: 20000,
      toolTimeout: 300000,
    });
    expect(stdio).toMatchObject({
      connectionTimeout: 20000,
      toolTimeout: 300000,
    });
    expect(
      mcpServerSchema.parse({
        name: "b",
        url: "https://b.example/mcp",
        toolTimeout: 45000,
      }),
    ).toMatchObject({ toolTimeout: 45000 });
  });

  it("leaves both out when the file does", () => {
    const parsed = mcpServerSchema.parse({ name: "a", command: "npx" });
    expect("toolTimeout" in parsed).toBe(false);
    expect("connectionTimeout" in parsed).toBe(false);
  });

  it("refuses zero, a negative number and text", () => {
    for (const toolTimeout of [0, -1, "60"]) {
      expect(
        mcpServerSchema.safeParse({ name: "a", command: "npx", toolTimeout })
          .success,
      ).toBe(false);
    }
  });
});
