import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ModelSelect from "../../../components/modelSelection/ModelSelect";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import {
  setProfiles,
  setSelectedProfile,
} from "../../../redux/slices/profilesSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import ConfigPage from "../index";
import { configFileName } from "./ActiveConfigBar";

const profile = (id: string, title: string, file: string) =>
  ({
    title,
    id,
    errors: [],
    uri: `file:///C:/Users/me/.continuous/${file}`,
    iconUrl: "",
    fullSlug: { ownerSlug: "", packageSlug: "", versionSlug: "" },
  }) as any;

const MAIN = profile("local", "Main Config", "config.yaml");
const BEDROCK = profile("bedrock", "Bedrock", "configs/bedrock.yaml");

async function openAt(path: string, activeId: string) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(<ConfigPage />, {
    store,
    mockIdeMessenger: ideMessenger,
    routerProps: { initialEntries: [path] } as never,
  });
  await act(async () => {
    store.dispatch(setProfiles([MAIN, BEDROCK]));
    store.dispatch(setSelectedProfile(activeId));
  });
  return view;
}

describe("the active config, named on every Settings tab", () => {
  it("shows its name and file above the tab's content", async () => {
    await openAt("/config?tab=models", "bedrock");
    const bar = screen.getByTestId("active-config-bar");
    expect(within(bar).getByTestId("active-config-name")).toHaveTextContent(
      "Bedrock",
    );
    expect(bar).toHaveTextContent("bedrock.yaml");
    expect(within(bar).getByRole("button", { name: "Switch" })).toBeTruthy();
  });

  it("follows the config that is switched to", async () => {
    await openAt("/config?tab=mcp", "local");
    expect(screen.getByTestId("active-config-name")).toHaveTextContent(
      "Main Config",
    );
  });

  it("is on every tab but Configs, where the list marks it", async () => {
    await openAt("/config?tab=rules", "bedrock");
    expect(screen.getByTestId("active-config-bar")).toBeTruthy();
  });

  it("is not drawn on the Configs tab, which marks the active row", async () => {
    await openAt("/config?tab=configs", "bedrock");
    expect(screen.queryByTestId("active-config-bar")).toBeNull();
    const rows = screen.getAllByTestId("config-row");
    const active = rows.filter((r) =>
      within(r).queryByTestId("config-active-badge"),
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent("Bedrock");
    expect(
      within(active[0]).getByTestId("config-active-badge"),
    ).toHaveTextContent("Active");
  });
});

describe("the model picker names the config its models come from", () => {
  it("shows the active config's name beside Models", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    const model = {
      title: "Sonnet",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    } as never;
    const { user } = await renderWithProviders(<ModelSelect />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    await act(async () => {
      store.dispatch(setProfiles([MAIN, BEDROCK]));
      store.dispatch(setSelectedProfile("bedrock"));
      store.dispatch(
        updateConfig({
          ...EMPTY_CONFIG,
          modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [model] },
          selectedModelByRole: {
            ...EMPTY_CONFIG.selectedModelByRole,
            chat: model,
          },
        } as never),
      );
    });
    await user.click(screen.getByTestId("model-select-button"));
    expect(await screen.findByTestId("model-select-config")).toHaveTextContent(
      "Bedrock",
    );
  });
});

describe("configFileName", () => {
  it("is the last part of a URI or a path", () => {
    expect(
      configFileName("file:///C:/Users/me/.continuous/configs/a%20b.yaml"),
    ).toBe("a b.yaml");
    expect(configFileName("C:\\Users\\me\\config.yaml")).toBe("config.yaml");
    expect(configFileName(undefined)).toBeUndefined();
  });
});
