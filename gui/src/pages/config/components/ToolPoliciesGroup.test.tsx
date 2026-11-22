import { act, fireEvent, screen } from "@testing-library/react";
import { Tool } from "core";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import {
  setToolPolicy,
  toggleToolGroupSetting,
} from "../../../redux/slices/uiSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import {
  groupPolicyResultText,
  groupPolicyState,
  groupPolicyTargets,
} from "./toolGroupPolicy";
import { ToolPoliciesGroup } from "./ToolPoliciesGroup";

const tool = (name: string, extra: Partial<Tool> = {}): Tool =>
  ({
    type: "function",
    function: { name: `github_${name}`, description: name },
    displayTitle: name,
    originalFunctionName: name,
    group: "github",
    readonly: false,
    ...extra,
  }) as Tool;

const TOOLS = [
  tool("list_issues"),
  tool("create_issue"),
  tool("get_pull_request"),
  tool("delete_repository"),
  tool("search_code", { mcpPendingApproval: "added" }),
];

async function setup(
  props: Partial<Parameters<typeof ToolPoliciesGroup>[0]> = {},
) {
  const ideMessenger = new MockIdeMessenger();
  const info: any = structuredClone(
    ideMessenger.responses["config/getSerializedProfileInfo"],
  );
  info.result.config.tools = TOOLS;
  ideMessenger.responses["config/getSerializedProfileInfo"] = info;
  const store = setupStore({ ideMessenger });
  // the person excluded one tool; another waits for approval
  store.dispatch(
    setToolPolicy({ toolName: "github_delete_repository", policy: "disabled" }),
  );
  await renderWithProviders(
    <ToolPoliciesGroup
      showIcon
      groupName="github"
      displayName="Tools"
      allToolsOff={false}
      duplicateDetection={{}}
      setAllPolicy
      {...props}
    />,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {});
  return { store };
}

const control = () =>
  screen.getByRole("button", { name: /policy for all tools of github$/ });

async function setAll(option: string) {
  await act(async () => {
    fireEvent.click(control());
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name: option }));
  });
}

describe("ToolPoliciesGroup: set all tools of a server", () => {
  it("one action changes every offered tool, and skips and counts the rest", async () => {
    const { store } = await setup();
    expect(control()).toHaveTextContent("All: Ask First");

    await setAll("Set all to Automatic");

    const settings = store.getState().ui.toolSettings;
    expect(settings.github_list_issues).toBe("allowedWithoutPermission");
    expect(settings.github_create_issue).toBe("allowedWithoutPermission");
    expect(settings.github_get_pull_request).toBe("allowedWithoutPermission");
    // excluded by hand: stays off
    expect(settings.github_delete_repository).toBe("disabled");
    // waits for approval: not decided for the person
    expect(settings.github_search_code).not.toBe("allowedWithoutPermission");
    expect(control()).toHaveTextContent("All: Automatic");
    expect(screen.getByRole("status")).toHaveTextContent(
      "3 set to Automatic. 2 skipped: excluded or waiting for approval.",
    );
  });

  it("a tool set by hand afterwards keeps its own value, and the header says Mixed", async () => {
    const { store } = await setup();
    await setAll("Set all to Automatic");

    await act(async () => {
      store.dispatch(
        setToolPolicy({
          toolName: "github_create_issue",
          policy: "allowedWithPermission",
        }),
      );
    });

    const settings = store.getState().ui.toolSettings;
    expect(settings.github_create_issue).toBe("allowedWithPermission");
    expect(settings.github_list_issues).toBe("allowedWithoutPermission");
    expect(control()).toHaveTextContent("Mixed");

    await setAll("Set all to Ask First");
    expect(store.getState().ui.toolSettings.github_list_issues).toBe(
      "allowedWithPermission",
    );
    expect(control()).toHaveTextContent("All: Ask First");
  });

  it("does not open or close the tool list", async () => {
    await setup();
    await setAll("Set all to Automatic");
    expect(screen.queryByTestId("tool-policy-item-github_list_issues")).toBe(
      null,
    );
  });

  it("is disabled while the group is off or the mode offers no tools", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(toggleToolGroupSetting("github"));
    });
    expect(control()).toBeDisabled();
  });

  it("is not drawn for a group that did not ask for it", async () => {
    await setup({ setAllPolicy: false });
    expect(
      screen.queryByRole("button", { name: /policy for all tools of github$/ }),
    ).toBe(null);
  });
});

describe("toolGroupPolicy", () => {
  it("reads a tool without a stored setting by its default", () => {
    const tools = [
      tool("a", { defaultToolPolicy: "allowedWithoutPermission" }),
      tool("b"),
    ];
    const { targets, skipped } = groupPolicyTargets(tools, {});
    expect(skipped).toBe(0);
    expect(groupPolicyState(targets, {})).toBe("mixed");
    expect(
      groupPolicyState(targets, { github_b: "allowedWithoutPermission" }),
    ).toBe("allowedWithoutPermission");
  });

  it("has no state when no tool can be set", () => {
    const { targets, skipped } = groupPolicyTargets([tool("a")], {
      github_a: "disabled",
    });
    expect(skipped).toBe(1);
    expect(groupPolicyState(targets, {})).toBe(undefined);
  });

  it("leaves the skipped part out when nothing was skipped", () => {
    expect(groupPolicyResultText("allowedWithPermission", 4, 0)).toBe(
      "4 set to Ask First.",
    );
  });
});
