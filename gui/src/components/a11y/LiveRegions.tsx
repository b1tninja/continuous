import { useAnnouncement } from "./announcer";

/**
 * The two live regions of the webview, mounted once (Layout). Polite carries
 * "Assistant is responding", the end of a reply and tool call state changes;
 * assertive carries approval requests. Both are visually hidden and both are
 * always in the DOM, because a region added together with its text is often
 * not announced.
 */
export function LiveRegions() {
  const polite = useAnnouncement("polite");
  const assertive = useAnnouncement("assertive");
  return (
    <>
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="live-region-polite"
      >
        {polite.text && <span key={polite.seq}>{polite.text}</span>}
      </div>
      <div
        className="sr-only"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="live-region-assertive"
      >
        {assertive.text && <span key={assertive.seq}>{assertive.text}</span>}
      </div>
    </>
  );
}
