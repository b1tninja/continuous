import { LlmInfo } from "../types.js";

export const OsLlms: Omit<LlmInfo, "provider">[] = [
  {
    model: "starcoder2:3b",
    displayName: "StarCoder 2 3B",
    contextLength: 8192,
  },
  {
    // Meta's published window for Llama 3.1 is 128K. OpenRouter's
    // meta-llama/llama-3.1-8b-instruct reports context_length 131072
    // (fetched 2026-11-18). The pattern is the Ollama tag (`llama3.1:8b`),
    // not `llama3.1-8b`, which is a different provider's id.
    model: "llama3.1:8b",
    displayName: "Llama 3.1",
    contextLength: 131072,
    regex: /^llama3\.1(?::|$)/i,
  },
];
