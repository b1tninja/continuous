import { beforeEach, describe, expect, test, vi } from "vitest";

// Every request fails the way node-fetch reports a refused connection.
const failWith = vi.hoisted(() => ({
  make: (url: URL): Error => new Error(`not set for ${url}`),
}));
vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  fetchwithRequestOptions: async (url: URL) => {
    throw failWith.make(url);
  },
}));
const installed = vi.hoisted(() => ({ ollama: true }));
vi.mock("../util/ollamaHelper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/ollamaHelper.js")>()),
  isOllamaInstalled: async () => installed.ollama,
}));

import { ChatMessage } from "../index.js";
import { BaseLLM } from "./index.js";
import LlamaCpp from "./llms/LlamaCpp.js";
import LMStudio from "./llms/LMStudio.js";
import Ollama from "./llms/Ollama.js";
import OpenAI from "./llms/OpenAI.js";
import {
  connectionFailureKind,
  describeLocalServerFailure,
  isLocalServerFailureMessage,
  isLocalServerHostname,
  localServerAddress,
  localServerError,
  LocalServerError,
  localServerFixFor,
} from "./localServerError.js";

/** node-fetch's error for a connection the machine refused. */
function refused(url: URL): Error {
  return Object.assign(
    new Error(
      `request to ${url} failed, reason: connect ECONNREFUSED ${url.hostname}:${url.port}`,
    ),
    { name: "FetchError", code: "ECONNREFUSED", errno: "ECONNREFUSED" },
  );
}

/** What undici's fetch throws: no code and no address on the error itself. */
function fetchFailed(code?: string): Error {
  return new TypeError("fetch failed", {
    cause: code ? Object.assign(new Error("connect"), { code }) : undefined,
  });
}

/** The OpenAI SDK's wrapper around a failed request. */
function sdkConnectionError(cause: unknown): Error {
  return new Error("Connection error.", { cause });
}

const hi: ChatMessage[] = [{ role: "user", content: "hi" }];

async function chatError(llm: BaseLLM): Promise<Error> {
  try {
    for await (const _ of llm.streamChat(hi, new AbortController().signal)) {
      // drain
    }
  } catch (e) {
    return e as Error;
  }
  throw new Error("the chat did not fail");
}

const CHECK =
  "Check that the server is running, that the port is right, and that it listens on this address.";

beforeEach(() => {
  failWith.make = refused;
  installed.ollama = true;
});

describe("which addresses count as a local server", () => {
  test.each([
    "localhost",
    "api.localhost",
    "127.0.0.1",
    "127.8.9.10",
    "[::1]",
    "10.0.0.7",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.50",
    "gpu-box.local",
    "host.docker.internal",
  ])("%s is local", (host) => {
    expect(isLocalServerHostname(host)).toBe(true);
  });

  test.each([
    "api.openai.com",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.1.1",
    "11.0.0.1",
    "8.8.8.8",
    "10.example.com",
    "localhost.example.com",
    "999.168.1.1",
  ])("%s is not", (host) => {
    expect(isLocalServerHostname(host)).toBe(false);
  });

  test("the port comes from the address, or from the scheme when it has none", () => {
    expect(
      localServerAddress({ apiBase: "http://192.168.1.50:11434/v1/" })
        ?.hostPort,
    ).toBe("192.168.1.50:11434");
    expect(localServerAddress({ apiBase: "http://10.0.0.7" })?.hostPort).toBe(
      "10.0.0.7:80",
    );
    expect(
      localServerAddress({ apiBase: "https://gpu-box.local/v1" })?.hostPort,
    ).toBe("gpu-box.local:443");
    expect(localServerAddress({ apiBase: "http://[::1]:8080" })?.hostPort).toBe(
      "[::1]:8080",
    );
    expect(
      localServerAddress({ apiBase: "https://api.openai.com/v1" }),
    ).toBeUndefined();
    expect(localServerAddress({ apiBase: "not a url" })).toBeUndefined();
  });

  test("a provider with no apiBase set is at its default address", () => {
    expect(localServerAddress({ provider: "lmstudio" })?.hostPort).toBe(
      "127.0.0.1:1234",
    );
    expect(localServerAddress({ provider: "openai" })).toBeUndefined();
    expect(localServerAddress({ provider: "anthropic" })).toBeUndefined();
  });
});

describe("which errors are a connection that got no answer", () => {
  test("by code, on the error or on a cause", () => {
    expect(connectionFailureKind(refused(new URL("http://a:1")))).toBe(
      "refused",
    );
    expect(connectionFailureKind(fetchFailed("ECONNREFUSED"))).toBe("refused");
    expect(connectionFailureKind(fetchFailed("ETIMEDOUT"))).toBe("timed-out");
    expect(connectionFailureKind(fetchFailed("UND_ERR_CONNECT_TIMEOUT"))).toBe(
      "timed-out",
    );
    expect(connectionFailureKind(fetchFailed("EHOSTUNREACH"))).toBe("failed");
    expect(connectionFailureKind(fetchFailed("ENOTFOUND"))).toBe("not-found");
    expect(
      connectionFailureKind(sdkConnectionError(fetchFailed("ECONNREFUSED"))),
    ).toBe("refused");
  });

  test("by wording, when no code survived", () => {
    expect(connectionFailureKind(fetchFailed())).toBe("failed");
    expect(connectionFailureKind(new Error("Connection error."))).toBe(
      "failed",
    );
    expect(connectionFailureKind(new Error("Request timed out."))).toBe(
      "timed-out",
    );
    expect(
      connectionFailureKind(
        new Error("connect ECONNREFUSED 192.168.1.50:11434"),
      ),
    ).toBe("refused");
  });

  test("not a reply with a status, a cancelled request, or a reply cut short", () => {
    expect(
      connectionFailureKind(
        Object.assign(new Error("404 model not found"), { status: 404 }),
      ),
    ).toBeUndefined();
    expect(
      connectionFailureKind(
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
      ),
    ).toBeUndefined();
    expect(
      connectionFailureKind(
        new Error(
          "The connection closed in the middle of the response, so the reply is incomplete. Resubmit to try again. (terminated)",
          {
            cause: Object.assign(new Error("terminated"), {
              code: "ETIMEDOUT",
            }),
          },
        ),
      ),
    ).toBeUndefined();
    expect(connectionFailureKind(new Error("Invalid API key"))).toBeUndefined();
    expect(
      connectionFailureKind(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      ),
    ).toBeUndefined();
  });
});

describe("the sentence", () => {
  test("Ollama on a LAN address", () => {
    expect(
      describeLocalServerFailure(
        { provider: "ollama", apiBase: "http://192.168.1.50:11434" },
        "refused",
      ),
    ).toBe(
      `Could not reach Ollama at 192.168.1.50:11434. The connection was refused. ${CHECK} Ollama accepts connections from other machines only when OLLAMA_HOST is set on the machine that runs it, for example to 0.0.0.0. To start Ollama, run \`ollama serve\` on that machine.`,
    );
  });

  test("llama.cpp on port 8080", () => {
    expect(
      describeLocalServerFailure(
        { provider: "llama.cpp", apiBase: "http://127.0.0.1:8080/" },
        "refused",
      ),
    ).toBe(
      `Could not reach llama.cpp at 127.0.0.1:8080. The connection was refused. ${CHECK}`,
    );
  });

  test("LM Studio on port 1234, by the name localhost", () => {
    expect(
      describeLocalServerFailure(
        { provider: "lmstudio", apiBase: "http://localhost:1234/v1/" },
        "failed",
      ),
    ).toBe(
      `Could not reach LM Studio at localhost:1234. The connection failed. ${CHECK} The name localhost can mean 127.0.0.1 or ::1. If the server listens on only one of them, put that address in apiBase.`,
    );
  });

  test("an OpenAI-compatible server on another machine that does not answer", () => {
    expect(
      describeLocalServerFailure(
        { provider: "openai", apiBase: "http://10.0.0.7:8000/v1" },
        "timed-out",
      ),
    ).toBe(
      `Could not reach the model server at 10.0.0.7:8000. The connection timed out. ${CHECK} A server that listens only on 127.0.0.1 does not accept connections from other machines. A firewall on that machine can also block the port.`,
    );
  });

  test("a .local name that does not resolve", () => {
    expect(
      describeLocalServerFailure(
        { provider: "ollama", apiBase: "http://gpu-box.local:11434" },
        "not-found",
      ),
    ).toBe(
      "Could not reach Ollama at gpu-box.local:11434. The host name could not be found. Check the host name in apiBase, and that the server is running. To start Ollama, run `ollama serve` on that machine.",
    );
  });

  test("the Ollama hint follows the provider, not the port", () => {
    const onOtherPort = describeLocalServerFailure(
      { provider: "ollama", apiBase: "http://127.0.0.1:9999" },
      "refused",
    );
    expect(onOtherPort).toContain("Could not reach Ollama at 127.0.0.1:9999.");
    expect(onOtherPort).toContain("To start Ollama, run `ollama serve`.");
    const otherServerOnItsPort = describeLocalServerFailure(
      { provider: "openai", apiBase: "http://127.0.0.1:11434/v1" },
      "refused",
    );
    expect(otherServerOnItsPort).not.toContain("ollama");
    expect(
      describeLocalServerFailure(
        { provider: "ollama", apiBase: "http://127.0.0.1:11434" },
        "refused",
        { installed: false },
      ),
    ).toBe(
      `Could not reach Ollama at 127.0.0.1:11434. The connection was refused. ${CHECK} Ollama does not seem to be installed on this computer.`,
    );
    expect(
      describeLocalServerFailure(
        { provider: "lemonade", apiBase: "http://localhost:8000/api/v1/" },
        "refused",
      ),
    ).toContain("See http://lemonade-server.ai for setup instructions.");
  });

  test("a hosted provider gets no such sentence", () => {
    expect(
      describeLocalServerFailure(
        { provider: "openai", apiBase: "https://api.openai.com/v1" },
        "refused",
      ),
    ).toBeUndefined();
    expect(
      localServerError(fetchFailed("ECONNREFUSED"), {
        provider: "anthropic",
      }),
    ).toBeUndefined();
  });

  test("the error keeps the code and the cause, and is not made twice", () => {
    const cause = fetchFailed("ECONNREFUSED");
    const target = { provider: "lmstudio", apiBase: "http://localhost:1234" };
    const error = localServerError(cause, target);
    expect(error).toBeInstanceOf(LocalServerError);
    expect(error?.code).toBe("ECONNREFUSED");
    expect(error?.cause).toBe(cause);
    expect(isLocalServerFailureMessage(error!.message)).toBe(true);
    const wrapped = new Error(`tried 3 times (${error!.message})`, {
      cause: error,
    });
    expect(localServerError(wrapped, target)).toBe(error);
  });
});

describe("what the editor can offer for the sentence", () => {
  const sentence = (
    provider: string,
    apiBase: string,
    installed?: boolean,
  ): string =>
    describeLocalServerFailure({ provider, apiBase }, "refused", {
      installed,
    })!;

  test("start Ollama on this machine, or get it when it is not installed", () => {
    expect(
      localServerFixFor(sentence("ollama", "http://localhost:11434", true)),
    ).toBe("start-ollama");
    expect(localServerFixFor(sentence("ollama", "http://[::1]:11434"))).toBe(
      "start-ollama",
    );
    expect(
      localServerFixFor(sentence("ollama", "http://127.0.0.1:11434", false)),
    ).toBe("download-ollama");
  });

  test("start Lemonade on this machine when it is installed", () => {
    expect(
      localServerFixFor(sentence("lemonade", "http://localhost:8000/api/v1/")),
    ).toBe("start-lemonade");
    expect(
      localServerFixFor(
        sentence("lemonade", "http://localhost:8000/api/v1/", false),
      ),
    ).toBeUndefined();
  });

  test("nothing for a server on another machine, another server, or another error", () => {
    expect(
      localServerFixFor(sentence("ollama", "http://192.168.1.50:11434")),
    ).toBeUndefined();
    expect(
      localServerFixFor(sentence("lemonade", "http://10.0.0.7:8000")),
    ).toBeUndefined();
    expect(
      localServerFixFor(sentence("lmstudio", "http://localhost:1234")),
    ).toBeUndefined();
    expect(localServerFixFor("fetch failed")).toBeUndefined();
  });
});

describe("a model whose local server cannot be reached", () => {
  test("Ollama on a LAN address", async () => {
    const ollama = new Ollama({
      model: "qwen3:8b",
      apiBase: "http://192.168.1.50:11434",
    });
    const error = await chatError(ollama);
    expect(error.message).toMatch(
      /^Could not reach Ollama at 192\.168\.1\.50:11434\. The connection was refused\. Check that the server is running, that the port is right, and that it listens on this address\./,
    );
    expect(error.message).toContain("OLLAMA_HOST");
    expect((error as LocalServerError).code).toBe("ECONNREFUSED");
  });

  test("Ollama on this machine, not installed", async () => {
    installed.ollama = false;
    const ollama = new Ollama({ model: "qwen3:8b" });
    const error = await chatError(ollama);
    expect(error.message).toBe(
      `Could not reach Ollama at localhost:11434. The connection was refused. ${CHECK} The name localhost can mean 127.0.0.1 or ::1. If the server listens on only one of them, put that address in apiBase. Ollama does not seem to be installed on this computer.`,
    );
  });

  test("llama.cpp on port 8080", async () => {
    const llama = new LlamaCpp({ model: "qwen" });
    const error = await chatError(llama);
    expect(error.message).toBe(
      `Could not reach llama.cpp at 127.0.0.1:8080. The connection was refused. ${CHECK}`,
    );
  });

  test("LM Studio on port 1234, when the request fails with only 'fetch failed'", async () => {
    const lmstudio = new LMStudio({ model: "qwen" });
    // LM Studio is reached through the OpenAI SDK, which wraps the failure
    (lmstudio as any).openaiAdapter = {
      chatCompletionStream: async function* () {
        throw sdkConnectionError(fetchFailed());
      },
    };
    const error = await chatError(lmstudio);
    expect(error.message).toMatch(
      /^Could not reach LM Studio at localhost:1234\. The connection failed\. Check that the server is running, that the port is right, and that it listens on this address\./,
    );
    expect(error.message).not.toContain("fetch failed");
    expect((error.cause as Error).message).toBe("Connection error.");
  });

  test("a direct request (the model list, an embedding) says the same", async () => {
    const lmstudio = new LMStudio({
      model: "qwen",
      apiBase: "http://10.0.0.7:1234/v1/",
    });
    failWith.make = () => fetchFailed("ETIMEDOUT");
    await expect(
      lmstudio.fetch(new URL("http://10.0.0.7:1234/v1/models")),
    ).rejects.toThrow(
      /^Could not reach LM Studio at 10\.0\.0\.7:1234\. The connection timed out\./,
    );
  });

  test("a hosted provider keeps its own error", async () => {
    const openai = new OpenAI({ model: "gpt-4o", apiKey: "k" });
    failWith.make = () => fetchFailed("ECONNREFUSED");
    await expect(
      openai.fetch(new URL("https://api.openai.com/v1/models")),
    ).rejects.toThrow("fetch failed");
  });
});
