/**
 * Default API bases for the providers the OpenAI-compatible Test connection
 * knows. Pure: the add-model form reads it too, so it imports nothing.
 */

const DEFAULT_BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  ollama: "http://127.0.0.1:11434/v1",
  "llama.cpp": "http://127.0.0.1:8080/v1",
  llamafile: "http://127.0.0.1:8080/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  vllm: "http://127.0.0.1:8000/v1",
  "text-gen-webui": "http://127.0.0.1:5000/v1",
  msty: "http://127.0.0.1:10000/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
};

/** Providers this tester knows a default endpoint for; any other needs an apiBase. */
export function hasOpenAICompatDefault(provider: string): boolean {
  return Object.hasOwn(DEFAULT_BASES, provider);
}

/** The OpenAI-compatible base URL (ends in /v1 for the local servers), no trailing slash. */
export function openAICompatBase(
  provider: string,
  apiBase?: string,
): string | undefined {
  const raw = (apiBase?.trim() || DEFAULT_BASES[provider])?.replace(/\/+$/, "");
  if (!raw) return undefined;
  // Ollama's native base has no /v1; its OpenAI surface does.
  return provider === "ollama" && !/\/v1$/.test(raw) ? `${raw}/v1` : raw;
}

/** The default base for a provider, or undefined when it needs a custom apiBase. */
export function openAICompatDefaultBase(provider: string): string | undefined {
  return hasOpenAICompatDefault(provider) ? DEFAULT_BASES[provider] : undefined;
}
