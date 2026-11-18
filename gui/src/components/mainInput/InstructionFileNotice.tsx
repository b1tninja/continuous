import type { InstructionFilesState } from "core/config/markdown/instructionFiles";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppSelector } from "../../redux/hooks";
import { NoticeAction, NoticeBar } from "./NoticeBar";

const NOTHING: InstructionFilesState = { withheld: [], notices: [] };

/** The last path segment, without bundling the core module for it. */
function fileName(file: string): string {
  return file.split(/[/\\]/).pop() || file;
}

function signature(state: InstructionFilesState): string {
  return JSON.stringify([state.withheld, state.notices.map((n) => n.message)]);
}

/**
 * What the last config load did with instruction files (ROADMAP X20, X29 and
 * the 32 KiB cap): hidden characters removed, a secret found, a file cut, or
 * an `AGENTS.md` not read because VS Code has not trusted the workspace
 * (Restricted Mode). Load reads it for this window only; nothing is stored.
 * Read from the host after every config load; a host that does not answer
 * shows nothing.
 */
export function InstructionFileNotice() {
  const ideMessenger = useContext(IdeMessengerContext);
  // A new object after every config load
  const config = useAppSelector((s) => s.config.config);
  const [state, setState] = useState<InstructionFilesState>(NOTHING);
  const [dismissed, setDismissed] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function ask(load?: boolean) {
    try {
      const res = await ideMessenger.request("instructionFiles/state", {
        load,
      });
      setState(res.status === "success" ? res.content : NOTHING);
    } catch {
      setState(NOTHING);
    }
  }

  useEffect(() => {
    void ask();
  }, [config]);

  const sig = signature(state);
  if (sig === signature(NOTHING) || dismissed === sig) return null;

  const open = (file: string) =>
    ideMessenger.post("showFile", { filepath: file });

  return (
    <NoticeBar
      testId="instruction-file-notice"
      onDismiss={() => setDismissed(sig)}
    >
      <div className="flex flex-col gap-0.5 py-0.5">
        {state.withheld.map((file) => (
          <div key={`w:${file}`} className="flex flex-wrap items-center">
            <span>
              VS Code has not trusted this workspace (Restricted Mode), so{" "}
              {fileName(file)} was not read.
            </span>
            <NoticeAction
              testId="instruction-file-load"
              title="Read it for this window only. Nothing is saved; a new window asks again."
              onClick={() => {
                setLoading(true);
                void ask(true).finally(() => setLoading(false));
              }}
            >
              {loading ? "Loading..." : "Load"}
            </NoticeAction>
            <NoticeAction
              testId="instruction-file-open"
              onClick={() => open(file)}
            >
              Open {fileName(file)}
            </NoticeAction>
          </div>
        ))}
        {state.notices.map((notice, i) => (
          <div
            key={`n:${i}`}
            data-testid={`instruction-file-${notice.kind}`}
            className="flex flex-wrap items-center"
          >
            <span>{notice.message}</span>
            <NoticeAction
              testId="instruction-file-open"
              onClick={() => open(notice.file)}
            >
              Open {notice.name}
            </NoticeAction>
          </div>
        ))}
      </div>
    </NoticeBar>
  );
}
