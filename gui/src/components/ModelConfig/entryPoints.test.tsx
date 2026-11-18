import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelRoleRow } from "../../pages/config/components/ModelRoleRow";
import { renderWithProviders } from "../../util/test/render";
import { useModelConfigDialog } from "./useModelConfigDialog";

const QWEN = {
  title: "Qwen",
  model: "qwen3-coder",
  provider: "vllm",
  underlyingProviderName: "vllm",
  sourceFile: "/home/u/.continuous/config.yaml",
} as any;

function Row() {
  const openModelConfig = useModelConfigDialog();
  return (
    <ModelRoleRow
      role="chat"
      displayName="Chat"
      description="Used in Chat"
      models={[QWEN]}
      selectedModel={QWEN}
      onSelect={vi.fn()}
      onConfigure={openModelConfig}
      setupURL="https://example.test"
    />
  );
}

describe("Configure... on the Models settings page", () => {
  it("is a named button that opens the dialog for the role's model", async () => {
    const { user, store } = await renderWithProviders(<Row />);
    await user.click(screen.getByRole("button", { name: "Configure Qwen" }));
    expect(store.getState().ui.showDialog).toBe(true);
    const dialog = store.getState().ui.dialogMessage as any;
    expect(dialog?.props).toMatchObject({ title: "Qwen" });

    // Open file from the dialog closes it and opens the model's own file
    dialog.props.onOpenFile();
    expect(store.getState().ui.showDialog).toBe(false);
  });
});
