import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  type PolicyArea,
  type PolicyLevel,
  type PolicyLevels,
} from "core/tools/permissions/policy";
import type { PolicyPresetName } from "core/tools/permissions/policy";
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
import { settingsOfPreset } from "./presetChecks";

/**
 * The levels and settings live in the file the CLI shares
 * (~/.continuous/permissions.yaml); core reads and writes it. IDGAF is a
 * preset: its levels and its switches are saved like any other preset's, and
 * nothing here treats it as a mode that lasts for a session.
 */
export const loadPolicySettings = createAsyncThunk<void, void, ThunkApiType>(
  "policy/load",
  async (_, { dispatch, extra }) => {
    try {
      const res = await extra.ideMessenger.request("policy/load", undefined);
      if (res.status !== "success") return;
      const { settings, notices } = res.content;
      dispatch(setPolicyLevels(settings.levels));
      dispatch(
        setPolicyExtras({
          maxNewPlanItems: settings.maxNewPlanItems,
          questions: {
            youDecide: settings.questions?.youDecide,
            agentDecides: settings.questions?.agentDecides,
          },
          builtin: settings.builtin,
          floor: settings.floor ?? [],
          planMcpTools: settings.planMcpTools ?? [],
          backgroundMcpTools: settings.backgroundMcpTools ?? [],
          trustedMcpServers: Object.keys(settings.mcpServers ?? {}),
          questionDelivery: settings.questions?.delivery,
          planAllowTerminal: settings.planAllowTerminal,
          customSet: settings.custom,
          timer: settings.timer,
          headsUp: settings.headsUp,
          ...(typeof settings.skipPermissionConfirm === "boolean"
            ? { skipPermissionConfirm: settings.skipPermissionConfirm }
            : {}),
        }),
      );
      for (const notice of notices) console.warn(notice);
    } catch (e) {
      console.warn("Could not read the policy settings", e);
    }
  },
);

/** Writes the levels and the settings a person can change. */
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
      // The decision timer is sent only once there is something to send: a save
      // made before the file loaded must not remove what the file has. An empty
      // object, which the person chose by turning every window off, removes it.
      ...(policyExtras.timer !== undefined
        ? { timer: policyExtras.timer }
        : {}),
      ...(policyExtras.headsUp !== undefined
        ? { headsUp: policyExtras.headsUp }
        : {}),
      // Absent means the dialog still appears: remove the line
      skipPermissionConfirm:
        policyExtras.skipPermissionConfirm === true ? true : null,
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
>("policy/changeLevel", async (change, { dispatch, getState }) => {
  const previous = getState().ui.policyLevels;
  // One area changes; the safety checks are their own knobs and stay as they are
  dispatch(setPolicyLevel(change));
  const saved = await dispatch(savePolicySettings());
  if (savePolicySettings.rejected.match(saved)) {
    dispatch(setPolicyLevels(previous));
  }
});

/**
 * A preset sets every knob: the five levels and its safety checks together.
 * It is given by name, because levels alone cannot say which one it is
 * (Hands off and IDGAF set the same levels and differ in their switches).
 */
export const applyPolicyPreset = createAsyncThunk<
  void,
  PolicyPresetName,
  ThunkApiType
>("policy/applyPreset", async (name, { dispatch, getState }) => {
  const previous = getState().ui.policyLevels;
  const previousExtras = getState().ui.policyExtras;
  const next = settingsOfPreset(name);
  dispatch(setPolicyLevels(next.levels));
  dispatch(setPolicyExtras({ builtin: next.builtin }));
  const saved = await dispatch(savePolicySettings());
  if (savePolicySettings.rejected.match(saved)) {
    dispatch(setPolicyLevels(previous));
    dispatch(setPolicyExtras({ builtin: previousExtras.builtin }));
  }
});

/** Applies levels with no preset name (a recalled custom set); the switches stay. */
export const applyPolicyLevels = createAsyncThunk<
  void,
  PolicyLevels,
  ThunkApiType
>("policy/applyLevels", async (levels, { dispatch, getState }) => {
  const previous = getState().ui.policyLevels;
  dispatch(setPolicyLevels(levels));
  const saved = await dispatch(savePolicySettings());
  if (savePolicySettings.rejected.match(saved)) {
    dispatch(setPolicyLevels(previous));
  }
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
