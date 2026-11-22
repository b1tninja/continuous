import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { setPolicyExtras } from "../../../../redux/slices/uiSlice";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { ToolsSection } from "../ToolsSection";
import { PermissionsSection } from "./PermissionsSection";
import { ProtectionsView } from "./ProtectionsView";

const terminal = {
  mode: "scrub",
  source: "default",
  passEnv: [] as string[],
  allow: [] as string[],
  notices: [] as string[],
  hostEnvNames: ["PATH", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "EDITOR"],
  credentialUrlNames: [] as string[],
  platform: "linux",
};
const shadow = {
  form: { enabled: false, timeoutMs: 5000 } as Record<string, unknown>,
  trailEnabled: true,
  spentUsd: 0,
  reservedUsd: 0,
  reviews: 0,
};

function host(over: { terminal?: object; shadow?: object } = {}) {
  const ideMessenger = new MockIdeMessenger();
  const h = ideMessenger.responseHandlers as any;
  h["config/getTerminalEnvironment"] = async () => ({
    ...terminal,
    ...over.terminal,
  });
  h["audit/shadowSettings"] = async () => ({ ...shadow, ...over.shadow });
  return { ideMessenger, store: setupStore({ ideMessenger }) };
}

async function setup(
  over: Parameters<typeof host>[0] = {},
  ui: React.ReactElement = <ProtectionsView />,
  path?: string,
) {
  const { ideMessenger, store } = host(over);
  await renderWithProviders(ui, {
    store,
    mockIdeMessenger: ideMessenger,
    ...(path ? { routerProps: { initialEntries: [path] } as never } : {}),
  });
  await act(async () => {});
  return { store };
}

const summary = (id: string) =>
  screen.getByTestId(`fold-summary-${id}`).textContent;
const isOpen = (id: string) =>
  screen.getByTestId(`fold-toggle-${id}`).getAttribute("aria-expanded") ===
  "true";

beforeEach(() => localStorage.clear());

describe("Permissions, Protections", () => {
  it("shows the locks, then four folds closed, each with its state in one line", async () => {
    await setup();
    expect(screen.getByTestId("locks").textContent).toContain(
      "Protected paths",
    );
    for (const id of [
      "builtin-rules",
      "commands-secrets",
      "decision-timer",
      "shadow-review",
    ]) {
      expect(isOpen(id), id).toBe(false);
      expect(summary(id), id).toBeTruthy();
    }
    expect(summary("builtin-rules")).toBe("Not set: 11 of 11 on");
    expect(summary("commands-secrets")).toBe(
      "Not set: commands run with secret-named variables hidden. 2 hidden now, 2 passed",
    );
    expect(summary("decision-timer")).toBe(
      "Not set: off. A decision takes effect at once",
    );
    expect(summary("shadow-review")).toBe(
      "Not set: off. No call is sent to the reviewer a second time",
    );
  });

  it("the headers follow the state: a rule off, a timer, secrets shared, shadow review on", async () => {
    const { store } = await setup({
      terminal: { mode: "inherit", source: "user-config" },
      shadow: {
        form: { enabled: true, budgetUsd: 0.25, timeoutMs: 5000 },
        spentUsd: 0.05,
        reviews: 3,
      },
    });
    await act(async () => {
      store.dispatch(
        setPolicyExtras({
          builtin: { "protect-secrets": false },
          timer: { manual: 15 },
        }),
      );
    });
    expect(summary("builtin-rules")).toBe(
      "Set by you: 10 of 11 on. Off: Ask before touching credentials",
    );
    // Loosened: drawn in the warning colour
    expect(
      screen.getByTestId("fold-summary-builtin-rules").className,
    ).toContain("text-warning");
    expect(summary("decision-timer")).toBe("Set by you: asks wait Manual 15 s");
    expect(summary("commands-secrets")).toBe(
      "Set by you in config.yaml: commands see every variable, secrets included. 0 hidden now, 4 passed",
    );
    expect(
      screen.getByTestId("fold-summary-commands-secrets").className,
    ).toContain("text-warning");
    expect(summary("shadow-review")).toBe(
      "Set by you: on. $0.05 of $0.25 spent on 3 reviews",
    );
  });

  it("names who set the secrets mode when it was not the person", async () => {
    await setup({
      terminal: { mode: "allowlist", source: "env", envVar: "allowlist" },
    });
    expect(summary("commands-secrets")).toContain(
      "Set by the CONTINUE_TERMINAL_ENV environment variable: commands get only the basics and the variables you list.",
    );
  });

  it("a fold opens and closes from its header, and its content is one region", async () => {
    await setup();
    const toggle = screen.getByTestId("fold-toggle-decision-timer");
    const body = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(body?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(isOpen("decision-timer")).toBe(true);
    expect(body?.hidden).toBe(false);
    expect(body?.querySelector("[data-testid=decision-timer]")).not.toBeNull();
    fireEvent.click(toggle);
    expect(body?.hidden).toBe(true);
  });

  it("states the locked rules of permissions.yaml beside the locks", async () => {
    const { store } = await setup();
    expect(screen.queryByTestId("policy-floor")).toBeNull();
    await act(async () => {
      store.dispatch(setPolicyExtras({ floor: ["a", "b"] }));
    });
    expect(screen.getByTestId("policy-floor").textContent).toContain(
      "2 locked rules",
    );
  });

  it("the moved controls say Not set or Set by you, never a bare Default", async () => {
    await setup();
    const page = screen.getByTestId("protections").textContent ?? "";
    expect(page).not.toMatch(/\bDefault\b/);
    expect(page).not.toContain("from the default");
    expect(
      document.getElementById("shadow-review-budget-hint")?.textContent,
    ).toContain("Not set: shadow review cannot be turned on without one.");
    expect(
      document.getElementById("shadow-review-timeout-hint")?.textContent,
    ).toContain("Not set: 5000 ms.");
    expect(
      document
        .getElementById("shadow-review-budget")
        ?.getAttribute("placeholder"),
    ).toBeNull();
    expect(screen.getByTestId("terminal-env-note").textContent).toContain(
      'Not set: commands run in "Hide secrets (recommended)" mode.',
    );
  });
});

describe("what moved from Tools to Permissions", () => {
  const MOVED = [
    "policy-card",
    "skip-permission-confirm",
    "plans-and-questions",
    "builtin-rules",
    "decision-timer",
    "shadow-review",
    "terminal-env",
    "locks",
  ];

  it("is no longer on the Tools tab, which starts with the built-in tools", async () => {
    await setup({}, <ToolsSection />);
    for (const id of MOVED) expect(screen.queryByTestId(id), id).toBeNull();
    expect(screen.getByText("Built-in Tools")).toBeTruthy();
    expect(screen.getByText("MCP Servers")).toBeTruthy();
  });

  it("is on Permissions exactly once: Levels has the levels, Protections the rest", async () => {
    await setup({}, <PermissionsSection />);
    const levels = [
      "policy-card",
      "skip-permission-confirm",
      "plans-and-questions",
    ];
    for (const id of levels)
      expect(screen.getAllByTestId(id), id).toHaveLength(1);
    for (const id of MOVED.filter((m) => !levels.includes(m))) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    expect(summary("plans-questions")).toBe(
      "Not set: 5 new to-dos; you decide 4 of 6 kinds",
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("view-protections")),
    );
    await act(async () => {});
    for (const id of MOVED.filter((m) => !levels.includes(m))) {
      expect(screen.getAllByTestId(id), id).toHaveLength(1);
    }
    for (const id of levels) expect(screen.queryByTestId(id), id).toBeNull();
  });

  it("?view=protections&section=<id> opens that fold", async () => {
    await setup(
      {},
      <PermissionsSection />,
      "/config?tab=permissions&view=protections&section=shadow-review",
    );
    expect(isOpen("shadow-review")).toBe(true);
    expect(isOpen("builtin-rules")).toBe(false);
  });

  it("?view=levels&section=plans-questions opens Plans and questions under the levels", async () => {
    await setup(
      {},
      <PermissionsSection />,
      "/config?tab=permissions&view=levels&section=plans-questions",
    );
    expect(isOpen("plans-questions")).toBe(true);
    expect(screen.getByTestId("policy-max-new-items").textContent).toContain(
      "Not set: 5.",
    );
  });
});
