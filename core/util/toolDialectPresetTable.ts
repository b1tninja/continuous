/**
 * The preset rows (types and lookup: toolDialectPresets.ts). Data only.
 *
 * Evidence rules: `bedrockTools`, `nativeOnConverse` and `measured` come from
 * the live Bedrock Converse run of 2026-11-10 (plans/live-tool-call-findings.md,
 * 8 prompts per model). `textDialect` comes from the family's chat template or
 * vendor guide as read on `readOn` (plans/tool-dialect-reference.md). A
 * `serverParser` is set only where a model card, a deployment guide or the
 * vLLM docs named it; the vLLM registry
 * (github.com/vllm-project/vllm vllm/tool_parsers/__init__.py, read 2026-11-10)
 * is the check that a name exists. Llama.cpp and Ollama template notes are not
 * recorded: none was verified.
 */
import type { DialectPreset } from "./toolDialectPresets.js";

const READ = "2026-11-10";
const REF = "plans/tool-dialect-reference.md";
const LIVE = "plans/live-tool-call-findings.md";
const VLLM_DOCS = "https://docs.vllm.ai/en/latest/features/tool_calling/";
const THINK: [string, string] = ["<think>", "</think>"];

export const TOOL_DIALECT_PRESETS: DialectPreset[] = [
  {
    id: "nemotron-3",
    label: "NVIDIA Nemotron 3 (Super, Nano, Ultra)",
    match: [/nemotron[-._ ]?(?:(?:super|nano|ultra)[-._ ]?)?3(?!\d)/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Nemotron 3 Super and Nano 3: structured 100%, no leak",
    textDialect: "qwen-xml",
    promptStyle: {
      style: "qwen-xml",
      evidence:
        "Super chat template writes calls in the Qwen3-Coder form (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "qwen-xml",
    thinkingTags: THINK,
    serverParser: {
      vllm: "qwen3_coder",
      basis: "model-card",
      note: "Nano 3 card also sets --reasoning-parser nano_v3 with its plugin file; the Super recipe and the Ultra card use nemotron_v3 (vLLM and SGLang; TensorRT-LLM names it nano-v3)",
    },
    source: [
      "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16/raw/main/chat_template.jinja",
      "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16/raw/main/chat_template.jinja",
      "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16/raw/main/README.md",
      "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
      "https://recipes.vllm.ai/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
    ],
    readOn: READ,
    unverified: [
      "Nemotron 3 Ultra: template and card read 2026-11-11 (plans/research/rq8-templates.md): the Qwen3-Coder markup, served with --reasoning-parser nemotron_v3 --tool-call-parser qwen3_coder; Nemotron 3.5 is not read and is assumed to follow the family",
      "Qwen3.5 and Ultra templates write a boolean argument as Python True/False; qwen-xml recovery accepts that for a boolean-typed parameter only",
      "Ultra card, read 2026-11-11: SGLang tool calls must send chat_template_kwargs {enable_thinking: true, force_nonempty_content: true}; for coding agents on vLLM it only advises {force_nonempty_content: true}. It is a template variable passed through the engines' chat_template_kwargs field, not an engine parameter: a recommendation, no request option is added (set it with extraBodyProperties)",
      "the Super recipe page was read only through a search summary",
    ],
  },
  {
    id: "nemotron-h",
    label: "NVIDIA Nemotron-H (4B-Instruct, 8B and 47B Reasoning)",
    match: [/nemotron[-._ ]?h(?![a-z])/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "none",
    promptStyle: {
      style: "codeblock",
      evidence:
        "prompted path, not parser: the 4B-Instruct, 8B and 47B Reasoning templates render no tools (no tools variable, no tool_calls branch, no tool role; read 2026-11-11); codeblock (core/tools/systemMessageTools) is the only existing prompted path and is UNTESTED on them",
    },
    source: [
      "https://huggingface.co/nvidia/Nemotron-H-8B-Reasoning-128K/raw/main/tokenizer_config.json",
      "https://huggingface.co/nvidia/Nemotron-H-47B-Reasoning-128K",
      "https://huggingface.co/nvidia/Nemotron-H-4B-Instruct-128K",
    ],
    readOn: READ,
    unverified: [
      "the 4B-Instruct, 8B and 47B Reasoning templates render no tools (read 2026-11-11); the family's tool template is Nano v2 (row nemotron-nano-v2)",
      "no live capture",
    ],
  },
  {
    id: "nemotron-nano-v2",
    label: "NVIDIA Nemotron Nano v2 (9B, 12B)",
    match: [/nemotron[-._ ]?(?:nano[-._ ]?)?(?:9b|12b)[-._ ]?v2/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "toolcall-json",
    promptStyle: {
      style: "toolcall-json",
      evidence:
        'Nano-9B-v2 template instructs <TOOLCALL>[{"name","arguments"}]</TOOLCALL> then <SPECIAL_12> (read 2026-11-11); a toolcall-json parser and a synthesised corpus fixture exist (nemotron-nano-v2-two-calls-one-array)',
    },
    source: [
      "https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2/raw/main/tokenizer_config.json",
    ],
    readOn: READ,
    unverified: [
      "format read in the Nano-9B-v2 chat template only; the fixture is built from the template, not recorded from a model",
      "a parser plugin (nemotron_toolcall_parser_no_streaming.py) is named in a repo commit listing seen through search; its use was not read",
      "no live capture; recoverWith is left unset so no request changes",
    ],
  },
  {
    id: "llama-nemotron",
    label: "Llama-3.x Nemotron (Super 49B, Ultra 253B)",
    match: [
      /llama[-._ ]?3[-._ ]?\d?[-._ ]?nemotron/,
      /llama[-._ ]nemotron/,
      /nemotron[-._ ](?:super|ultra|nano)[-._ ]?(?:49|51|70|8)b/,
    ],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "toolcall-json",
    promptStyle: {
      style: "toolcall-json",
      evidence:
        "Super 49B v1.5 template instructs the <TOOLCALL> form (read 2026-11-10); no parser built",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "llama_nemotron_json",
      basis: "model-card",
      note: "needs --tool-parser-plugin llama_nemotron_toolcall_parser_no_streaming.py from the model repository (Super 49B v1.5 card, vllm==0.9.2)",
    },
    source: [
      "https://huggingface.co/nvidia/Llama-3_3-Nemotron-Super-49B-v1_5",
      "https://huggingface.co/nvidia/Llama-3_3-Nemotron-Super-49B-v1_5/raw/main/tokenizer_config.json",
    ],
    readOn: READ,
    unverified: [
      "Super 49B v1.5 only; Ultra 253B and v1 were not read",
      "no recovery parser: no corpus fixture and no live capture",
    ],
  },
  {
    id: "qwen3-coder",
    label: "Qwen3-Coder (30B-A3B, 480B, Coder-Next)",
    // Not Qwen3-Next: its template is the Hermes JSON form (qwen3 row).
    match: [/qwen[-._ ]?3[-._ ]?coder|coder[-._ ]?next/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "most",
    measured:
      "Qwen3-Coder 30B: structured 7/8, 1/8 wrote a <function=...> block as text (qwen-xml recovered it); Coder-Next structured",
    textDialect: "qwen-xml",
    promptStyle: {
      style: "qwen-xml",
      evidence:
        "trained-in form; 1/8 Qwen3-Coder 30B replies wrote it as text and qwen-xml recovered it (live 2026-11-10)",
    },
    observedLeak: "qwen-xml",
    recoverWith: "qwen-xml",
    serverParser: {
      vllm: "qwen3_xml",
      basis: "vllm-docs",
      note: "qwen3_coder is also registered and is what the NVIDIA Nemotron 3 cards use for the same markup",
    },
    source: [
      "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/blob/main/chat_template.jinja",
      "https://huggingface.co/Qwen/Qwen3-Coder-Next/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "qwen3.5-3.8",
    label: "Qwen3.5, 3.6 and 3.8 (not Qwen3 or Qwen3-Next)",
    // Qwen3.5 and later write the Qwen3-Coder XML, not the Qwen3 Hermes JSON.
    // Read on 3.5, 3.6 and 3.8; Qwen3.7 has no open weights to read.
    match: [/qwen[-._ ]?3\.[5-9]/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured:
      "Strata Qwen3.8 Flash and Ollama Qwen3.6: structured 100%, no leak",
    textDialect: "qwen-xml",
    promptStyle: {
      style: "qwen-xml",
      evidence:
        "Qwen3.5, 3.6 and 3.8 templates instruct <tool_call><function=NAME><parameter=KEY> (read 2026-11-10); 100% structured on Converse, so unprompted",
    },
    recoverWith: "qwen-xml",
    thinkingTags: THINK,
    serverParser: {
      vllm: "qwen3_coder",
      basis: "model-card",
      note: "the Qwen3.5-27B and Qwen3.6-27B cards launch vLLM and SGLang with --tool-call-parser qwen3_coder (read 2026-11-10); the vLLM docs name qwen3_xml for Qwen3-Coder",
    },
    source: [
      "https://huggingface.co/Qwen/Qwen3.5-27B/blob/main/chat_template.jinja",
      "https://huggingface.co/Qwen/Qwen3.6-27B/blob/main/chat_template.jinja",
      "https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/chat_template.jinja",
      "https://huggingface.co/Qwen/Qwen3.6-27B/raw/main/README.md",
      LIVE,
    ],
    readOn: READ,
    unverified: [
      "Qwen3.7 has no open weights, so its template was not read; 3.7 ids resolve here by pattern",
    ],
  },
  {
    id: "qwen3",
    label: "Qwen3 (incl. Qwen3-Next), Qwen2.5, QwQ and Hermes",
    match: [/qwen[-._ ]?(?:3|2[.-]?5)|qwq|hermes/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Qwen3 32B: structured 100%, no leak",
    textDialect: "hermes-json",
    promptStyle: {
      style: "hermes-json",
      evidence:
        "Qwen3 and Hermes-3 templates instruct the <tool_call> JSON form (read 2026-11-10); 100% structured on Converse, so unprompted",
    },
    recoverWith: "hermes-json",
    thinkingTags: THINK,
    serverParser: {
      vllm: "hermes",
      basis: "vllm-docs",
      note: "the docs name Hermes 2/3, Qwen2.5 and QwQ; the Qwen3 template writes the same tags (read)",
    },
    source: [
      "https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/tokenizer_config.json",
      "https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct/raw/main/tokenizer_config.json",
      "https://huggingface.co/NousResearch/Hermes-3-Llama-3.1-8B/blob/main/tokenizer_config.json",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
    unverified: [
      "Qwen3-Next-80B-A3B-Instruct template re-read 2026-11-10 (Hermes JSON: 'return a json object with function name and arguments within <tool_call></tool_call> XML tags'); the Thinking variant was not read; Bedrock tool support for Qwen3-Next was not measured",
      "Qwen3.5 and later are a different row (qwen3.5-3.8): they write the Qwen3-Coder XML",
    ],
  },
  {
    id: "glm-5",
    label: "GLM-5",
    match: [/glm[-._ ]?5/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "GLM 5: structured 100%, no leak",
    textDialect: "glm-xml",
    promptStyle: {
      style: "glm-xml",
      evidence:
        "GLM-5 template instructs <tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value>...</tool_call> (read 2026-11-10); 100% structured on Converse, so unprompted",
    },
    recoverWith: "glm-xml",
    thinkingTags: THINK,
    serverParser: {
      vllm: "glm47",
      basis: "model-card",
      note: "the GLM-5 card launches vLLM with --tool-call-parser glm47 --reasoning-parser glm45 (read 2026-11-10)",
    },
    source: [
      "https://huggingface.co/zai-org/GLM-5/blob/main/chat_template.jinja",
      "https://huggingface.co/zai-org/GLM-5/raw/main/README.md",
      LIVE,
    ],
    readOn: READ,
    unverified: [
      "GLM-5.1 and later were not read; 5.x ids resolve here by pattern",
    ],
  },
  {
    id: "glm-4.7",
    label: "GLM-4.7 and 4.7-Flash",
    match: [/glm[-._ ]?4[-._ ]?7/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "GLM 4.7: structured 100%, no leak",
    textDialect: "glm-xml",
    promptStyle: {
      style: "glm-xml",
      evidence:
        "GLM-4.7 template instructs the arg_key/arg_value form (read 2026-11-10); 100% structured on Converse",
    },
    recoverWith: "glm-xml",
    thinkingTags: THINK,
    serverParser: { vllm: "glm47", basis: "vllm-docs" },
    source: [
      "https://huggingface.co/zai-org/GLM-4.7/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "glm-4.5-4.6",
    label: "GLM-4.5, 4.5-Air and 4.6",
    match: [/glm[-._ ]?4[-._ ]?[56]/],
    bedrockTools: "yes",
    toolsEvidence: "inferred",
    nativeOnConverse: "unmeasured",
    textDialect: "glm-xml",
    promptStyle: {
      style: "glm-xml",
      evidence:
        "GLM-4.5 and 4.6 templates instruct the arg_key/arg_value form (read 2026-11-10)",
    },
    recoverWith: "glm-xml",
    thinkingTags: THINK,
    serverParser: { vllm: "glm45", basis: "vllm-docs" },
    source: [
      "https://huggingface.co/zai-org/GLM-4.5/blob/main/chat_template.jinja",
      "https://huggingface.co/zai-org/GLM-4.6/blob/main/chat_template.jinja",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "not run live; tools are offered because the 4.7 and 5 runs and the template agree",
    ],
  },
  {
    id: "kimi-k2-thinking",
    label: "Kimi K2 Thinking",
    match: [/kimi[-._ ]?k2[-._ ]?thinking/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured:
      "structured 8/8; one <think>...</think> block leaked into the text of a reply to a tool result",
    textDialect: "kimi-tokens",
    recoverWith: "kimi-tokens",
    promptStyle: {
      style: "native",
      evidence:
        "8/8 structured on Converse (live 2026-11-10); the token form is recovered by kimi-tokens (self-hosted servers)",
    },
    observedLeak:
      "<think> block in text (lifted into reasoning by the Bedrock handlers)",
    thinkingTags: THINK,
    // Leaked into the text of a reply to a tool result (seen live 2026-11-10).
    thinkingInText: /kimi-k2-thinking/,
    serverParser: {
      vllm: "kimi_k2",
      basis: "vllm-docs",
      note: "named for Kimi-K2-Instruct",
    },
    source: [
      "https://huggingface.co/moonshotai/Kimi-K2-Thinking/blob/main/chat_template.jinja",
      "https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "kimi-k3",
    label: "Kimi K3 and K3.1 (XTML tags)",
    match: [/kimi[-._ ]?k3/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Kimi K3 and K3.1: structured 100%, no leak",
    // Not kimi-tokens: K3 writes its own tag form (encoding_k3.py), recovered
    // by kimi-xtml.
    textDialect: "kimi-xtml",
    recoverWith: "kimi-xtml",
    promptStyle: {
      style: "native",
      evidence:
        "100% structured on Converse (live 2026-11-10); the text form is the XTML call block <|open|>tools<|sep|><|open|>call tool=NAME index=N<|sep|><|open|>argument key=K type=T<|sep|>VALUE<|close|>argument<|sep|>...<|close|>call<|sep|><|close|>tools<|sep|> (encoding_k3.py, read 2026-11-10); recovered by kimi-xtml (self-hosted servers)",
    },
    serverParser: {
      vllm: "kimi_k3",
      basis: "registered-only",
      note: "the name is in vLLM's parser registry; the K3 card (read 2026-11-10) has no --tool-call-parser line",
    },
    source: [
      "https://huggingface.co/moonshotai/Kimi-K3/blob/main/encoding_k3.py",
      "https://huggingface.co/moonshotai/Kimi-K3/raw/main/README.md",
      LIVE,
    ],
    readOn: READ,
    unverified: [
      "the repository ships a Python encoder, not a Jinja template, so the template classifier cannot decide it",
      "encoding_k3.py renders history; the token ids of <|open|>, <|close|> and <|sep|> and what the model actually emits were not measured",
      "a call may carry a single <|open|>json type=object<|sep|> body in place of argument tags (_xtml_json_block); kimi-xtml refuses it",
    ],
  },
  {
    id: "kimi-k2",
    label: "Kimi K2 and K2.5",
    match: [/kimi[-._ ]?k2/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Kimi K2.5: structured 100%, no leak",
    textDialect: "kimi-tokens",
    recoverWith: "kimi-tokens",
    promptStyle: {
      style: "native",
      evidence: "100% structured on Converse (live 2026-11-10)",
    },
    serverParser: {
      vllm: "kimi_k2",
      basis: "vllm-docs",
      note: "named for Kimi-K2-Instruct",
    },
    source: [
      "https://huggingface.co/moonshotai/Kimi-K2-Instruct/blob/main/chat_template.jinja",
      "https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "minimax-m3",
    label: "MiniMax M3 (namespaced invoke tags)",
    match: [/minimax[-._ ]?m3/],
    // No M3 run exists: the answer is the M2 family's, by analogy. Marked
    // inferred so it is not read as a measurement; it keeps M3 on the tools
    // path the shared minimax row gave it.
    bedrockTools: "yes",
    toolsEvidence: "inferred",
    nativeOnConverse: "unmeasured",
    // Not minimax-xml: M3 changed the call block (see promptStyle); the
    // namespaced form is recovered by minimax-ns-xml.
    textDialect: "minimax-ns-xml",
    recoverWith: "minimax-ns-xml",
    promptStyle: {
      style: "native",
      evidence:
        'M3 template instructs ]<]minimax[>[<tool_call> then ]<]minimax[>[<invoke name="tool-name-1"> with each parameter as ]<]minimax[>[<param>value]<]minimax[>[</param>, closed by ]<]minimax[>[</invoke> and ]<]minimax[>[</tool_call> (read 2026-11-10; the namespace marker ]<]minimax[>[ is prepended to every tag); thinking is <mm:think>; recovered by minimax-ns-xml (self-hosted servers)',
    },
    thinkingTags: ["<mm:think>", "</mm:think>"],
    source: [
      "https://huggingface.co/MiniMaxAI/MiniMax-M3/blob/main/chat_template.jinja",
    ],
    readOn: READ,
    unverified: [
      "never run live: bedrockTools is inferred from the M2 family, and M2 uses <minimax:tool_call> (a different form)",
      "no serverParser read: the M3 card has no --tool-call-parser line",
      "the call form is read from the template's instruction text and history renderer, not from model output",
    ],
  },
  {
    id: "minimax-m2",
    label: "MiniMax M2 and M2.5",
    match: [/minimax/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "MiniMax M2 and M2.5: structured 100%, no leak",
    textDialect: "minimax-xml",
    recoverWith: "minimax-xml",
    promptStyle: {
      style: "native",
      evidence:
        "100% structured on Converse (live 2026-11-10); the vendor recommends a server parser over hand parsing",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "minimax_m2",
      basis: "model-card",
      note: "the M2 deployment guide pairs it with --reasoning-parser minimax_m2_append_think",
    },
    source: [
      "https://huggingface.co/MiniMaxAI/MiniMax-M2/raw/main/docs/vllm_deploy_guide.md",
      "https://huggingface.co/MiniMaxAI/MiniMax-M2/raw/main/docs/tool_calling_guide.md",
      "https://huggingface.co/MiniMaxAI/MiniMax-M2.5/blob/main/chat_template.jinja",
    ],
    readOn: READ,
  },
  {
    id: "deepseek-r1",
    label: "DeepSeek R1",
    match: [/deepseek[-._ ]?r1/],
    bedrockTools: "no",
    toolsEvidence: "proved",
    nativeOnConverse: "none",
    measured: "Bedrock refuses tools outright (2026-11-08)",
    textDialect: "deepseek-tokens",
    recoverWith: "deepseek-r1",
    promptStyle: {
      style: "codeblock",
      evidence:
        "Bedrock refuses tools (2026-11-08) and the V3.1 card says tool calls work in non-thinking mode only; codeblock is untested on R1",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "deepseek_v3",
      basis: "vllm-docs",
      note: "named for DeepSeek-R1-0528 with tool_chat_template_deepseekr1.jinja",
    },
    source: [
      VLLM_DOCS,
      "https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/main/tokenizer_config.json",
    ],
    readOn: READ,
    unverified: [
      "whether R1 emits its history format reliably was not established; the deepseek-r1 recovery is strict and opt-in, so a model that does not write it is left alone",
    ],
  },
  {
    id: "deepseek-v4",
    label: "DeepSeek V4 (DSML tool_calls block)",
    match: [/deepseek[-._ ]?(?:chat[-._ ]?)?v?4/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "dsml",
    recoverWith: "dsml",
    promptStyle: {
      style: "native",
      evidence:
        'V4 encoder instructs <｜DSML｜tool_calls><｜DSML｜invoke name="$TOOL_NAME"><｜DSML｜parameter name="$PARAMETER_NAME" string="true|false"> (encoding_dsv4.py, read 2026-11-10); the block is tool_calls where V3.2 writes function_calls',
    },
    thinkingTags: THINK,
    source: [
      "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/main/encoding/encoding_dsv4.py",
      "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/raw/main/README.md",
    ],
    readOn: READ,
    unverified: [
      "undecided by the template classifier: the V4 card says 'This release does not include a Jinja-format chat template' and ships encoding/encoding_dsv4.py, which the research tool does not fetch",
      "V4-Flash and V4-Pro exist on the Hub; only V4-Flash's encoder was read",
      "not run live; the V3.2 text filter marker (function_calls) does not match V4's tool_calls block",
      "no serverParser read (vLLM's registry has deepseek_v4; the pairing was not read)",
    ],
  },
  {
    id: "deepseek-v3.2",
    label: "DeepSeek V3.2",
    match: [/deepseek[-._ ]?(?:chat[-._ ]?)?v?3[.-]?2/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured:
      "DeepSeek V3.2: structured 8/8; all 8 also ended the text with a DSML function_calls fragment (always dropped)",
    textDialect: "dsml",
    recoverWith: "dsml",
    promptStyle: {
      style: "native",
      evidence:
        '8/8 structured on Converse (live 2026-11-10); the encoder instructs <｜DSML｜function_calls><｜DSML｜invoke name="$FUNCTION_NAME"><｜DSML｜parameter name="$PARAMETER_NAME" string="true|false"> (encoding_dsv32.py, read 2026-11-10)',
    },
    observedLeak: "DSML fragment after the structured call",
    thinkingTags: THINK,
    serverParser: {
      vllm: "deepseek_v32",
      basis: "registered-only",
      note: "the name is in vLLM's parser registry; the docs page does not list it",
    },
    source: [
      "https://huggingface.co/deepseek-ai/DeepSeek-V3.2/blob/main/encoding/encoding_dsv32.py",
      LIVE,
    ],
    readOn: READ,
    unverified: [
      "undecided by the template classifier: the repository has no Jinja template and ships encoding/encoding_dsv32.py, which the research tool does not fetch",
    ],
  },
  {
    id: "deepseek-v3-0324",
    label: "DeepSeek V3-0324 (R1 fenced tool-call layout)",
    match: [/deepseek[-._ ]?(?:chat[-._ ]?)?v?3[-._ ]?0324/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "deepseek-tokens",
    recoverWith: "deepseek-r1",
    promptStyle: {
      style: "native",
      evidence:
        "vLLM's tool_chat_template_deepseekv3.jinja tells the model to write the fenced layout; not measured, so native until measured",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "deepseek_v3",
      basis: "vllm-docs",
      note: "deepseek_v3 for V3-0324 with tool_chat_template_deepseekv3.jinja (docs)",
    },
    source: [
      VLLM_DOCS,
      "https://huggingface.co/deepseek-ai/DeepSeek-V3-0324/raw/main/tokenizer_config.json",
    ],
    readOn: READ,
    unverified: [
      "whether V3-0324 emits the fenced layout unprompted was not established; V3.1 and later use other layouts (the deepseek-v3 row)",
    ],
  },
  {
    id: "deepseek-v3",
    label: "DeepSeek V3 and V3.1",
    match: [/deepseek[-._ ]?(?:chat[-._ ]?)?v?3/],
    bedrockTools: "yes",
    toolsEvidence: "inferred",
    nativeOnConverse: "unmeasured",
    textDialect: "deepseek-tokens",
    recoverWith: "deepseek-v31",
    promptStyle: {
      style: "native",
      evidence:
        "V3.1 card describes a hand-written system prompt for its token form; not measured, so native until measured",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "deepseek_v31",
      basis: "vllm-docs",
      note: "deepseek_v31 for V3.1, deepseek_v3 for V3-0324 (docs)",
    },
    source: [
      "https://huggingface.co/deepseek-ai/DeepSeek-V3.1/blob/main/README.md",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "Bedrock returned toolUse for DeepSeek V3.2 on 2026-11-08; V3.1 itself was not run",
    ],
  },
  {
    id: "gpt-oss",
    label: "gpt-oss (Harmony)",
    match: [/gpt[-._ ]?oss/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "gpt-oss 20B and 120B: structured 100%, no leak",
    textDialect: "harmony",
    recoverWith: "harmony",
    promptStyle: {
      style: "native",
      evidence: "100% structured on Converse (live 2026-11-10)",
    },
    serverParser: { vllm: "openai", basis: "vllm-docs" },
    source: [
      "https://huggingface.co/openai/gpt-oss-120b/blob/main/chat_template.jinja",
      "https://developers.openai.com/cookbook/articles/openai-harmony",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
    unverified: ["reasoning is the Harmony analysis channel, not a tag pair"],
  },
  {
    id: "gemma-4",
    label: "Gemma 4",
    match: [/gemma[-._ ]?4/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "gemma4",
    promptStyle: {
      style: "native",
      evidence: "Gemma 4 template renders tools natively (read 2026-11-10)",
    },
    serverParser: {
      vllm: "gemma4",
      basis: "registered-only",
      note: "the name is in vLLM's parser registry; its pairing was not read",
    },
    source: [
      "https://huggingface.co/google/gemma-4-31B-it/blob/main/chat_template.jinja",
    ],
    readOn: READ,
    unverified: ["no recovery parser; the vLLM pairing was not read"],
  },
  {
    id: "gemma-3",
    label: "Gemma 3",
    match: [/gemma[-._ ]?3/],
    bedrockTools: "no",
    toolsEvidence: "proved",
    nativeOnConverse: "none",
    measured: "Gemma 3 27B: 0/8 calls, prose, code and refusals",
    textDialect: "none",
    promptStyle: {
      style: "codeblock",
      evidence:
        "0/8 calls with native tools (live 2026-11-10) and the template renders no tools; codeblock (core/tools/systemMessageTools) is the only existing prompted path and is UNTESTED on Gemma 3",
    },
    source: [
      "https://huggingface.co/unsloth/gemma-3-27b-it/blob/main/chat_template.jinja",
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "llama-4",
    label: "Llama 4 (Scout, Maverick)",
    match: [/llama[-._ ]?4/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "most",
    measured:
      "Llama 4 Maverick: structured 6/8; 2/8 wrote a JSON array whose arguments were wrapped as {type,value} objects (not recoverable)",
    textDialect: "pythonic",
    promptStyle: {
      style: "pythonic",
      evidence:
        "template instructs the [func(arg=v)] form (read 2026-11-10); live Maverick replies were JSON with wrapped values, so the prompted form is not proven",
    },
    observedLeak: "llama-json with wrapped values",
    recoverWith: "pythonic",
    serverParser: {
      vllm: "llama4_pythonic",
      basis: "vllm-docs",
      note: "the docs recommend it over llama3_json for Llama 4, with tool_chat_template_llama4_pythonic.jinja",
    },
    source: [
      "https://huggingface.co/unsloth/Llama-4-Scout-17B-16E-Instruct/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "llama-3.3",
    label: "Llama 3.3",
    match: [/llama[-._ ]?3[-._ ]?3/],
    bedrockTools: "with-recovery",
    toolsEvidence: "proved",
    nativeOnConverse: "none",
    measured:
      "Llama 3.3 70B: structured 0/8; JSON call in the text 8/8, 6/8 recovered by llama-json (2/8 carry a numeric string for an integer)",
    textDialect: "llama-json",
    promptStyle: {
      style: "llama-json",
      evidence:
        'template instructs {"name","parameters"} (read 2026-11-10); wrote exactly that as text 8/8 live',
    },
    observedLeak: "llama-json",
    recoverWith: "llama-json",
    serverParser: {
      vllm: "llama3_json",
      basis: "vllm-docs",
      note: "with --chat-template examples/tool_chat_template_llama3.1_json.jinja (or the 3.2 template)",
    },
    source: [
      "https://huggingface.co/unsloth/Llama-3.3-70B-Instruct/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "llama-3.1-3.2",
    label: "Llama 3.1 and 3.2",
    match: [/llama[-._ ]?3/],
    bedrockTools: "with-recovery",
    toolsEvidence: "inferred",
    nativeOnConverse: "unmeasured",
    textDialect: "llama-json",
    promptStyle: {
      style: "llama-json",
      evidence:
        'Meta 3.1 prompt format and the 3.3 template instruct {"name","parameters"}; not run live',
    },
    recoverWith: "llama-json",
    serverParser: {
      vllm: "llama3_json",
      basis: "vllm-docs",
      note: "Llama 3.2 1B/3B use pythonic with tool_chat_template_llama3.2_pythonic.jinja per the docs",
    },
    source: [
      "https://huggingface.co/unsloth/Llama-3.3-70B-Instruct/blob/main/chat_template.jinja",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "not run live; the format is the Llama 3.3 template's and Meta's 3.1 prompt format",
    ],
  },
  {
    id: "granite-4.2",
    label: "IBM Granite 4.2 (Qwen3-Coder XML)",
    match: [/granite[-._ ]?4[-._ ]?[2-9]/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "qwen-xml",
    promptStyle: {
      style: "qwen-xml",
      evidence:
        "granite-4.2-8b template instructs <tool_call>\\n<function=example_function_name>\\n<parameter=example_parameter_1> (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "qwen-xml",
    serverParser: {
      vllm: "qwen3_coder",
      basis: "model-card",
      note: "the card: 'Use --tool-call-parser auto, which resolves to qwen3_coder for this checkpoint'",
    },
    source: [
      "https://huggingface.co/ibm-granite/granite-4.2-8b/blob/main/chat_template.jinja",
      "https://huggingface.co/ibm-granite/granite-4.2-8b/raw/main/README.md",
    ],
    readOn: READ,
    unverified: [
      "granite-4.2-8b only; other 4.2 sizes and 4.1 were not read (4.1 resolves to the granite-4 row)",
      "not run on Bedrock, Ollama or OpenRouter: tools support is undecided here",
    ],
  },
  {
    id: "granite-4",
    label: "IBM Granite 4.0 (Hermes JSON)",
    match: [/granite[-._ ]?4/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "hermes-json",
    promptStyle: {
      style: "hermes-json",
      evidence:
        "granite-4.0-h-small template instructs 'return a json object with function name and arguments within <tool_call></tool_call> XML tags' (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "hermes-json",
    source: [
      "https://huggingface.co/ibm-granite/granite-4.0-h-small/blob/main/chat_template.jinja",
    ],
    readOn: READ,
    unverified: [
      "granite-4.0-h-small only; Granite 4.0 Micro, Tiny, 4.1 and the vLLM parser pairing were not read",
      "Granite 3.x writes <|tool_call|> and has its own row (granite-3)",
      "SmolLM3 writes the same <tool_call> JSON as Hermes (its template was read 2026-11-10) but has no row of its own",
    ],
  },
  {
    id: "mimo-v2",
    label: "Xiaomi MiMo V2.5 and V2.6 (Qwen3-Coder XML)",
    match: [/mimo[-._ ]?v2/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "qwen-xml",
    promptStyle: {
      style: "qwen-xml",
      evidence:
        "MiMo-V2.5 template instructs <tool_call>\\n<function=example_function_name>\\n<parameter=example_parameter_1>value_1</parameter> (read 2026-11-10); MiMo-V2.6-Flash-RL writes <tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call> in its history renderer",
    },
    recoverWith: "qwen-xml",
    thinkingTags: THINK,
    source: [
      "https://huggingface.co/XiaomiMiMo/MiMo-V2.5/blob/main/tokenizer_config.json",
      "https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL/blob/main/chat_template.jinja",
    ],
    readOn: READ,
    unverified: [
      "the V2.5 card names --tool-call-parser mimo in an SGLang command only; no vLLM pairing was read",
      "MiMo-V2.6-Flash-RL was read for its call writer only, not for an instruction block",
      "the Qwen3-Coder parser is not known to read the MiMo markup exactly; the arguments are not tested",
    ],
  },
  {
    id: "mimo",
    label: "Xiaomi MiMo (7B, Hermes JSON)",
    match: [/mimo(?![a-z])/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "hermes-json",
    promptStyle: {
      style: "hermes-json",
      evidence:
        "MiMo-7B-RL template instructs 'return a json object with function name and arguments within <tool_call></tool_call> XML tags' (read 2026-11-10)",
    },
    recoverWith: "hermes-json",
    source: [
      "https://huggingface.co/XiaomiMiMo/MiMo-7B-RL/blob/main/tokenizer_config.json",
    ],
    readOn: READ,
    unverified: ["MiMo-7B-RL only; other MiMo V1 checkpoints were not read"],
  },
  {
    id: "step-3.5-3.7",
    label: "StepFun Step 3.5 and 3.7 (Qwen3-Coder XML)",
    match: [/step[-._ ]?3[-._ ]?[57]/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "qwen-xml",
    promptStyle: {
      style: "qwen-xml",
      evidence:
        "Step-3.5-Flash and Step-3.7-Flash templates instruct <tool_call>\\n<function=example_function_name>\\n<parameter=example_parameter_1> (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "qwen-xml",
    serverParser: {
      vllm: "step3p5",
      basis: "model-card",
      note: "the Step-3.7-Flash card launches vLLM with --tool-call-parser step3p5 --reasoning-parser step3p5 (read 2026-11-10): its own parser name for the Qwen3-Coder markup",
    },
    source: [
      "https://huggingface.co/stepfun-ai/Step-3.5-Flash/blob/main/chat_template.jinja",
      "https://huggingface.co/stepfun-ai/Step-3.7-Flash/blob/main/chat_template.jinja",
      "https://huggingface.co/stepfun-ai/Step-3.7-Flash/raw/main/README.md",
    ],
    readOn: READ,
    unverified: [
      "Step-3.5-Flash and Step-3.7-Flash only; Step 4, 5 and the Step 3 VL models were not read",
    ],
  },
  {
    id: "liquid-lfm",
    label: "Liquid LFM2 and LFM2.5 (Pythonic list between call tokens)",
    match: [/lfm[-._ ]?[23]/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    // The call is a Python-style list wrapped in <|tool_call_start|> and
    // <|tool_call_end|>; `lfm-tokens` recovers it (wrapperDialects.ts).
    textDialect: "lfm-tokens",
    promptStyle: {
      style: "native",
      evidence:
        'LFM2.5-24B-A2B and LFM2-8B-A1B templates write <|tool_call_start|>[name(arg="v"), ...]<|tool_call_end|> (render_tool_calls, read 2026-11-10); the tool list is rendered as "List of tools: [" in the system prompt; never prompted for it by us',
    },
    recoverWith: "lfm-tokens",
    source: [
      "https://huggingface.co/LiquidAI/LFM2.5-24B-A2B/blob/main/chat_template.jinja",
      "https://huggingface.co/LiquidAI/LFM2-8B-A1B/blob/main/chat_template.jinja",
    ],
    readOn: READ,
    unverified: [
      "LFM3 (on OpenRouter as liquid/lfm-3-1.7b) was not read",
      "the JSON call mode LFM's docs mention (switched on by a system prompt line) is not recovered: its exact shape is not documented",
      "no live capture: lfm-tokens is built from the templates and docs.liquid.ai, corpus fixtures are synthesised",
    ],
  },
  {
    id: "hy3",
    label: "Tencent Hy3 (suffixed arg_key tags)",
    match: [/(?:^|[^a-z])hy[-._ ]?3(?!\d)/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    // GLM-like markup whose tags carry a ':opensource' suffix, so glm-xml does
    // not parse it; `hy3-tags` does (wrapperDialects.ts).
    textDialect: "hy3-tags",
    promptStyle: {
      style: "native",
      evidence:
        "Hy3 template instructs <tool_calls:opensource> then <tool_call:opensource>{function-name}<tool_sep:opensource> with <arg_key:opensource>/<arg_value:opensource> pairs, closed by </tool_call:opensource> and </tool_calls:opensource> (HYTK = ':opensource', read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "hy3-tags",
    thinkingTags: ["<think:opensource>", "</think:opensource>"],
    serverParser: {
      vllm: "hy_v3",
      basis: "model-card",
      note: "the Hy3 card launches vLLM with --tool-call-parser hy_v3 --reasoning-parser hy_v3 and SGLang with hunyuan (read 2026-11-10)",
    },
    source: [
      "https://huggingface.co/tencent/Hy3/blob/main/chat_template.jinja",
      "https://huggingface.co/tencent/Hy3/raw/main/README.md",
    ],
    readOn: READ,
    unverified: [
      "Hy4 and Hy3-preview were not read (the Hy4 repository answered 401, so it is missing or private)",
      "the HYTK suffix may differ between the open and hosted checkpoints; hy3-tags reads ':opensource' only",
      "no live capture: hy3-tags is built from the template and vLLM's hy_v3 parser, corpus fixtures are synthesised",
    ],
  },
  {
    id: "granite-3",
    label: "IBM Granite 3.x (<|tool_call|> JSON list)",
    match: [/granite[-._ ]?3/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "granite-tokens",
    promptStyle: {
      style: "native",
      evidence:
        "granite-3.3-8b-instruct template: 'respond only with <|tool_call|> followed by a JSON list of tools used' (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "granite-tokens",
    serverParser: {
      vllm: "granite",
      basis: "vllm-docs",
      note: "the vLLM tool-calling docs list granite-3.1-8b-instruct with --tool-call-parser granite and the Hub template used directly",
    },
    source: [
      "https://huggingface.co/ibm-granite/granite-3.3-8b-instruct/raw/main/tokenizer_config.json",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "granite-3.3-8b-instruct only; 3.0 and 3.1 were not read (vLLM's parser also accepts a <tool_call> prefix for 3.1, which granite-tokens does not)",
      "the shape of one list item comes from vLLM's granite parser and example template, not from the Hub card",
      "no live capture: corpus fixtures are synthesised",
    ],
  },
  {
    id: "solar-open",
    label: "Upstage Solar Open (<|tool_call:begin|> tokens)",
    match: [/solar[-._ ]?open/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "solar-tokens",
    promptStyle: {
      style: "native",
      evidence:
        "Solar-Open-100B template ('Tool Call Format'): <|tool_call:begin|><id><|tool_call:name|><name><|tool_call:args|><args-json-object><|tool_call:end|> (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "solar-tokens",
    serverParser: {
      vllm: "solar_open",
      basis: "model-card",
      note: "the card launches Upstage's vLLM fork with --tool-call-parser solar_open; the parser is not in vLLM's own registry",
    },
    source: [
      "https://huggingface.co/upstage/Solar-Open-100B/blob/main/chat_template.jinja",
      "https://huggingface.co/upstage/Solar-Open-100B/raw/main/README.md",
    ],
    readOn: READ,
    unverified: [
      "no live capture: corpus fixtures are synthesised",
      "the reasoning block (<|think|>...<|end|>) is not recovered around a call",
    ],
  },
  {
    id: "longcat-flash",
    label: "Meituan LongCat-Flash (<longcat_tool_call> JSON)",
    match: [/longcat/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "longcat-json",
    promptStyle: {
      style: "native",
      evidence:
        "LongCat-Flash-Chat template: 'return a json object with function name and arguments within <longcat_tool_call></longcat_tool_call> XML tags' (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "longcat-json",
    thinkingTags: ["<longcat_think>", "</longcat_think>"],
    serverParser: {
      vllm: "longcat",
      basis: "vllm-docs",
      note: "named for LongCat-Flash-Chat in the vLLM tool-calling docs",
    },
    source: [
      "https://huggingface.co/meituan-longcat/LongCat-Flash-Chat/raw/main/tokenizer_config.json",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "LongCat-Flash-Chat only; Thinking and Lite variants were not read",
      "no live capture: corpus fixtures are synthesised",
    ],
  },
  {
    id: "olmo-3",
    label: "AI2 Olmo 3 (<function_calls> Python calls)",
    match: [/olmo[-._ ]?3/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "olmo-function-calls",
    promptStyle: {
      style: "native",
      evidence:
        "Olmo-3-7B-Instruct template: 'Output any function calls within <function_calls></function_calls> XML tags', calls rendered as name(key=<json>) one per line (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "olmo-function-calls",
    serverParser: {
      vllm: "olmo3",
      basis: "vllm-docs",
      note: "named for Olmo-3-7B-Instruct and Olmo-3-32B-Think in the vLLM tool-calling docs",
    },
    source: [
      "https://huggingface.co/allenai/Olmo-3-7B-Instruct/blob/main/chat_template.jinja",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "Olmo-3-7B-Instruct only; the Think variants were not read",
      "no live capture: corpus fixtures are synthesised",
    ],
  },
  {
    id: "seed-oss",
    label: "ByteDance Seed-OSS (<seed:tool_call> XML)",
    match: [/seed[-._ ]?oss/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "seed-xml",
    promptStyle: {
      style: "native",
      evidence:
        "Seed-OSS-36B-Instruct template: <seed:tool_call><function=NAME><parameter=KEY>value</parameter></function></seed:tool_call> (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "seed-xml",
    thinkingTags: ["<seed:think>", "</seed:think>"],
    source: [
      "https://huggingface.co/ByteDance-Seed/Seed-OSS-36B-Instruct/blob/main/chat_template.jinja",
    ],
    readOn: READ,
    unverified: [
      "Seed-OSS-36B-Instruct only",
      "no live capture: corpus fixtures are synthesised",
    ],
  },
  {
    id: "cohere-command",
    label: "Cohere Command A and R7B (<|START_ACTION|> JSON)",
    match: [/command[-._ ]?(?:a(?![a-z])|r7b)/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "cohere-action",
    promptStyle: {
      style: "native",
      evidence:
        'Cohere docs (command-a-hf): "write <|START_ACTION|> followed by a list of JSON-formatted tool calls, with each one containing tool_name and parameters fields ... close it out with <|END_ACTION|>" (read 2026-11-10); never prompted for it by us',
    },
    recoverWith: "cohere-action",
    thinkingTags: ["<|START_THINKING|>", "<|END_THINKING|>"],
    source: ["https://docs.cohere.com/docs/command-a-hf"],
    readOn: READ,
    unverified: [
      "the Hub repositories are gated, so the template was not read: the form comes from the public docs",
      "Command R and R+ (2024) write a different, fenced form and are not matched",
      "no live capture: corpus fixtures are synthesised",
    ],
  },
  {
    id: "mistral",
    label: "Mistral, Mistral Large 3, Devstral, Codestral, Ministral",
    match: [/devstral|mistral|mixtral|ministral|magistral|codestral/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Devstral 2 and Mistral Large 3: structured 100%, no leak",
    textDialect: "mistral",
    recoverWith: "mistral",
    promptStyle: {
      style: "native",
      evidence:
        "Devstral 2 and Mistral Large 3: 100% structured on Converse (live 2026-11-10)",
    },
    serverParser: {
      vllm: "mistral",
      basis: "vllm-docs",
      note: "confirmed for Mistral-7B-Instruct-v0.3; recent models use the mistral-common tokenizer mode",
    },
    source: [
      "https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3/blob/main/tokenizer_config.json",
      "https://huggingface.co/unsloth/Devstral-Small-2507/blob/main/chat_template.jinja",
      "https://github.com/mistralai/mistral-common/blob/main/src/mistral_common/tokens/tokenizers/instruct.py",
      "https://github.com/mistralai/mistral-common/blob/main/src/mistral_common/tokens/tokenizers/base.py",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
    unverified: [
      'undecided upstream: Devstral-Small-2507 and Mistral-Small-3.2-24B-Instruct-2506 declare library_name mistral-common and carry no chat template in the API config or as chat_template.jinja (404, read 2026-11-10); their cards say "Supports Mistral\'s function calling format" and link the mistral-common docs, and serve with --tokenizer_mode mistral --tool-call-parser mistral',
      "call layouts, from mistral-common instruct.py and base.py (read 2026-11-11): array [TOOL_CALLS][{name, arguments, id?}] for tokenizer v3 and v7 (V7 inherits V3's encoder); [TOOL_CALLS]NAME[CALL_ID]ID[ARGS]{json} for v11; [TOOL_CALLS]NAME[ARGS]{json} for v13 and v15; the mistral dialect handles all three. Which released model uses which tokenizer version was not read",
      "the [TOOL_CALLS] [ form is read in the Mistral-7B-Instruct-v0.3 template (an older format) and in the unsloth mirror, not in any current official repository; Mistral Large 3, Devstral 2 and Ministral 3 were not read",
    ],
  },
  {
    id: "nova",
    label: "Amazon Nova",
    match: [/amazon\.nova|(?:^|[^a-z])nova[-._ ]?(?:pro|lite|micro|premier|2)/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured:
      "Nova Pro and Nova 2 Lite: structured 100% in the run; an earlier failure wrote present_plan(...) as text (ROADMAP H13)",
    textDialect: "pythonic",
    promptStyle: {
      style: "native",
      evidence:
        "100% structured on Converse (live 2026-11-10); pythonic leak seen earlier (ROADMAP H13) is the recoverable form",
    },
    observedLeak: "pythonic",
    recoverWith: "pythonic",
    thinkingTags: ["<thinking>", "</thinking>"],
    // Nova Pro/Lite/Micro/Premier only (seen live 2026-11-08); Nova 2 uses reasoningContent.
    thinkingInText: /nova-(?:pro|lite|micro|premier)/,
    source: [
      "https://docs.aws.amazon.com/nova/latest/userguide/tool-use.html",
      "https://docs.aws.amazon.com/nova/latest/userguide/prompting-tool-troubleshooting.html",
      LIVE,
    ],
    readOn: READ,
    unverified: ["no archived raw reply of the pythonic failure"],
  },
  {
    id: "claude",
    label: "Claude",
    match: [/claude/],
    bedrockTools: "yes",
    toolsEvidence: "inferred",
    nativeOnConverse: "all",
    textDialect: "none",
    promptStyle: {
      style: "native",
      evidence: "Anthropic tool use",
    },
    source: ["plans/model-families-2026-11.md"],
    readOn: READ,
    unverified: [
      "claude-2 and claude-instant have no tools (kept off in toolSupport.ts)",
    ],
  },
  {
    id: "grok",
    label: "Grok",
    match: [/grok/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "none",
    promptStyle: {
      style: "native",
      evidence:
        "xAI documents an OpenAI-style envelope only; raw format undocumented",
    },
    source: [
      "https://docs.x.ai/docs/guides/function-calling",
      "https://huggingface.co/xai-org/grok-2",
    ],
    readOn: READ,
    unverified: [
      "nothing public describes the raw tool-call text of a current Grok model (read 2026-11-11, plans/research/rq12-grok.md): xai-org publishes only Grok-1 and Grok-2 weights, and the Grok-2 template has no tool section; SGLang has no Grok tool parser",
      "tool_choice is documented for xAI's own API, undocumented and untested on Mantle",
    ],
  },
];
