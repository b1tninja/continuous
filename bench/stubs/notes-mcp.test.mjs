// node --test bench/stubs/notes-mcp.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { handle, TICKET_TEXT } from "./notes-mcp.mjs";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "notes-mcp.mjs",
);

test("answers the MCP handshake, lists one tool and returns the ticket", () => {
  const init = handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "notes");
  assert.equal(
    handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    undefined,
  );
  const list = handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["get_ticket"],
  );
  const call = handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_ticket", arguments: { id: "OPS-112" } },
  });
  assert.equal(call.result.content[0].text, TICKET_TEXT);
  assert.match(TICKET_TEXT, /example\.invalid/);
  assert.equal(
    handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "x" },
    }).error.code,
    -32602,
  );
});

test("speaks newline-delimited JSON-RPC over stdio", async () => {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = [];
  child.stdout.setEncoding("utf8");
  let buffer = "";
  const got = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
        if (lines.length === 2) resolve();
      }
    });
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }) + "\n",
  );
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_ticket", arguments: { id: "OPS-112" } },
    }) + "\n",
  );
  await got;
  child.kill();
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].result.content[0].text, TICKET_TEXT);
});
