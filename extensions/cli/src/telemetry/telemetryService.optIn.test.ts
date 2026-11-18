import { afterEach, describe, expect, it, vi } from "vitest";

import { telemetryService } from "./telemetryService.js";

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OTEL_KEYS = [
  "CONTINUOUS_OTEL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_METRICS_EXPORTER",
];

function loadConfig(env: Record<string, string>) {
  const saved = { ...process.env };
  for (const k of OTEL_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return (telemetryService as any).loadConfig();
  } finally {
    process.env = saved;
  }
}

describe("CLI metrics opt-in", () => {
  afterEach(() => vi.clearAllMocks());

  it("stays off when only OTEL_* variables are set", () => {
    expect(
      loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })
        .enabled,
    ).toBe(false);
    expect(loadConfig({ OTEL_METRICS_EXPORTER: "otlp" }).enabled).toBe(false);
  });

  it("stays off with CONTINUOUS_OTEL=1 but no exporter or endpoint", () => {
    expect(loadConfig({ CONTINUOUS_OTEL: "1" }).enabled).toBe(false);
  });

  it("needs CONTINUOUS_OTEL to be exactly 1", () => {
    expect(
      loadConfig({
        CONTINUOUS_OTEL: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      }).enabled,
    ).toBe(false);
  });

  it("is on with the explicit setting and an endpoint", () => {
    expect(
      loadConfig({
        CONTINUOUS_OTEL: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      }).enabled,
    ).toBe(true);
  });
});
