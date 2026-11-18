import { vi } from "vitest";

export const getLlmApi =
  vi.fn<
    (
      config: any,
      authConfig: any,
      modelConfig?: any,
      orgScopeId?: string,
    ) => [any, any]
  >();
export const getModel = vi.fn<(config: any, modelName: string) => any>();
export const createLlmApi = vi.fn<(model: any, authConfig: any) => any>();
