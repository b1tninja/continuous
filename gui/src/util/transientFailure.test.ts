import { describe, expect, it } from "vitest";
import {
  formatWait,
  localServerFailureText,
  transientFailure,
} from "./transientFailure";

describe("transientFailure", () => {
  it("knows a rate limit, an overload and a lost connection", () => {
    expect(transientFailure(429, "Too Many Requests")?.kind).toBe("rate-limit");
    expect(transientFailure(503, "Service Unavailable")?.kind).toBe(
      "overloaded",
    );
    expect(
      transientFailure(
        undefined,
        "The connection closed before the response arrived (tried 1 times). (Request timed out.)",
      )?.kind,
    ).toBe("connection");
  });

  it("uses the wait the server asked for", () => {
    const f = transientFailure(
      undefined,
      "The server asked to wait 3600 s before trying again (rate limit or overload)",
    );
    expect(f).toMatchObject({ waitSeconds: 3600, waitFromServer: true });
  });

  it("leaves other errors to the usual dialog", () => {
    expect(transientFailure(400, "invalid tool schema")).toBeUndefined();
    expect(transientFailure(401, "bad key")).toBeUndefined();
  });

  it("formats waits", () => {
    expect(formatWait(45)).toBe("45 s");
    expect(formatWait(180)).toBe("3 min");
    expect(formatWait(3900)).toBe("1 h 5 min");
  });
});

describe("localServerFailureText", () => {
  const CORE =
    "Could not reach Ollama at 192.168.1.50:11434. The connection was refused. Check that the server is running, that the port is right, and that it listens on this address.";

  it("keeps the sentence core wrote, and the dialog still offers to try again", () => {
    expect(localServerFailureText(CORE, null)).toBe(CORE);
    expect(transientFailure(undefined, CORE)?.kind).toBe("connection");
  });

  it("names the host and port of a local model when only the raw error arrived", () => {
    expect(
      localServerFailureText("fetch failed", {
        provider: "ollama",
        apiBase: "http://192.168.1.50:11434",
      }),
    ).toContain("Could not reach Ollama at 192.168.1.50:11434.");
    expect(
      localServerFailureText(
        "request to http://127.0.0.1:8080/completion failed, reason: connect ECONNREFUSED 127.0.0.1:8080",
        { provider: "llama.cpp", apiBase: "http://127.0.0.1:8080/" },
      ),
    ).toBe(
      "Could not reach llama.cpp at 127.0.0.1:8080. The connection was refused. Check that the server is running, that the port is right, and that it listens on this address.",
    );
    // No apiBase in the config: the provider's default address
    expect(
      localServerFailureText("fetch failed", { provider: "lmstudio" }),
    ).toContain("Could not reach LM Studio at 127.0.0.1:1234.");
  });

  it("says nothing for a hosted model or for another kind of error", () => {
    expect(
      localServerFailureText("fetch failed", {
        provider: "openai",
        apiBase: "https://api.openai.com/v1",
      }),
    ).toBeUndefined();
    expect(
      localServerFailureText("socket hang up", {
        provider: "ollama",
        apiBase: "http://127.0.0.1:11434",
      }),
    ).toBeUndefined();
    expect(localServerFailureText("fetch failed", undefined)).toBeUndefined();
  });
});
