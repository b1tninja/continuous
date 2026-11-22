import { DEFAULT_SECRET_PATTERNS } from "core/util/scrubEnvironment";
import {
  previewTerminalEnvironment,
  type TerminalEnvironmentMode,
  type TerminalEnvironmentStatus,
} from "core/util/terminalEnvironment";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import Alert from "../../../components/gui/Alert";
import { Button } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ConfigHeader } from "../components/ConfigHeader";

type Status = TerminalEnvironmentStatus & {
  hostEnvNames: string[];
  credentialUrlNames: string[];
  platform?: NodeJS.Platform;
};

/** The host's platform, else a guess from the browser; never `process`. */
function platformOf(status: Status): NodeJS.Platform {
  if (status.platform) return status.platform;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /windows/i.test(ua) ? "win32" : /mac/i.test(ua) ? "darwin" : "linux";
}

const OPTIONS: {
  mode: TerminalEnvironmentMode;
  label: string;
  effect: string;
}[] = [
  {
    mode: "scrub",
    label: "Hide secrets (recommended)",
    effect:
      "Commands run without variables whose names look like secrets (API keys, tokens, passwords, cloud credentials, SSH agent sockets) and without variables whose value is a URL with a password in it.",
  },
  {
    mode: "inherit",
    label: "Share everything",
    effect:
      "Commands see everything the editor sees, including API keys and cloud credentials. A command the model writes, or a script in a repository you open, can read and send them anywhere.",
  },
  {
    mode: "allowlist",
    label: "Only what I list",
    effect:
      "Commands get a short list of basics (PATH, HOME, language and temp folder settings) and the variables you pass through below, nothing else.",
  },
];

/** Who chose the mode in use. Nobody, when no file or variable names one. */
const SOURCE_STATE: Record<Status["source"], string> = {
  env: "Set by the CONTINUE_TERMINAL_ENV environment variable",
  "user-config": "Set by you in config.yaml",
  "assistant-config":
    "Set by the assistant configuration (tighter than the built-in mode)",
  default: "Not set",
};

/** What each mode does to a command's variables, for the one-line state. */
const MODE_STATE: Record<TerminalEnvironmentMode, string> = {
  scrub: "commands run with secret-named variables hidden",
  inherit: "commands see every variable, secrets included",
  allowlist: "commands get only the basics and the variables you list",
};

/** The fold header's line: who set the mode, what it does, and the counts now. */
export function terminalEnvironmentSummary(
  status: Pick<Status, "mode" | "source">,
  counts?: { removed: number; kept: number },
): string {
  const now = counts
    ? ` ${counts.removed} hidden now, ${counts.kept} passed`
    : "";
  return `${SOURCE_STATE[status.source]}: ${MODE_STATE[status.mode]}.${now}`;
}

const noteKey = (mode: string) => `terminalEnvNoteDismissed:${mode}`;

function noteDismissed(mode: string): boolean {
  try {
    return localStorage.getItem(noteKey(mode)) === "1";
  } catch {
    return false;
  }
}

function NameList({ names, empty }: { names: string[]; empty: string }) {
  if (names.length === 0) return <span className="opacity-65">{empty}</span>;
  return (
    <span className="font-mono text-2xs break-all">{names.join(", ")}</span>
  );
}

/**
 * Settings > Permissions > Protections: which environment variables the
 * agent's commands can read. `folded`: a fold header above names it and
 * shows `onSummary`'s line.
 */
export function TerminalEnvironmentControl({
  folded = false,
  onSummary,
}: {
  folded?: boolean;
  onSummary?: (text: string, warning: boolean) => void;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [status, setStatus] = useState<Status | undefined>();
  const [draftMode, setDraftMode] = useState<TerminalEnvironmentMode>("scrub");
  const [passEnv, setPassEnv] = useState<string[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    const res = await ideMessenger.request(
      "config/getTerminalEnvironment",
      undefined,
    );
    if (res.status !== "success") return;
    setStatus(res.content);
    setDraftMode(res.content.mode);
    setPassEnv(res.content.passEnv);
    setDismissed(noteDismissed(res.content.mode));
  }, [ideMessenger]);

  useEffect(() => {
    void load();
  }, [load]);

  const preview = useMemo(() => {
    if (!status) return undefined;
    // Names only. A variable whose value is a URL with a password gets a
    // stand-in value so the same rules apply as in the process.
    const env: Record<string, string> = {};
    for (const n of status.hostEnvNames)
      env[n] = status.credentialUrlNames.includes(n) ? "x://u:p@h" : "";
    return previewTerminalEnvironment(
      env,
      draftMode,
      {
        passEnv,
        allow: status.allow,
      },
      platformOf(status),
    );
  }, [status, draftMode, passEnv]);

  useEffect(() => {
    if (!status) return;
    onSummary?.(
      terminalEnvironmentSummary(
        status,
        // The counts are of the saved mode, not of an option being tried
        preview && draftMode === status.mode
          ? { removed: preview.removed.length, kept: preview.kept.length }
          : undefined,
      ),
      status.mode === "inherit",
    );
    // onSummary is a state setter of the page
  }, [status, preview, draftMode]);

  const save = async (next: {
    environment?: TerminalEnvironmentMode;
    passEnv?: string[];
  }) => {
    setError(undefined);
    const res = await ideMessenger.request(
      "config/setTerminalEnvironment",
      next,
    );
    if (res.status !== "success" || !res.content.saved) {
      setError(
        "Not saved: this needs a local config.yaml, and none was found to edit.",
      );
      return;
    }
    await load();
  };

  if (!status) return null;
  const locked = status.source === "env";
  const savedLabel = OPTIONS.find((o) => o.mode === status.mode)?.label;

  const addName = () => {
    const name = nameInput.trim();
    if (!name || passEnv.includes(name)) return setNameInput("");
    const next = [...passEnv, name];
    setPassEnv(next);
    setNameInput("");
    void save({ passEnv: next });
  };
  const removeName = (name: string) => {
    const next = passEnv.filter((n) => n !== name);
    setPassEnv(next);
    void save({ passEnv: next });
  };

  return (
    <section className={folded ? "" : "mb-4"} data-testid="terminal-env">
      {folded ? (
        <p className="mt-0 mb-2 text-sm text-description">
          What the commands the agent runs can read from the editor's
          environment variables
        </p>
      ) : (
        <ConfigHeader
          title="Commands and secrets"
          variant="sm"
          subtext="What the commands the agent runs can read from the editor's environment variables"
          showAddButton={false}
          className="mb-2"
        />
      )}
      {!dismissed && (
        <div className="mb-2" data-testid="terminal-env-note">
          <Alert type="info" size="sm">
            <div className="flex items-start justify-between gap-2">
              <span className="text-2xs">
                {SOURCE_STATE[status.source]}: commands run in "{savedLabel}"
                mode.
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  try {
                    localStorage.setItem(noteKey(status.mode), "1");
                  } catch {
                    // Not remembered; the note comes back next time.
                  }
                  setDismissed(true);
                }}
              >
                Dismiss
              </Button>
            </div>
          </Alert>
        </div>
      )}
      {status.notices.map((n) => (
        <div className="mb-2" key={n} data-testid="terminal-env-ignored">
          <Alert type="warning" size="sm">
            <span className="text-2xs">{n}</span>
          </Alert>
        </div>
      ))}
      {locked && (
        <div className="mb-2" data-testid="terminal-env-locked">
          <Alert type="warning" size="sm">
            <span className="text-2xs">
              The CONTINUE_TERMINAL_ENV environment variable is set to "
              {status.envVar}" and overrides this setting, so it is read-only
              here. Unset the variable and restart the editor to change it.
            </span>
          </Alert>
        </div>
      )}
      <fieldset
        className="m-0 flex flex-col gap-2 border-0 p-0"
        disabled={locked}
        data-testid="terminal-env-options"
      >
        <legend className="sr-only">Environment variables for commands</legend>
        {OPTIONS.map((o) => (
          <label
            key={o.mode}
            className="flex cursor-pointer items-start gap-2 text-xs"
          >
            <input
              type="radio"
              name="terminal-environment"
              value={o.mode}
              checked={draftMode === o.mode}
              disabled={locked}
              onChange={() => {
                setDraftMode(o.mode);
                void save({ environment: o.mode });
              }}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold">{o.label}</span>
              <span className="block opacity-75">{o.effect}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <details className="mt-2 text-2xs">
        <summary className="cursor-pointer">
          The names that count as secrets ({DEFAULT_SECRET_PATTERNS.length}{" "}
          patterns)
        </summary>
        <p className="font-mono break-all">
          {DEFAULT_SECRET_PATTERNS.join(", ")}
        </p>
      </details>
      <div className="mt-3 text-xs" data-testid="terminal-env-passenv">
        <div className="font-semibold">Pass through these variables</div>
        <div className="opacity-75">
          Exact names that commands always get, whichever option is chosen.
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {passEnv.map((n) => (
            <span
              key={n}
              className="inline-flex items-center gap-1 rounded-sm bg-input px-1 font-mono text-2xs"
            >
              {n}
              {!locked && (
                <button
                  className="cursor-pointer border-0 bg-transparent text-foreground"
                  aria-label={`Remove ${n}`}
                  onClick={() => removeName(n)}
                >
                  x
                </button>
              )}
            </span>
          ))}
        </div>
        {!locked && (
          <div className="flex items-center gap-1">
            <input
              className="rounded-sm border border-solid border-border bg-input px-1 font-mono text-2xs text-foreground"
              placeholder="VARIABLE_NAME"
              aria-label="Variable name to pass through"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addName()}
            />
            <Button variant="secondary" size="sm" onClick={addName}>
              Add
            </Button>
          </div>
        )}
      </div>
      {preview && (
        <div className="mt-3 text-xs" data-testid="terminal-env-preview">
          <div className="font-semibold">What this changes right now</div>
          <div className="opacity-75">
            Names only, from the editor's current environment; values are never
            shown.
          </div>
          <div className="mt-1" data-testid="terminal-env-removed">
            <span className="opacity-75">
              Commands would not get ({preview.removed.length}):{" "}
            </span>
            <NameList names={preview.removed} empty="nothing is removed" />
          </div>
          <div className="mt-1" data-testid="terminal-env-kept">
            <span className="opacity-75">
              Commands would get ({preview.kept.length}):{" "}
            </span>
            <details className="inline">
              <summary className="inline cursor-pointer">show names</summary>
              <NameList names={preview.kept} empty="nothing" />
            </details>
          </div>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <Alert type="error" size="sm">
            <span className="text-2xs">{error}</span>
          </Alert>
        </div>
      )}
    </section>
  );
}
