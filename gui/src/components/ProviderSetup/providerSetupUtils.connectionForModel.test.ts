import type { ProviderSetupConnection } from "core/config/providerSetup";
import { describe, expect, it } from "vitest";
import { connectionForModel } from "./providerSetupUtils";

const conn = (
  provider: string,
  names: string[],
  connection = {},
): ProviderSetupConnection =>
  ({
    provider,
    connection,
    models: names.map((name) => ({ name, model: `id-${name}` })),
  }) as unknown as ProviderSetupConnection;

describe("connectionForModel", () => {
  const connections = [
    conn("bedrock", ["Opus (Bedrock)", "Haiku (Bedrock)"], {
      region: "us-east-1",
    }),
    conn("bedrock-mantle", ["GPT Sol"], { region: "us-east-2" }),
  ];

  it("finds the connection that lists the model", () => {
    expect(connectionForModel(connections, "GPT Sol")?.provider).toBe(
      "bedrock-mantle",
    );
    expect(
      connectionForModel(connections, "Haiku (Bedrock)")?.connection,
    ).toEqual({ region: "us-east-1" });
  });

  it("is undefined for a model no connection lists", () => {
    expect(connectionForModel(connections, "Other")).toBeUndefined();
  });

  it("is undefined without a title or without connections", () => {
    expect(connectionForModel(connections, undefined)).toBeUndefined();
    expect(connectionForModel(connections, "")).toBeUndefined();
    expect(connectionForModel([], "GPT Sol")).toBeUndefined();
  });

  it("takes the first connection when two list the same name", () => {
    const two = [conn("a", ["X"]), conn("b", ["X"])];
    expect(connectionForModel(two, "X")?.provider).toBe("a");
  });
});
