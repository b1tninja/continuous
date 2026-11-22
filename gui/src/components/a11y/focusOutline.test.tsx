import { configureStore } from "@reduxjs/toolkit";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Provider } from "react-redux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { uiSlice } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import {
  applyForkState,
  history,
  setupForkStore,
} from "../../redux/thunks/forkSession.fixture";
import { UserSetting } from "../../pages/config/components/UserSetting";
import { renderWithProviders } from "../../util/test/render";
import ConfirmationDialog from "../dialogs/ConfirmationDialog";
import { QueryInput } from "../mainInput/AtMentionDropdown";
import InputToolbar from "../mainInput/InputToolbar";
import ModelSelectionListbox from "../modelSelection/ModelSelectionListbox";
import { ModelChecklist } from "../ProviderSetup/ModelChecklist";
import ResponseActions from "../StepContainer/ResponseActions";

// jsdom does not lay out or paint, so nothing here says an outline is seen.
// These tests say that the rule which draws it exists, and that the controls
// carry nothing that would switch it off.

const css = readFileSync(join(__dirname, "../../index.css"), "utf8");

/** The rules outside any @media block. */
function topLevelRules(source: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) {
        selector = text.slice(start, i).trim();
      }
      depth++;
      if (depth === 1) start = i + 1;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        rules.push({ selector, body: text.slice(start, i) });
        start = i + 1;
      }
    } else if (text[i] === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return rules;
}

const SUPPRESSES = /(^|:)outline-(none|hidden|0)$/;
// A class that draws focus some other way: a ring or an outline of its own
const REPLACES = /^focus(-visible|-within)?:(ring|outline)-(?!none|hidden|0)/;

function focusable(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "button, select, a[href], [role='button'], [tabindex]",
    ),
  );
}

/** Controls whose class list removes the outline and puts nothing back. */
function suppressedByClass(root: ParentNode): string[] {
  return focusable(root)
    .filter((el) => {
      const classes = Array.from(el.classList);
      return (
        classes.some((c) => SUPPRESSES.test(c)) &&
        !classes.some((c) => REPLACES.test(c))
      );
    })
    .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
}

/** Controls that a stylesheet rule (styled-components) strips the outline from. */
function suppressedByStylesheet(root: ParentNode): string[] {
  const found: string[] = [];
  const controls = focusable(root);
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!("selectorText" in rule)) continue;
      const { selectorText, cssText } = rule as CSSStyleRule;
      if (!/outline(-style)?:\s*(none|0)\b/.test(cssText)) continue;
      // The rule applies once the control has focus
      const selector = selectorText.replace(/:focus(-visible)?(?![-\w])/g, "");
      if (!selector.trim()) continue;
      for (const el of controls) {
        if (el.matches(selector)) {
          found.push(`${el.tagName.toLowerCase()} matches ${selectorText}`);
        }
      }
    }
  }
  return found;
}

describe("the focus outline rule", () => {
  const rules = topLevelRules(css);
  const outlineRules = rules.filter(
    (r) =>
      r.selector.includes(":focus-visible") &&
      // The high-contrast themes have their own, stronger rule
      !r.selector.includes("vscode-high-contrast") &&
      /outline\s*:/.test(r.body),
  );

  it("draws keyboard focus in the theme's focus colour", () => {
    expect(outlineRules).toHaveLength(1);
    expect(outlineRules[0].body).toMatch(
      /outline:\s*1px solid var\(--vscode-focusBorder\)/,
    );
  });

  it("leaves the prompt editor out", () => {
    expect(outlineRules[0].selector).toContain(":not(.ProseMirror)");
  });

  it("has no specificity, and nothing global removes the outline after it", () => {
    expect(outlineRules[0].selector).toMatch(/^:where\(.*\)$/);
    const removers = rules.filter(
      (r) =>
        /outline\s*:\s*(none|0)\b/.test(r.body) && /:focus\b/.test(r.selector),
    );
    // Only the zero-specificity reset, which comes first and so loses
    expect(removers.map((r) => r.selector)).toEqual([":where(:focus)"]);
    expect(css.indexOf(":where(:focus)")).toBeLessThan(
      css.indexOf(":where(:focus-visible"),
    );
  });
});

describe("controls do not switch the focus outline off", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("the input row", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 800,
      height: 24,
    } as DOMRect);
    const ideMessenger = new MockIdeMessenger();
    // Keep the startup config load from replacing the model set below
    ideMessenger.responseHandlers["config/getSerializedProfileInfo"] = () =>
      new Promise(() => {});
    const store = setupStore({ ideMessenger });
    const { container } = await renderWithProviders(
      <InputToolbar activeKey={null} onEnter={() => {}} isMainInput />,
      { store, mockIdeMessenger: ideMessenger },
    );
    // A model with thinking levels, so the Thinking select is in the row
    const model = {
      title: "Claude Opus",
      model: "claude-opus-4-1",
      provider: "anthropic",
      underlyingProviderName: "anthropic",
    };
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...EMPTY_CONFIG,
          selectedModelByRole: {
            ...EMPTY_CONFIG.selectedModelByRole,
            chat: model,
          },
          modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [model] },
        }),
      );
    });
    expect(await screen.findByTestId("thinking-effort")).toBeTruthy();
    expect(screen.getByTestId("submit-input-button")).toBeTruthy();
    expect(focusable(container).length).toBeGreaterThan(3);
    expect(suppressedByClass(container)).toEqual([]);
    expect(suppressedByStylesheet(container)).toEqual([]);
  });

  it("a reply's action buttons", async () => {
    const { store, ideMessenger } = setupForkStore();
    const { container } = await renderWithProviders(
      <ResponseActions
        index={2}
        item={history[2]}
        isLast={false}
        isTruncated={false}
        onDelete={() => {}}
        onContinueGeneration={() => {}}
      />,
      { store, mockIdeMessenger: ideMessenger },
    );
    await act(async () => applyForkState(store));
    const toolbar = screen.getByRole("toolbar", { name: "Message actions" });
    expect(focusable(toolbar).length).toBeGreaterThan(1);
    expect(suppressedByClass(container)).toEqual([]);
    expect(suppressedByStylesheet(container)).toEqual([]);
  });

  it("a dialog's buttons", () => {
    const store = configureStore({ reducer: { uiState: uiSlice.reducer } });
    const { container } = render(
      <Provider store={store}>
        <ConfirmationDialog text="Sure?" onConfirm={() => {}} />
      </Provider>,
    );
    expect(focusable(container)).toHaveLength(2);
    expect(suppressedByClass(container)).toEqual([]);
    expect(suppressedByStylesheet(container)).toEqual([]);
  });
});

// A text field inside a bordered wrapper keeps its own outline off, and the
// wrapper takes the focus colour instead, so the whole field lights up.
const LIGHTS_WRAPPER = /^focus-within:(border|ring|outline)-(?!none|hidden|0)/;

/** Text fields whose outline is off and whose wrappers show no focus. */
function fieldsWithNoFocusStyle(root: ParentNode): string[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "input:not([type='checkbox']), textarea",
    ),
  )
    .filter((el) => {
      if (!Array.from(el.classList).some((c) => SUPPRESSES.test(c))) {
        return false;
      }
      for (let up = el.parentElement; up; up = up.parentElement) {
        if (Array.from(up.classList).some((c) => LIGHTS_WRAPPER.test(c))) {
          return false;
        }
      }
      return true;
    })
    .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
}

describe("text fields in a bordered wrapper show focus on the wrapper", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("the model list's search box", () => {
    const provider = { title: "OpenRouter" };
    render(
      <ModelSelectionListbox
        selectedProvider={provider}
        setSelectedProvider={() => {}}
        topOptions={[provider]}
        searchPlaceholder="Search providers..."
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const search = screen.getByPlaceholderText("Search providers...");
    expect(search.className).toMatch(/outline-hidden/);
    expect(fieldsWithNoFocusStyle(document.body)).toEqual([]);
  });

  it("the model checklist's search box", () => {
    render(
      <ModelChecklist
        groups={{ top: [], other: [], configuredOnly: [] }}
        checked={new Set()}
        onToggle={() => {}}
      />,
    );
    const search = screen.getByLabelText("Search models");
    expect(search.className).toMatch(/outline-hidden/);
    expect(fieldsWithNoFocusStyle(document.body)).toEqual([]);
  });

  it("a number setting and a text setting", () => {
    render(
      <>
        <UserSetting
          type="number"
          title="Font size"
          description=""
          value={14}
          onChange={() => {}}
        />
        <UserSetting
          type="input"
          title="Workspace prompt"
          description=""
          value=""
          onChange={() => {}}
        />
      </>,
    );
    const fields = document.querySelectorAll("input");
    expect(fields).toHaveLength(2);
    fields.forEach((field) =>
      expect(field.className).toMatch(/outline-hidden/),
    );
    expect(fieldsWithNoFocusStyle(document.body)).toEqual([]);
  });

  it("the @-mention query box colours its own border", () => {
    render(<QueryInput data-testid="query" />);
    const field = screen.getByTestId("query");
    const focusRules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter(
        (rule): rule is CSSStyleRule =>
          "selectorText" in rule &&
          /:focus(?![-\w])/.test((rule as CSSStyleRule).selectorText) &&
          field.matches(
            (rule as CSSStyleRule).selectorText.replace(/:focus(?![-\w])/g, ""),
          ),
      );
    expect(focusRules).toHaveLength(1);
    expect(focusRules[0].cssText).toMatch(/outline:\s*none/);
    expect(focusRules[0].cssText).toMatch(
      /border-color:\s*var\(--vscode-focusBorder/,
    );
  });
});
