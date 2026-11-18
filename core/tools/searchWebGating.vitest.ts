import { afterEach, expect, test, vi } from "vitest";
import { BuiltInToolNames } from "./builtIn";
import { getConfigDependentToolDefinitions } from "./index";

const params = {
  rules: [],
  enableExperimentalTools: false,
  isRemote: false,
  modelName: "",
  ide: {} as any,
};

afterEach(() => vi.unstubAllEnvs());

const find = async () =>
  (await getConfigDependentToolDefinitions(params)).find(
    (tool) => tool.function.name === BuiltInToolNames.SearchWeb,
  );

test("searchWeb tool is absent by default", async () => {
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "");
  expect(await find()).toBeUndefined();
});

test("searchWeb tool is offered with the user's own endpoint", async () => {
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "https://search.example.org/search");
  expect((await find())?.displayTitle).toBe("Search Web");
});

test("a malformed endpoint leaves the tool hidden", async () => {
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "file:///etc/passwd");
  expect(await find()).toBeUndefined();
});
