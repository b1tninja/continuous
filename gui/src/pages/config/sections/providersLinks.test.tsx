import { act, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import ModelSelect from "../../../components/modelSelection/ModelSelect";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import {
  setProfiles,
  setSelectedProfile,
} from "../../../redux/slices/profilesSlice";
import { setupStore } from "../../../redux/store";
import { CONFIG_ROUTES } from "../../../util/navigation";
import { renderWithProviders } from "../../../util/test/render";
import { ModelsSection } from "./ModelsSection";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

const PROFILE = {
  title: "Main Config",
  id: "local",
  errors: [],
  uri: "",
  iconUrl: "",
  fullSlug: { ownerSlug: "", packageSlug: "", versionSlug: "" },
} as any;

describe("Providers... links", () => {
  it("Settings > Models links to the Providers page", async () => {
    const { user } = await renderWithProviders(
      <>
        <ModelsSection />
        <Where />
      </>,
      { routerProps: { initialEntries: [CONFIG_ROUTES.MODELS] } as never },
    );
    await user.click(screen.getByRole("button", { name: "Providers…" }));
    expect(screen.getByTestId("where").textContent).toBe(
      CONFIG_ROUTES.PROVIDERS,
    );
  });

  it("the model picker's add/manage area links to the Providers page", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    const { user } = await renderWithProviders(
      <>
        <ModelSelect />
        <Where />
      </>,
      { store, mockIdeMessenger: ideMessenger },
    );
    const alpha = {
      title: "Alpha",
      model: "alpha",
      provider: "openai",
      underlyingProviderName: "openai",
    } as any;
    await act(async () => {
      store.dispatch(setProfiles([PROFILE]));
      store.dispatch(setSelectedProfile(PROFILE.id));
      store.dispatch(
        updateConfig({
          ...EMPTY_CONFIG,
          modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [alpha] },
          selectedModelByRole: {
            ...EMPTY_CONFIG.selectedModelByRole,
            chat: alpha,
          },
        }),
      );
    });
    await user.click(screen.getByTestId("model-select-button"));
    await user.click(await screen.findByText("Providers..."));
    expect(screen.getByTestId("where").textContent).toBe(
      CONFIG_ROUTES.PROVIDERS,
    );
  });
});
