import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setSessionLoadNotice } from "../../redux/slices/sessionSlice";
import { NoticeBar } from "./NoticeBar";

/**
 * Above the input when a session could not be opened (gone to the trash,
 * deleted, or unreadable at start-up): the chat is a new, empty one instead.
 */
export function SessionLoadNotice() {
  const dispatch = useAppDispatch();
  const notice = useAppSelector((s) => s.session.sessionLoadNotice);
  if (!notice) return null;
  return (
    <NoticeBar
      testId="session-load-notice"
      onDismiss={() => dispatch(setSessionLoadNotice(undefined))}
    >
      <span>{notice}</span>
    </NoticeBar>
  );
}
