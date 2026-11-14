import { z } from "zod";
import { baseDevDataAllSchema } from "../base.js";

export const chatInteractionEventAllSchema = baseDevDataAllSchema.extend({
  modelProvider: z.string(),
  modelName: z.string(),
  modelTitle: z.string(),
  /**
   * The full texts. The local dev_data copy no longer keeps them (sizes and a
   * hash instead) unless the debug prompt log is on; a `data` destination
   * you configured still receives them.
   */
  prompt: z.string().optional(),
  completion: z.string().optional(),
  promptBytes: z.number().optional(),
  completionBytes: z.number().optional(),
  promptSha256: z.string().optional(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  sessionId: z.string(),
  tools: z.array(z.string()).optional(),
  rules: z
    .array(
      z.object({
        id: z.string(),
        slug: z.string().optional(),
      }),
    )
    .optional(),
});
