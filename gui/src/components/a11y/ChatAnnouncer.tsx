import { LiveRegions } from "./LiveRegions";
import { useChatAnnouncements } from "./useChatAnnouncements";

/** The live regions plus the hook that feeds them from the chat. Mount once. */
export function ChatAnnouncer() {
  useChatAnnouncements();
  return <LiveRegions />;
}
