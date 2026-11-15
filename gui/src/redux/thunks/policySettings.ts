import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  parsePolicyLevel,
  type PolicyArea,
  type PolicyLevel,
  type PolicyLevels,
} from "core/tools/permissions/policy";
import type {
  PolicyFileUpdate,
  StoredCustomSet,
} from "core/tools/permissions/settingsFile";
import {
  setPolicyExtras,
  setPolicyLevel,
  setPolicyLevels,
  type PolicyExtras,
} from "../slices/uiSlice";
import { ThunkApiType } from "../store";

/**
 * The levels and settings live in the file the CLI shares
 * (~/.continuous/permissions.yaml); core reads and writes it, and never writes
 * IDGAF there. At startup the file replaces what the webview remembered,
 * except the areas the host says are at IDGAF in this editor session
 * (`policy/sessionIdgaf`): a webview reload or an extension host restart must
 * not drop IDGAF in the middle of an unattended run, and a new editor session
 * starts at the saved levels. The CLI has no such state: its levels last for
 * the process.
 */
export const loadPolicySettings = createAsyncThunk<void, void, ThunkApiType>(
  "policy/load",
  async (_, { dispatch, extra }) => {
    try {
      const res = await extra.ideMessenger.request("policy/load", undefined);
      if (res.status !== "success") return;
      const { settings, notices } = res.content;
      const session = await sessionIdgafAreas(extra.ideMessenger);
      dispatch(setPolicyLevels(keepIdgaf(session, settings.levels)));
      dispatch(
        setPolicyExtras({
          maxNewPlanItems: settings.maxNewPlanItems,
          questions: {
            youDecide: settings.questions?.youDecide,
            agentDecides: settings.questions?.agentDecides,
          },
          builtin: settings.builtin ?? {},
          floor: settings.floor ?? [],
          planMcpTools: settings.planMcpTools ?? [],
          trustedMcpServers: Object.keys(settings.mcpServers ?? {}),
          questionDelivery: settings.questions?.delivery,
          planAllowTerminal: settings.planAllowTerminal,
          customSet: settings.custom,
        }),
      );
      for (const notice of notices) console.warn(notice);
    } catch (e) {
      console.warn("Could not read the policy settings", e);
    }
  },
);

/** The file's levels, with every area the webview remembered at IDGAF kept there. */
export function keepIdgaf(
  sessionAreas: readonly string[],
  fromFile: PolicyLevels,
): PolicyLevels {
  const out = { ...fromFile };
  for (const area of Object.keys(out) as PolicyArea[]) {
    if (sessionAreas.includes(area)) out[area] = "idgaf";
  }
  return out;
}

type Messenger = ThunkApiType["extra"]["ideMessenger"];

/** The host's IDGAF areas for this editor session; none when it has none or cannot say. */
async function sessionIdgafAreas(messenger: Messenger): Promise<string[]> {
  try {
    const res = await messenger.request("policy/sessionIdgaf", {});
    return res.status === "success" ? res.content.areas : [];
  } catch {
    return [];
  }
}

/** Tells the host which areas are at IDGAF now, for the rest of the editor session. */
function rememberSessionIdgaf(messenger: Messenger, levels: PolicyLevels) {
  const areas = (Object.keys(levels) as PolicyArea[]).filter(
    (a) => parsePolicyLevel(levels[a]) === "idgaf",
  );
  void messenger
    .request("policy/sessionIdgaf", { areas })
    .catch(() => undefined);
}

/** Writes the levels (never IDGAF) and the settings a person can change. */
export const savePolicySettings = createAsyncThunk<void, void, ThunkApiType>(
  "policy/save",
  async (_, { getState, extra }) => {
    const { policyLevels, policyExtras } = getState().ui;
    const update: PolicyFileUpdate = {
      levels: policyLevels,
      ...(policyExtras.maxNewPlanItems !== undefined
        ? { maxNewPlanItems: policyExtras.maxNewPlanItems }
        : {}),
      questions: {
        ...(policyExtras.questions?.youDecide
          ? { youDecide: policyExtras.questions.youDecide }
          : {}),
        ...(policyExtras.questions?.agentDecides
          ? { agentDecides: policyExtras.questions.agentDecides }
          : {}),
      },
      builtin: policyExtras.builtin,
    };
    const res = await extra.ideMessenger.request("policy/save", update);
    if (res.status !== "success") {
      throw new Error(
        res.status === "error"
          ? res.error
          : "Could not save the policy settings",
      );
    }
  },
);

/** What the Custom policy page saves to permissions.yaml in one write. */
export interface CustomPolicySave {
  levels: PolicyLevels;
  extras: Pick<
    PolicyExtras,
    | "builtin"
    | "maxNewPlanItems"
    | "questions"
    | "questionDelivery"
    | "floor"
    | "trustedMcpServers"
    | "planMcpTools"
    | "planAllowTerminal"
  >;
  /**
   * The set to keep at `levels.custom` for the chip and for recall; absent
   * leaves what the file has (a preset's levels are not a custom set).
   */
  custom?: StoredCustomSet;
}

/**
 * The Custom policy page's save: the levels and every setting it shows, in
 * one write of permissions.yaml (core's writer: temp file and rename, other
 * keys and comments kept). On failure nothing in the page's state changes and
 * the error is the writer's sentence.
 */
export const saveCustomPolicy = createAsyncThunk<
  void,
  CustomPolicySave,
  ThunkApiType
>("policy/saveCustom", async (save, { dispatch, extra }) => {
  const update = customPolicyUpdate(save);
  const res = await extra.ideMessenger.request("policy/save", update);
  if (res.status !== "success") {
    throw new Error(
      res.status === "error" ? res.error : "Could not save the policy settings",
    );
  }
  dispatch(setPolicyLevels(save.levels));
  dispatch(
    setPolicyExtras({
      ...save.extras,
      ...(save.custom ? { customSet: save.custom } : {}),
    }),
  );
});

/**
 * The one permissions.yaml update the Custom policy page saves, and previews
 * with `policy/preview` before it does.
 */
export function customPolicyUpdate({
  levels,
  extras,
  custom,
}: CustomPolicySave): PolicyFileUpdate {
  return {
    levels,
    ...(extras.maxNewPlanItems !== undefined
      ? { maxNewPlanItems: extras.maxNewPlanItems }
      : {}),
    questions: {
      ...(extras.questionDelivery ? { delivery: extras.questionDelivery } : {}),
      ...(extras.questions?.youDecide
        ? { youDecide: extras.questions.youDecide }
        : {}),
      ...(extras.questions?.agentDecides
        ? { agentDecides: extras.questions.agentDecides }
        : {}),
    },
    builtin: extras.builtin ?? {},
    floor: extras.floor ?? [],
    trustedMcpServers: extras.trustedMcpServers ?? [],
    planMcpTools: extras.planMcpTools ?? [],
    planAllowTerminal: extras.planAllowTerminal ?? false,
    ...(custom ? { custom } : {}),
  };
}

export const changePolicyLevel = createAsyncThunk<
  void,
  { area: PolicyArea; level: PolicyLevel },
  ThunkApiType
>("policy/changeLevel", async (change, { dispatch, getState, extra }) => {
  const previous = getState().ui.policyLevels;
  dispatch(setPolicyLevel(change));
  const saved = await dispatch(savePolicySettings());
  if (savePolicySettings.rejected.match(saved)) {
    dispatch(setPolicyLevels(previous));
  }
  rememberSessionIdgaf(extra.ideMessenger, getState().ui.policyLevels);
});

export const applyPolicyPreset = createAsyncThunk<
  void,
  PolicyLevels,
  ThunkApiType
>("policy/applyPreset", async (levels, { dispatch, getState, extra }) => {
  const previous = getState().ui.policyLevels;
  dispatch(setPolicyLevels(levels));
  const saved = await dispatch(savePolicySettings());
  if (savePolicySettings.rejected.match(saved)) {
    dispatch(setPolicyLevels(previous));
  }
  rememberSessionIdgaf(extra.ideMessenger, getState().ui.policyLevels);
});

export const changePolicyExtras = createAsyncThunk<
  void,
  Partial<PolicyExtras>,
  ThunkApiType
>("policy/changeExtras", async (change, { dispatch, getState }) => {
  const previous = getState().ui.policyExtras;
  dispatch(setPolicyExtras(change));
  try {
    await dispatch(savePolicySettings()).unwrap();
  } catch (e) {
    // Not saved (the editor's own dialog said no, or the write failed): the
    // switch shows what the file still says
    const restore: Partial<PolicyExtras> = {};
    for (const key of Object.keys(change) as (keyof PolicyExtras)[]) {
      (restore as Record<string, unknown>)[key] = previous[key];
    }
    dispatch(setPolicyExtras(restore));
    console.warn("Could not save the policy settings", e);
  }
});
