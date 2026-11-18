// The engine descriptor Engine.describe() puts in every record, turned into
// the contract's ServerIdentity (core/util/labContract.ts) for the result
// schema's arm.server. A field the server did not report stays absent.

const NAMES = {
  "llama-server": "llama-server",
  vllm: "vllm",
  ollama: "ollama",
};

/** ServerIdentity for an engine descriptor, or undefined when it names no server. */
export function toServerIdentity(engine) {
  const name = NAMES[engine?.engine] ?? engine?.engine;
  if (!name) return undefined;
  const id = { name };
  const version = engine.version ?? engine.build;
  if (version) id.version = String(version);
  // reported: Ollama /api/show parser, llama.cpp Chat format; declared: --tool-parser
  const reported = engine.parser ?? engine.chatFormat;
  const parser = reported ?? engine.parserDeclared;
  if (parser) {
    id.parser = String(parser);
    id.parserSource = reported ? "reported" : "declared";
  }
  const sha = engine.chatTemplateSha ?? engine.templateSha;
  if (sha) id.templateSha = sha;
  return id;
}
