import type { DetectedLocalServer } from "core/llm/localServers";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";

/**
 * How long the start screen says "Looking…" before it says "None found".
 * Core gives each address 1.5 s, twice for one that answers (the listing,
 * then what software it is), so an answer normally arrives within 3 s. An
 * answer that comes later than this is still shown.
 */
export const LOOK_TIMEOUT_MS = 5000;

export interface LocalServerDetection {
  /** "looking" until core answers or the wait runs out. */
  status: "idle" | "looking" | "done";
  servers: DetectedLocalServer[];
  error?: string;
  /** Look again. */
  look: () => void;
}

/**
 * Looks for model servers on this computer through `models/detectLocal`,
 * which asks only the loopback ports in core/llm/localServers.ts. It never
 * holds the screen up: the caller draws at once and fills the answer in.
 */
export function useLocalServerDetection(
  enabled: boolean,
): LocalServerDetection {
  const ideMessenger = useContext(IdeMessengerContext);
  const [state, setState] = useState<Omit<LocalServerDetection, "look">>({
    status: "idle",
    servers: [],
  });
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const look = useCallback(() => {
    const id = ++run.current;
    clearTimeout(timer.current);
    setState({ status: "looking", servers: [] });
    timer.current = setTimeout(() => {
      if (run.current !== id) return;
      setState((s) => (s.status === "looking" ? { ...s, status: "done" } : s));
    }, LOOK_TIMEOUT_MS);
    void ideMessenger
      .request("models/detectLocal", undefined)
      .then((res) => {
        if (run.current !== id) return;
        clearTimeout(timer.current);
        setState(
          res.status === "success"
            ? { status: "done", servers: res.content }
            : {
                status: "done",
                servers: [],
                error: res.error ?? "Could not look for servers",
              },
        );
      })
      .catch((e) => {
        if (run.current !== id) return;
        clearTimeout(timer.current);
        setState({
          status: "done",
          servers: [],
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }, [ideMessenger]);

  useEffect(() => {
    if (enabled) look();
    return () => {
      // Leaving the screen: a late answer is not for anyone
      run.current++;
      clearTimeout(timer.current);
    };
  }, [enabled, look]);

  return { ...state, look };
}

/** "127.0.0.1:11434" for a server's address, as one would type it. */
export function hostPort(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase;
  }
}

/** "Found: Ollama at 127.0.0.1:11434, 2 models". */
export function foundLine(server: DetectedLocalServer): string {
  const where = `Found: ${server.title} at ${hostPort(server.apiBase)}`;
  if (server.needsKey) return `${where}, needs an API key`;
  const n = server.models.length;
  return `${where}, ${n === 0 ? "no model loaded" : `${n} model${n === 1 ? "" : "s"}`}`;
}
