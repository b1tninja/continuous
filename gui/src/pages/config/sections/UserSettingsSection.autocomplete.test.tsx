import { act, screen } from "@testing-library/react";
import { DEFAULT_AUTOCOMPLETE_OPTS } from "core/util/parameters";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setConfigResult } from "../../../redux/slices/configSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { UserSettingsSection } from "./UserSettingsSection";

/** The number input on the same settings row as `title`. */
function numberFor(title: string): HTMLInputElement {
  let row: HTMLElement | null = screen.getByText(title);
  while (row && !row.querySelector('input[type="number"]')) {
    row = row.parentElement;
  }
  return row!.querySelector('input[type="number"]') as HTMLInputElement;
}

async function renderWith(tabAutocompleteOptions: object | undefined) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<UserSettingsSection />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  // After mount, so a config load started by the providers does not replace it
  await act(async () => {
    store.dispatch(
      setConfigResult({
        config: {
          ...store.getState().config.config,
          tabAutocompleteOptions,
        },
        errors: undefined,
        configLoadInterrupted: false,
      }),
    );
  });
  return store;
}

describe("UserSettingsSection autocomplete defaults", () => {
  it("shows the debounce and timeout autocomplete really uses when unset", async () => {
    const store = await renderWith(undefined);
    expect(
      store.getState().config.config.tabAutocompleteOptions?.debounceDelay,
    ).toBeUndefined();
    expect(numberFor("Autocomplete Debounce (ms)").value).toBe(
      String(DEFAULT_AUTOCOMPLETE_OPTS.debounceDelay),
    );
    expect(numberFor("Autocomplete Debounce (ms)").value).toBe("350");
    expect(numberFor("Autocomplete Timeout (ms)").value).toBe(
      String(DEFAULT_AUTOCOMPLETE_OPTS.modelTimeout),
    );
  });

  it("shows a configured value over the default", async () => {
    await renderWith({ debounceDelay: 123 });
    expect(numberFor("Autocomplete Debounce (ms)").value).toBe("123");
  });
});
