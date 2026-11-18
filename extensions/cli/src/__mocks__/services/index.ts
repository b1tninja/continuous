import { vi } from "vitest";

export const services = {
  auth: {
    login: vi.fn(() => Promise.resolve({})),
    logout: vi.fn(() => Promise.resolve({})),
    switchOrganization: vi.fn(() => Promise.resolve({})),
    getAvailableOrganizations: vi.fn(() => Promise.resolve([])),
  },
  toolPermissions: {
    isAllowed: vi.fn(() => Promise.resolve(true)),
    shouldAsk: vi.fn(() => Promise.resolve(false)),
    handleToolCall: vi.fn(() => Promise.resolve({ allowed: true })),
  },
};

export const reloadService = vi.fn(() => Promise.resolve(undefined));

export const SERVICE_NAMES = {
  AUTH: "auth",
  CONFIG: "config",
  MODEL: "model",
  MCP: "mcp",
  TOOL_PERMISSIONS: "toolPermissions",
  FILE_INDEX: "fileIndex",
  RESOURCE_MONITORING: "resourceMonitoring",
  SYSTEM_MESSAGE: "systemMessage",
  CHAT_HISTORY: "chatHistory",
  UPDATE: "update",
  AGENT_FILE: "agentFile",
} as const;
