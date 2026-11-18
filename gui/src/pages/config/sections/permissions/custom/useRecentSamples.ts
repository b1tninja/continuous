import {
  sampleFromCall,
  type PreviewSample,
} from "core/tools/permissions/customPolicy";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../../../../context/IdeMessenger";

const RECENT = 50;

/**
 * The last calls in the audit trail as preview samples, newest first, one per
 * distinct call. Nothing when the trail is off or empty, with a sentence.
 */
export function useRecentSamples(): {
  samples: PreviewSample[];
  note?: string;
} {
  const ideMessenger = useContext(IdeMessengerContext);
  const [state, setState] = useState<{
    samples: PreviewSample[];
    note?: string;
  }>({ samples: [], note: "Reading recent calls…" });
  useEffect(() => {
    let live = true;
    void ideMessenger
      .request("audit/list", { limit: RECENT })
      .then((res) => {
        if (!live) return;
        if (res.status !== "success") {
          setState({
            samples: [],
            note: "Recent calls could not be read, so there is nothing to preview against.",
          });
          return;
        }
        const seen = new Set<string>();
        const samples: PreviewSample[] = [];
        for (const row of res.content.rows ?? []) {
          const s = sampleFromCall(row);
          if (!s) continue;
          const k = `${s.tool}\u0000${s.value ?? ""}`;
          if (seen.has(k)) continue;
          seen.add(k);
          samples.push(s);
        }
        setState({
          samples,
          note: samples.length
            ? undefined
            : "The audit trail has no recent calls to preview against.",
        });
      })
      .catch(() => {
        if (live) {
          setState({
            samples: [],
            note: "Recent calls could not be read, so there is nothing to preview against.",
          });
        }
      });
    return () => {
      live = false;
    };
  }, [ideMessenger]);
  return state;
}
