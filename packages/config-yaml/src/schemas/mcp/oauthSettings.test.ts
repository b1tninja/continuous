import { describe, expect, it } from "vitest";
import { mcpServerSchema } from "./index.js";

const server = (oauth: unknown) => ({
  name: "github",
  type: "streamable-http",
  url: "https://api.githubcopilot.com/mcp/",
  oauth,
});

describe("mcp server oauth settings", () => {
  it("accepts a static client with a fixed callback port", () => {
    const parsed = mcpServerSchema.safeParse(
      server({
        clientId: "Iv1.abc",
        clientSecret: "from-secrets-store",
        callbackPort: 8765,
        redirectHost: "127.0.0.1",
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("keeps the existing callbackPort-only form working", () => {
    expect(
      mcpServerSchema.safeParse(server({ callbackPort: 3456 })).success,
    ).toBe(true);
  });

  it("rejects an empty client id and an unknown redirect host", () => {
    expect(mcpServerSchema.safeParse(server({ clientId: "" })).success).toBe(
      false,
    );
    expect(
      mcpServerSchema.safeParse(server({ redirectHost: "0.0.0.0" })).success,
    ).toBe(false);
  });
});
