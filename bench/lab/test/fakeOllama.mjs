// A fake Ollama on a loopback port, for tests that must run offline. It
// speaks the four endpoints the lab uses. `script(body, state)` decides each
// chat reply; the default answers like a well-behaved native-tools model.
import http from "node:http";
import { openaiRespond } from "./fakeLlama.mjs";

export const SMALL = {
  name: "fake-small:1b",
  size: 2e9,
  family: "fake",
  capabilities: ["completion", "tools"],
};
export const BIG = {
  name: "fake-big:70b",
  size: 40e9,
  family: "fake",
  capabilities: ["completion", "tools"],
};

const call = (name, args) => ({ function: { name, arguments: args } });

/** The default script: a tool call when tools are offered and the prompt names a file. */
export function defaultScript(body) {
  const user =
    [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (body.tools?.length) {
    const m = /^Read the file ([\w./-]+?)\.?$/m.exec(user);
    if (m) return { tool_calls: [call("read_file", { path: m[1] })] };
    return { content: "Paris" };
  }
  return { content: "Paris" };
}

export async function startFake({
  models = [SMALL, BIG],
  script = defaultScript,
  delayMs = 0,
  loaded = [],
} = {}) {
  const state = { chats: [], unloads: [], loaded: [...loaded], hits: [] };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    state.hits.push(req.url);
    const json = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/api/tags")
      return json({
        models: models.map((m) => ({
          name: m.name,
          model: m.name,
          size: m.size,
          details: {
            family: m.family,
            parameter_size: "1B",
            quantization_level: "Q4_K_M",
            context_length: 8192,
          },
          capabilities: m.capabilities,
        })),
      });
    if (req.url === "/api/ps")
      return json({
        models: state.loaded.map((n) => ({
          name: n,
          size: 1e9,
          size_vram: 1e9,
        })),
      });
    if (req.url === "/api/show") {
      const m = models.find((x) => x.name === body.model);
      if (!m) return json({ error: "not found" }, 404);
      return json({
        capabilities: m.capabilities,
        template: "{{ if .Tools }}tools{{ end }}",
        ...(m.parameters ? { parameters: m.parameters } : {}),
        model_info: {
          "general.architecture": "fake",
          "fake.context_length": 8192,
        },
      });
    }
    if (req.url === "/api/version") return json({ version: "0.0.0-fake" });
    if (req.url === "/v1/chat/completions") {
      state.v1 = (state.v1 ?? []).concat([body]);
      state.last = state.last ?? "";
      const s = await script(body, state);
      if (s.status)
        return json({ error: { message: s.error ?? "boom" } }, s.status);
      const reply = {
        content: s.content,
        reasoning: s.reasoning,
        tool_calls: (s.tool_calls ?? []).map((c) => ({
          name: c.function.name,
          arguments: c.function.arguments,
        })),
      };
      return openaiRespond(res, body, reply, {
        engine: "ollama",
        state,
        reasoningField: "reasoning",
      });
    }
    if (req.url === "/api/generate") {
      if (body.keep_alive === 0)
        return json({ done: true, done_reason: "unload" });
      state.generates = (state.generates ?? []).concat([body]);
      const text = "Paris";
      const usage = {
        prompt_eval_count: 30,
        prompt_eval_duration: 5e6,
        eval_count: 2,
        eval_duration: 4e6,
        load_duration: 1e6,
        total_duration: 1e7,
      };
      if (!body.stream)
        return json({
          model: body.model,
          response: text,
          done: true,
          done_reason: "stop",
          ...usage,
        });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ response: "Pa", done: false }) + "\n");
      res.write(JSON.stringify({ response: "ris", done: false }) + "\n");
      return res.end(
        JSON.stringify({
          response: "",
          done: true,
          done_reason: "stop",
          ...usage,
        }) + "\n",
      );
    }
    if (req.url === "/api/chat") {
      if (body.keep_alive === 0 && (body.messages ?? []).length === 0) {
        state.unloads.push(body.model);
        return json({ done: true, done_reason: "unload" });
      }
      state.chats.push(body);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const s = await script(body, state);
      if (s.status) return json({ error: s.error ?? "boom" }, s.status);
      const usage = {
        prompt_eval_count: 40,
        eval_count: 20,
        eval_duration: 1e9,
        load_duration: 2e9,
        total_duration: 3e9,
      };
      const msg = {
        role: "assistant",
        content: s.content ?? "",
        ...(s.tool_calls ? { tool_calls: s.tool_calls } : {}),
      };
      if (!body.stream)
        return json({
          model: body.model,
          message: msg,
          done: true,
          done_reason: "stop",
          ...usage,
        });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const text = msg.content;
      const mid = Math.ceil(text.length / 2);
      if (text) {
        res.write(
          JSON.stringify({
            message: { role: "assistant", content: text.slice(0, mid) },
            done: false,
          }) + "\n",
        );
        res.write(
          JSON.stringify({
            message: { role: "assistant", content: text.slice(mid) },
            done: false,
          }) + "\n",
        );
      }
      res.end(
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            ...(s.tool_calls ? { tool_calls: s.tool_calls } : {}),
          },
          done: true,
          done_reason: "stop",
          ...usage,
        }) + "\n",
      );
      return;
    }
    json({ error: "no such endpoint" }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}
