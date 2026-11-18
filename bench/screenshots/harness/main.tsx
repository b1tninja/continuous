// Screenshot harness entry. URL query:
//   ?fixture=<name>&theme=dark|light|hc&font=<px>
// Renders the real <App/> against the real redux store with MockIdeMessenger,
// then sets `window.__shotReady = true` once the fixture is applied and the
// page has settled, so the driver knows when to take the picture.
import { IdeMessengerProvider } from "@gui/context/IdeMessenger";
import { MockIdeMessenger } from "@gui/context/MockIdeMessenger";
import { setupStore } from "@gui/redux/store";
import { setLocalStorage } from "@gui/util/localStorage";
import { shouldForwardProp } from "@gui/styles/shouldForwardProp";
import App from "@gui/App";
import { BedrockConnectionTester } from "@gui/forms/BedrockConnectionTester";
import { ProviderSetupFlow } from "@gui/components/ProviderSetup/ProviderSetupFlow";
import "@gui/index.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import { StyleSheetManager } from "styled-components";
import { FIXTURES, seedMessenger, sendConfig } from "./fixtures";
import { LoopFrameDemo } from "./LoopFrameDemo";
import { applyTheme, type ThemeName } from "./themes";

declare global {
  interface Window {
    __shotReady?: boolean;
    __shotError?: string;
    __store?: unknown;
  }
}

const params = new URLSearchParams(window.location.search);
const themeParam = params.get("theme");
const theme: ThemeName =
  themeParam === "light" || themeParam === "hc" ? themeParam : "dark";
const fixtureName = params.get("fixture") ?? "idle";

// A webview has no `process`. core/util/scrubEnvironment.ts reads
// `process.platform` when no platform is passed, and Settings > Tools reaches it
// (TerminalEnvironmentControl), so without this shim that page shows the error
// boundary here. ?noProcessShim=1 leaves the page as a real webview has it.
if (params.get("noProcessShim") !== "1" && typeof process === "undefined") {
  (globalThis as any).process = { platform: "win32", env: {} };
}

async function main() {
  try {
    applyTheme(theme);
    try {
      localStorage.setItem("ide", JSON.stringify("vscode"));
      const font = params.get("font");
      if (font) localStorage.setItem("fontSize", JSON.stringify(Number(font)));
    } catch {
      // storage can be blocked; the defaults are fine
    }
    // a person who is past first-run onboarding
    setLocalStorage("onboardingStatus", "Completed");
    setLocalStorage("hasDismissedOnboardingCard", true);
    const messenger = new MockIdeMessenger();
    seedMessenger(messenger);
    const store = setupStore({ ideMessenger: messenger });
    window.__store = store;
    // jsdom has no ResizeObserver issue in a real browser; nothing to stub.
    const root = ReactDOM.createRoot(document.getElementById("root")!);
    root.render(
      <React.StrictMode>
        <StyleSheetManager shouldForwardProp={shouldForwardProp}>
          <IdeMessengerProvider messenger={messenger}>
            <Provider store={store}>
              {fixtureName.startsWith("catalogue") ? (
                <div className="bg-background text-foreground p-2">
                  <ProviderSetupFlow
                    initialProvider="openrouter"
                    onDone={() => {}}
                  />
                </div>
              ) : fixtureName.startsWith("bedrock") ? (
                <div className="bg-background text-foreground p-2">
                  <BedrockConnectionTester
                    connection={{ region: "eu-west-1" }}
                    model="anthropic.claude-sonnet-4-5-20250929-v1:0"
                    canTest
                    onModelsLoaded={() => {}}
                  />
                </div>
              ) : fixtureName.startsWith("loop-frame-") ? (
                <LoopFrameDemo
                  state={fixtureName.slice("loop-frame-".length) as never}
                  animate={params.get("animate") === "1"}
                />
              ) : (
                <App />
              )}
            </Provider>
          </IdeMessengerProvider>
        </StyleSheetManager>
      </React.StrictMode>,
    );
    // let the first render and the initial config load finish
    await new Promise((r) => setTimeout(r, 400));
    sendConfig(messenger);
    await new Promise((r) => setTimeout(r, 200));
    const fixture = FIXTURES[fixtureName];
    if (!fixture) throw new Error(`Unknown fixture: ${fixtureName}`);
    await fixture({
      store,
      messenger,
      navigate: (path) =>
        messenger.mockMessageToWebview("navigateTo", { path, toggle: false }),
    });
    await new Promise((r) => setTimeout(r, 500));
    // fonts and layout
    await document.fonts?.ready;
    window.__shotReady = true;
  } catch (e) {
    window.__shotError = String((e as Error)?.stack ?? e);
    window.__shotReady = true;
  }
}

void main();
