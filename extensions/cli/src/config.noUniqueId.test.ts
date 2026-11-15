/**
 * WB26: no model request from the CLI carries a machine id. `config.ts` used
 * to hold an unused helper that would have added `x-continue-unique-id:
 * <machine id>` to every model request; it is gone, and this keeps it gone.
 * The requests go to a server on 127.0.0.1 started by the test.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { ModelConfig } from "@continuedev/config-yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createLlmApi } from "./config.js";

const SENTINEL = "machine-id-sentinel-4f1c9a";

const seen: http.IncomingHttpHeaders[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  vi.stubEnv("CONTINUE_USER_ID", SENTINEL);
  server = http.createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "ok" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
});

describe("model requests carry no machine id", () => {
  it("an OpenAI-compatible request has no x-continue-unique-id header and no id value", async () => {
    const model = {
      name: "test",
      provider: "openai",
      model: "test-model",
      apiKey: "test-key",
      apiBase: base,
      requestOptions: { headers: { "x-from-config": "kept" } },
    } as ModelConfig;
    const api = createLlmApi(model, null);
    expect(api).not.toBeNull();
    const reply = await api!.chatCompletionNonStream(
      {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      },
      new AbortController().signal,
    );
    expect(reply.choices[0].message.content).toBe("ok");

    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers["x-continue-unique-id"]).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain(SENTINEL);
      // The person's own headers still go to their model
      expect(headers["x-from-config"]).toBe("kept");
    }
  });

  it("nothing in the CLI's source sets the header", () => {
    const root = path.resolve(__dirname);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !entry.name.endsWith(".test.ts") &&
          fs.readFileSync(full, "utf8").includes("x-continue-unique-id")
        ) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
