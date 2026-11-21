import { useProviderSetupDialog } from "../ProviderSetup/useProviderSetupDialog";
import { NoticeAction, NoticeBar } from "./NoticeBar";

/**
 * Above the input after a send that had no model to go to. Without it the
 * input looks as if it ignored Enter. The message stays in the box, and the
 * line says so, since a sent message normally leaves it.
 */
export function NoModelNotice(props: { onDismiss: () => void }) {
  const { openSetup } = useProviderSetupDialog();
  return (
    <NoticeBar testId="no-model-notice" onDismiss={props.onDismiss}>
      <span>
        No chat model is selected, so nothing was sent. Your message is still in
        the box.
      </span>
      <NoticeAction testId="no-model-notice-add" onClick={() => openSetup()}>
        Add a model
      </NoticeAction>
    </NoticeBar>
  );
}
