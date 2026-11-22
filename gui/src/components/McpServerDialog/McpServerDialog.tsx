import {
  ChevronRightIcon,
  LockClosedIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { LaunchFinding } from "core/config/mcpWizard/analyzeLaunch";
import { projectBlockFileName } from "core/config/mcpWizard/fileNames";
import type { McpServerScope } from "core/config/mcpWizard/manageMcpServers";
import {
  describeProbe,
  type ProbeOutcome,
} from "core/config/mcpWizard/probeOutcome";
import type {
  McpWizardCandidate,
  McpWizardListing,
  McpWizardSaveResponse,
  McpWizardScopesResponse,
  McpWizardTarget,
} from "core/config/mcpWizard/protocolHandlers";
import type { McpServerDraft } from "core/config/mcpWizard/types";
import {
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { DEFAULT_TOOL_SETTING } from "../../redux/slices/uiSlice";
import { setDialogCloseGuard } from "../dialogs/closeGuard";
import { useFocusTrap } from "../ModelConfig/useFocusTrap";
import { Button } from "../ui";
import {
  type ArgRow,
  checkName,
  draftFromForm,
  emptyForm,
  formFromDraft,
  formProblems,
  launchSignature,
  looksLikeCredentialName,
  type McpForm,
  type McpKind,
  rowId,
  secretNameIn,
  secretPlace,
  targetFile,
  toolTimeoutUnset,
  toolTrustText,
  unsetText,
  type ValueRow,
  willRun,
} from "./mcpDialogForm";

/*
  "Add MCP server" and "Edit MCP server": one form, no YAML. Nothing is
  written before Save, and no command runs before the person has seen
  exactly what would run and pressed Test or Save. The page never holds a
  credential from a paste or a file: core keeps those and sends a marker.
*/

export type McpDialogMode =
  | {
      kind: "add";
      /** Start from this server ("Duplicate", "Copy to"). */
      prefill?: McpServerDraft;
      /** A saved server to start from; read through core, so credentials stay there. */
      prefillFrom?: McpWizardTarget;
      /** The name to give the copy. */
      prefillName?: string;
    }
  | { kind: "edit"; target: McpWizardTarget };

export interface McpServerDialogProps {
  mode: McpDialogMode;
  /** After a save; `message` says what was written, for the list to show. */
  onDone: (message: string) => void;
  onCancel: () => void;
}

const inputClass =
  "box-border w-full min-w-0 rounded-default border border-solid border-input-border bg-input px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder aria-[invalid=true]:border-error";
const helpClass = "m-0 text-2xs break-words text-description";
const errorClass = "m-0 text-2xs break-words text-error";
const legendClass = "mb-1 p-0 text-xs font-medium";
const fieldsetClass = "m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0";

/** Which default a new tool's policy has, in the words of the Tools tab. */
const POLICY_WORDS: Record<string, string> = {
  allowedWithPermission: "Ask First",
  allowedWithoutPermission: "Automatic",
  disabled: "Excluded",
};

function Field({
  label,
  error,
  help,
  onReset,
  children,
}: {
  label: string;
  error?: string;
  help?: ReactNode;
  /** Shown while the field is set: puts it back to not set. */
  onReset?: () => void;
  children: (ids: { id: string; describedBy?: string }) => ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const described = error || help ? helpId : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {/* One wrapper either way: the input must not be remounted when Reset appears */}
      <div className="flex min-w-0 items-center gap-1">
        {children({ id, describedBy: described })}
        {onReset && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="my-0 shrink-0"
            aria-label={`Reset ${label} to not set`}
            onClick={onReset}
          >
            Reset
          </Button>
        )}
      </div>
      {error ? (
        <p id={helpId} className={errorClass} role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className={helpClass}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

/** Name and value rows for environment variables or headers. */
function ValueRows({
  noun,
  rows,
  onChange,
  emptyText,
  placeText,
  fileText,
  error,
  namePlaceholder,
}: {
  noun: "variable" | "header";
  rows: ValueRow[];
  onChange: (rows: ValueRow[]) => void;
  emptyText: string;
  /** Where a secret goes. */
  placeText: string;
  /** Where an ordinary value goes. */
  fileText: string;
  error?: string;
  namePlaceholder: string;
}) {
  const set = (id: number, patch: Partial<ValueRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () =>
    onChange([...rows, { id: rowId(), name: "", value: "", secret: false }]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {rows.length === 0 && <p className={helpClass}>{emptyText}</p>}
      {rows.map((r) => {
        const label = r.name.trim() || `new ${noun}`;
        return (
          <div
            key={r.id}
            className="flex min-w-0 flex-col gap-1 rounded-default border border-solid border-border p-1.5"
            data-testid={`mcp-${noun}-row`}
          >
            <div className="flex min-w-0 items-center gap-1">
              <input
                aria-label={`Name of ${noun}`}
                className={inputClass}
                value={r.name}
                placeholder={namePlaceholder}
                spellCheck={false}
                onChange={(e) => {
                  const name = e.target.value;
                  set(r.id, {
                    name,
                    // The name decides until the person decides
                    ...(r.secretTouched || r.stored
                      ? {}
                      : { secret: looksLikeCredentialName(name) }),
                  });
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="my-0 shrink-0 p-1"
                aria-label={`Remove ${label}`}
                onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
              >
                <XMarkIcon className="h-3.5 w-3.5" />
              </Button>
            </div>
            {r.stored ? (
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1 text-2xs break-words text-description">
                  <LockClosedIcon className="h-3 w-3 shrink-0" />
                  {r.stored === "reference"
                    ? `Uses the stored secret ${secretNameIn(r.value) ?? ""}. The value is not shown.`
                    : "A hidden value. It is kept out of this page and will be stored as a secret."}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="my-0 shrink-0"
                  aria-label={`Replace the value of ${label}`}
                  onClick={() =>
                    set(r.id, { value: "", stored: undefined, secret: true })
                  }
                >
                  Replace
                </Button>
              </div>
            ) : (
              <>
                <input
                  aria-label={`Value of ${label}`}
                  className={inputClass}
                  type={r.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={r.value}
                  placeholder="Value"
                  onChange={(e) => set(r.id, { value: e.target.value })}
                />
                <label className="flex min-h-6 items-center gap-1.5 text-2xs">
                  <input
                    type="checkbox"
                    className="m-0"
                    checked={r.secret}
                    onChange={(e) =>
                      set(r.id, {
                        secret: e.target.checked,
                        secretTouched: true,
                      })
                    }
                  />
                  Store as a secret
                </label>
                <p className={helpClass}>{r.secret ? placeText : fileText}</p>
              </>
            )}
          </div>
        );
      })}
      {error && (
        <p className={errorClass} role="alert">
          {error}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="my-0 inline-flex items-center gap-1"
          onClick={add}
        >
          <PlusIcon className="h-3 w-3" /> Add a {noun}
        </Button>
      </div>
    </div>
  );
}

/** The command and each argument in a box of its own: the split, as it is. */
function WillRun({ words }: { words: string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1" data-testid="mcp-will-run">
      {words.map((w, i) => (
        <code
          key={i}
          className="max-w-full rounded-sm border border-solid border-border px-1 py-0.5 text-2xs break-all"
        >
          {w === "" ? "(empty)" : w}
        </code>
      ))}
    </span>
  );
}

function OutcomePanel({ outcome }: { outcome: ProbeOutcome }) {
  const tone =
    outcome.tone === "success"
      ? "border-success"
      : outcome.tone === "warning"
        ? "border-warning"
        : "border-error";
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 rounded-default border border-solid ${tone} p-2 text-xs`}
      role={outcome.tone === "error" ? "alert" : "status"}
      data-testid="mcp-test-result"
    >
      <p className="m-0 font-medium break-words">{outcome.headline}</p>
      {outcome.server && (
        <p className="m-0 break-words">
          The server calls itself {outcome.server}.
        </p>
      )}
      {outcome.counts && (
        <p className="m-0">
          {outcome.counts.tools} tool{outcome.counts.tools === 1 ? "" : "s"},{" "}
          {outcome.counts.prompts} prompt
          {outcome.counts.prompts === 1 ? "" : "s"}, {outcome.counts.resources}{" "}
          resource{outcome.counts.resources === 1 ? "" : "s"}.
        </p>
      )}
      {outcome.toolNames.length > 0 && (
        <p className="m-0 text-2xs break-words text-description">
          Tools: {outcome.toolNames.join(", ")}
        </p>
      )}
      {outcome.details.map((d) => (
        <p key={d} className="m-0 text-2xs break-words text-description">
          {d}
        </p>
      ))}
      {outcome.stderr.length > 0 && (
        <pre className="m-0 max-h-24 overflow-auto rounded-sm bg-input p-1 text-2xs whitespace-pre-wrap">
          {outcome.stderr.join("\n")}
        </pre>
      )}
      {outcome.links.map((l) => (
        <p key={l.href} className="m-0 text-2xs">
          <a href={l.href} className="text-link">
            {l.text}
          </a>
        </p>
      ))}
    </div>
  );
}

export function McpServerDialog({
  mode,
  onDone,
  onCancel,
}: McpServerDialogProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);

  const editing = mode.kind === "edit" ? mode.target : undefined;
  const [form, setForm] = useState<McpForm>(() =>
    mode.kind === "add" && mode.prefill
      ? { ...formFromDraft(mode.prefill), name: mode.prefillName ?? "" }
      : emptyForm(),
  );
  /** What the form held when it was opened or last filled, to know "typed". */
  const pristine = useRef(JSON.stringify(form));
  const [scopes, setScopes] = useState<McpWizardScopesResponse>();
  const [saved, setSaved] = useState<McpWizardListing[]>([]);
  const [loading, setLoading] = useState(
    mode.kind === "edit" || (mode.kind === "add" && !!mode.prefillFrom),
  );
  const [loadError, setLoadError] = useState<string>();
  const [editInfo, setEditInfo] = useState<{
    listing: McpWizardListing;
    keptKeys: string[];
    notEditable?: string;
  }>();

  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<McpWizardCandidate[]>([]);
  const [candidateAt, setCandidateAt] = useState(0);
  const [savedCandidates, setSavedCandidates] = useState<Set<number>>(
    new Set(),
  );

  const [advanced, setAdvanced] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<"test" | "save">();
  const [outcome, setOutcome] = useState<ProbeOutcome>();
  const [saveError, setSaveError] = useState<{
    text: string;
    suggestion?: string;
  }>();
  /** The command the person has agreed to start, by signature. */
  const [agreed, setAgreed] = useState<string>();
  const [askRun, setAskRun] = useState<{
    then: "test" | "save";
    findings?: LaunchFinding[];
    blocked?: boolean;
  }>();
  const [askDiscard, setAskDiscard] = useState(false);

  const update = (patch: Partial<McpForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaveError(undefined);
  };

  // What core says about places, trust and its own behaviour; and the names in use
  useEffect(() => {
    let live = true;
    void ideMessenger.request("mcp/scopes", undefined).then((res) => {
      if (live && res.status === "success") setScopes(res.content);
    });
    void ideMessenger.request("mcp/list", undefined).then((res) => {
      if (live && res.status === "success") setSaved(res.content.servers);
    });
    return () => {
      live = false;
    };
  }, [ideMessenger]);

  const from = editing ?? (mode.kind === "add" ? mode.prefillFrom : undefined);
  useEffect(() => {
    if (!from) return;
    let live = true;
    void ideMessenger.request("mcp/getDraft", from).then((res) => {
      if (!live) return;
      setLoading(false);
      if (res.status !== "success") {
        setLoadError(String(res.error ?? "Could not read the server."));
        return;
      }
      if (!res.content.ok) {
        setLoadError(res.content.error);
        return;
      }
      const { listing, draft, keptKeys, notEditable } = res.content;
      const next: McpForm =
        mode.kind === "edit"
          ? {
              ...formFromDraft(draft),
              scope: listing.scope,
              ...(listing.folder ? { folder: listing.folder } : {}),
            }
          : {
              ...formFromDraft(draft),
              name: mode.kind === "add" ? (mode.prefillName ?? "") : draft.name,
            };
      if (mode.kind === "edit") setEditInfo({ listing, keptKeys, notEditable });
      pristine.current = JSON.stringify(next);
      setForm(next);
    });
    return () => {
      live = false;
    };
    // The target does not change while the dialog is open
  }, [ideMessenger]);

  const dirty = JSON.stringify(form) !== pristine.current || paste !== "";
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Escape, the X and a click beside the dialog ask before typed text is lost
  useEffect(
    () =>
      setDialogCloseGuard(() => {
        if (dirtyRef.current) {
          setAskDiscard(true);
          return false;
        }
        cancelRef.current();
        return true;
      }),
    [],
  );
  const cancel = () => {
    if (dirty) setAskDiscard(true);
    else onCancel();
  };

  const folders = scopes?.folders ?? [];
  const folder =
    folders.find((f) => f.dir === form.folder) ?? (folders[0] || undefined);
  const untrusted = form.scope === "project" && folder?.trust === "untrusted";
  const words = unsetText(scopes);
  const toolUnset = toolTimeoutUnset(scopes, form.timeoutSeconds);
  const place = secretPlace(scopes);
  const problems = useMemo(() => formProblems(form), [form]);
  const nameCheck = useMemo(
    () => checkName(form, saved, editing),
    // `editing` is fixed for the life of the dialog
    [form, saved],
  );
  const file =
    editInfo?.listing.file ?? targetFile(form, scopes, projectBlockFileName);
  const notEditable = editInfo?.notEditable;

  // ---- quick start ----

  const applyCandidate = (c: McpWizardCandidate) => {
    setForm((f) => ({
      ...formFromDraft(c.draft, { transportGuessed: c.transportGuessed }),
      scope: f.scope,
      folder: f.folder,
    }));
    setOutcome(undefined);
    setSaveError(undefined);
    setShowErrors(false);
  };

  const fill = async (text: string) => {
    if (!text.trim()) return;
    const res = await ideMessenger.request("mcp/parsePaste", { text });
    if (res.status !== "success") {
      setPasteNote([String(res.error ?? "Could not read that.")]);
      return;
    }
    const found = res.content.candidates;
    if (found.length === 0) {
      setCandidates([]);
      setPasteNote(
        res.content.warnings.length
          ? res.content.warnings
          : [
              "Nothing recognised. Paste a command such as npx -y some-server, an https:// address, or the JSON another tool uses.",
            ],
      );
      return;
    }
    setCandidates(found);
    setCandidateAt(0);
    setSavedCandidates(new Set());
    applyCandidate(found[0]);
    setPaste("");
    setPasteNote([
      found.length === 1
        ? `Filled in ${found[0].draft.name || "the server"} below. Nothing is saved until you press Save.`
        : `Found ${found.length} servers. Each is saved on its own: pick one, check it, press Save.`,
      ...res.content.warnings,
      ...found[0].warnings,
    ]);
  };

  // ---- test ----

  const validate = (forSave: boolean): boolean => {
    const { scope: scopeProblem, ...rest } = problems;
    const bad =
      Object.keys(rest).length > 0 ||
      (forSave && (!!scopeProblem || !!nameCheck.error));
    if (bad) setShowErrors(true);
    return !bad;
  };

  const needsGoAhead = (then: "test" | "save") =>
    form.kind === "command" &&
    agreed !== launchSignature(form) &&
    // A workspace server waits for the folder's trust; saving starts nothing
    (then === "test" || form.scope === "user");

  const ask = async (then: "test" | "save") => {
    setAskRun({ then });
    const res = await ideMessenger.request("mcp/analyzeLaunch", {
      draft: draftFromForm(form),
    });
    if (res.status === "success") {
      setAskRun((a) =>
        a
          ? {
              ...a,
              findings: res.content.analysis.findings.filter(
                (f) => f.level !== "info",
              ),
              blocked: res.content.analysis.blocked,
            }
          : a,
      );
    }
  };

  const runTest = async () => {
    setBusy("test");
    setOutcome(undefined);
    try {
      const draft = draftFromForm(form);
      const res = await ideMessenger.request("mcp/probe", {
        draft,
        consent: true,
        ...(form.scope ? { scope: form.scope } : {}),
        ...(form.scope === "project" && folder ? { folder: folder.dir } : {}),
        // The person's own limit also bounds the test
        ...(draft.connectionTimeoutMs
          ? { timeoutMs: draft.connectionTimeoutMs }
          : {}),
      });
      setOutcome(
        res.status === "success"
          ? describeProbe(res.content, { command: form.command.trim() })
          : {
              tone: "error",
              headline: String(res.error ?? "The test could not be run."),
              details: [],
              toolNames: [],
              flaggedTools: [],
              stderr: [],
              links: [],
            },
      );
    } finally {
      setBusy(undefined);
    }
  };

  const onTest = () => {
    if (!validate(false)) return;
    if (needsGoAhead("test")) void ask("test");
    else void runTest();
  };

  // ---- save ----

  const describeSave = (
    r: Extract<McpWizardSaveResponse, { ok: true }>,
  ): string => {
    const parts = [`Saved ${r.name} to ${r.file}.`];
    if (r.secretsStored.length) {
      parts.push(
        `Stored ${r.secretsStored.map((s) => s.name).join(", ")} in ${place}.`,
      );
    }
    if (r.secretsPending.length) {
      parts.push(
        `Still needs a value: ${r.secretsPending.join(", ")}. Open Edit to enter ${r.secretsPending.length === 1 ? "it" : "them"}.`,
      );
    }
    if (r.scope === "project") {
      parts.push(
        "It starts once you trust this folder's configuration: the editor asks because the file changed.",
      );
    }
    return [...parts, ...r.warnings].join(" ");
  };

  const runSave = async () => {
    setBusy("save");
    setSaveError(undefined);
    try {
      const draft = draftFromForm(form);
      const res = editing
        ? await ideMessenger.request("mcp/update", { target: editing, draft })
        : await ideMessenger.request("mcp/save", {
            draft,
            scope: form.scope,
            ...(form.scope === "project" && folder
              ? { folder: folder.dir }
              : {}),
          });
      if (res.status !== "success") {
        setSaveError({ text: String(res.error ?? "Could not save.") });
        return;
      }
      const r = res.content;
      if (!r.ok) {
        setSaveError({
          text: r.error,
          ...(r.suggestion ? { suggestion: r.suggestion } : {}),
        });
        return;
      }
      const message = describeSave(r);
      // More servers from the same paste: stay open for the next one
      const done = new Set(savedCandidates).add(candidateAt);
      const next = candidates.findIndex((_c, i) => !done.has(i));
      if (!editing && candidates.length > 1 && next >= 0) {
        setSavedCandidates(done);
        setCandidateAt(next);
        applyCandidate(candidates[next]);
        setPasteNote([
          message,
          `${candidates.length - done.size} more from your paste.`,
        ]);
        const list = await ideMessenger.request("mcp/list", undefined);
        if (list.status === "success") setSaved(list.content.servers);
        return;
      }
      onDone(message);
    } finally {
      setBusy(undefined);
    }
  };

  const onSave = () => {
    if (!validate(true)) return;
    if (needsGoAhead("save")) void ask("save");
    else void runSave();
  };

  const goAhead = () => {
    const then = askRun?.then;
    setAgreed(launchSignature(form));
    setAskRun(undefined);
    if (then === "test") void runTest();
    else if (then === "save") void runSave();
  };

  // ---- rows ----

  const setArg = (id: number, value: string) =>
    update({
      args: form.args.map((a) =>
        a.id === id ? { id: a.id, value } : a,
      ) as ArgRow[],
    });
  const err = (text?: string) => (showErrors ? text : undefined);
  const title = editing ? "Edit MCP server" : "Add MCP server";
  const newToolPolicy = POLICY_WORDS[DEFAULT_TOOL_SETTING] ?? "Ask First";

  let body: ReactNode;
  if (loadError) {
    body = (
      <p className="m-0 text-xs text-error" role="alert">
        {loadError}
      </p>
    );
  } else if (loading) {
    body = <p className="m-0 text-xs text-description">Reading the server.</p>;
  } else {
    body = (
      <>
        {!editing && (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${titleId}-paste`} className="text-xs font-medium">
              Paste a command, a URL, or a JSON snippet
            </label>
            <textarea
              id={`${titleId}-paste`}
              className={`${inputClass} font-mono`}
              rows={2}
              spellCheck={false}
              value={paste}
              placeholder="npx -y @modelcontextprotocol/server-filesystem ."
              onChange={(e) => setPaste(e.target.value)}
              onPaste={(e) => {
                // A paste into the empty box fills the form straight away
                const text = e.clipboardData?.getData("text") ?? "";
                if (paste === "" && text.trim()) {
                  e.preventDefault();
                  setPaste(text);
                  void fill(text);
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="my-0"
                disabled={!paste.trim()}
                onClick={() => void fill(paste)}
              >
                Fill in the form
              </Button>
              <span className={helpClass}>
                Or fill in the form yourself. Nothing is saved or run yet.
              </span>
            </div>
            {pasteNote.map((n) => (
              <p
                key={n}
                className={helpClass}
                role="status"
                data-testid="mcp-paste-note"
              >
                {n}
              </p>
            ))}
            {candidates.length > 1 && (
              <div
                className="flex flex-wrap gap-1"
                role="group"
                aria-label="Servers in your paste"
              >
                {candidates.map((c, i) => (
                  <Button
                    key={i}
                    type="button"
                    size="sm"
                    variant={i === candidateAt ? "secondary" : "outline"}
                    className="my-0"
                    aria-pressed={i === candidateAt}
                    onClick={() => {
                      setCandidateAt(i);
                      applyCandidate(c);
                    }}
                  >
                    {c.draft.name || `Server ${i + 1}`}
                    {savedCandidates.has(i) ? " (saved)" : ""}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {notEditable && (
          <p className="m-0 text-xs text-warning" role="status">
            {notEditable} Use Edit the file.
          </p>
        )}

        <Field
          label="Name"
          error={err(problems.name) ?? nameCheck.error}
          help={
            nameCheck.note ??
            "What you and the model call this server. It must be the only one of that name where it is saved."
          }
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              className={inputClass}
              value={form.name}
              aria-invalid={
                err(problems.name) || nameCheck.error ? true : undefined
              }
              aria-describedby={describedBy}
              spellCheck={false}
              onChange={(e) => update({ name: e.target.value })}
            />
          )}
        </Field>

        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>Kind</legend>
          {(
            [
              ["command", "Runs on this computer (command)"],
              ["url", "Remote server (URL)"],
            ] as [McpKind, string][]
          ).map(([kind, text]) => (
            <label
              key={kind}
              className="flex min-h-6 items-center gap-1.5 text-xs"
            >
              <input
                type="radio"
                className="m-0"
                name={`${titleId}-kind`}
                checked={form.kind === kind}
                onChange={() => update({ kind })}
              />
              {text}
            </label>
          ))}
        </fieldset>

        {form.kind === "command" ? (
          <>
            <Field
              label="Command"
              error={err(problems.command)}
              help={
                /\s/.test(form.command.trim()) ? (
                  <>
                    This has spaces. If it is a whole command line,{" "}
                    <button
                      type="button"
                      className="cursor-pointer border-0 bg-transparent p-0 text-2xs text-link underline"
                      onClick={() => void fill(form.command)}
                    >
                      split it into command and arguments
                    </button>
                    .
                  </>
                ) : (
                  "The program to start, such as npx, uvx, docker or a full path."
                )
              }
            >
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className={`${inputClass} font-mono`}
                  value={form.command}
                  aria-invalid={err(problems.command) ? true : undefined}
                  aria-describedby={describedBy}
                  spellCheck={false}
                  placeholder="npx"
                  onChange={(e) => update({ command: e.target.value })}
                />
              )}
            </Field>

            <fieldset className={fieldsetClass}>
              <legend className={legendClass}>Arguments</legend>
              <p className={helpClass}>
                One box per argument. Each reaches the program exactly as typed,
                spaces included; no quotes are needed.
              </p>
              {form.args.map((a, i) => (
                <div key={a.id} className="flex min-w-0 items-center gap-1">
                  {a.stored ? (
                    <span className="flex min-w-0 flex-1 items-center gap-1 text-2xs text-description">
                      <LockClosedIcon className="h-3 w-3 shrink-0" />
                      {a.stored === "reference"
                        ? `Uses the stored secret ${secretNameIn(a.value) ?? ""}.`
                        : "A hidden value, stored as a secret."}
                    </span>
                  ) : (
                    <input
                      aria-label={`Argument ${i + 1}`}
                      className={`${inputClass} font-mono`}
                      value={a.value}
                      spellCheck={false}
                      onChange={(e) => setArg(a.id, e.target.value)}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="my-0 shrink-0 p-1"
                    aria-label={`Remove argument ${i + 1}`}
                    onClick={() =>
                      update({ args: form.args.filter((x) => x.id !== a.id) })
                    }
                  >
                    <XMarkIcon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {err(problems.args) && (
                <p className={errorClass} role="alert">
                  {problems.args}
                </p>
              )}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="my-0 inline-flex items-center gap-1"
                  onClick={() =>
                    update({
                      args: [...form.args, { id: rowId(), value: "" }],
                    })
                  }
                >
                  <PlusIcon className="h-3 w-3" /> Add an argument
                </Button>
              </div>
              {form.command.trim() && (
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-2xs text-description">Will run:</span>
                  <WillRun words={willRun(form)} />
                </div>
              )}
            </fieldset>

            <fieldset className={fieldsetClass}>
              <legend className={legendClass}>Environment variables</legend>
              <ValueRows
                noun="variable"
                rows={form.env}
                onChange={(env) => update({ env })}
                emptyText={words.env}
                placeText={`Kept in ${place}. The file only gets a reference to it.`}
                fileText="Written to the file as typed."
                error={err(problems.env)}
                namePlaceholder="NAME"
              />
            </fieldset>
          </>
        ) : (
          <>
            <Field
              label="URL"
              error={err(problems.url)}
              help="The server's address, usually ending in /mcp or /sse."
            >
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className={`${inputClass} font-mono`}
                  value={form.url}
                  aria-invalid={err(problems.url) ? true : undefined}
                  aria-describedby={describedBy}
                  spellCheck={false}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => update({ url: e.target.value })}
                />
              )}
            </Field>
            <fieldset className={fieldsetClass}>
              <legend className={legendClass}>Headers</legend>
              <ValueRows
                noun="header"
                rows={form.headers}
                onChange={(headers) => update({ headers })}
                emptyText={words.headers}
                placeText={`Kept in ${place}. The file only gets a reference to it.`}
                fileText="Written to the file as typed."
                error={err(problems.headers)}
                namePlaceholder="Authorization"
              />
            </fieldset>
          </>
        )}

        <fieldset className={fieldsetClass} data-testid="mcp-scope">
          <legend className={legendClass}>Where to save it</legend>
          {editing ? (
            <p className={helpClass}>
              {form.scope === "project"
                ? "For this workspace only"
                : "For all my projects"}
              : <span className="break-all">{file}</span>. To put it somewhere
              else, use Move in the server's menu.
            </p>
          ) : (
            <>
              <label className="flex min-h-6 items-start gap-1.5 text-xs">
                <input
                  type="radio"
                  className="m-0 mt-0.5"
                  name={`${titleId}-scope`}
                  checked={form.scope === "user"}
                  data-testid="mcp-scope-user"
                  onChange={() => update({ scope: "user" })}
                />
                <span className="min-w-0">
                  For all my projects
                  <span className={`block ${helpClass}`}>
                    Saved in your own settings,{" "}
                    <span className="break-all">
                      {scopes?.user.file ?? "config.yaml"}
                    </span>
                    . It starts whatever folder is open, and a tool it marks as
                    read-only can run without asking.
                  </span>
                </span>
              </label>
              <label className="flex min-h-6 items-start gap-1.5 text-xs">
                <input
                  type="radio"
                  className="m-0 mt-0.5"
                  name={`${titleId}-scope`}
                  checked={form.scope === "project"}
                  disabled={folders.length === 0}
                  onChange={() =>
                    update({
                      scope: "project" as McpServerScope,
                      folder: form.folder ?? folders[0]?.dir,
                    })
                  }
                />
                <span className="min-w-0">
                  For this workspace only
                  <span className={`block ${helpClass}`}>
                    {folders.length === 0 ? (
                      "Not available: no folder is open."
                    ) : (
                      <>
                        Saved in the folder, as{" "}
                        <span className="break-all">
                          {targetFile(
                            { ...form, scope: "project" },
                            scopes,
                            projectBlockFileName,
                          )}
                        </span>
                        . It starts only after you trust this folder, and all
                        its tools ask first. The file can be committed and
                        shared, so secrets are never written to it: they stay in{" "}
                        {place} and the file only refers to them.
                      </>
                    )}
                  </span>
                </span>
              </label>
              {form.scope === "project" && folders.length > 1 && (
                <Field label="Folder">
                  {({ id }) => (
                    <select
                      id={id}
                      className={inputClass}
                      value={folder?.dir}
                      onChange={(e) => update({ folder: e.target.value })}
                    >
                      {folders.map((f) => (
                        <option key={f.dir} value={f.dir}>
                          {f.name} ({f.dir})
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              {err(problems.scope) && (
                <p className={errorClass} role="alert">
                  {problems.scope}
                </p>
              )}
            </>
          )}
          {untrusted && (
            <p className="m-0 text-2xs break-words text-warning" role="status">
              This folder's MCP servers are not trusted yet. A server saved here
              does not start, and Test does not run it, until you trust the
              folder (MCP servers tab, Trust this folder).
            </p>
          )}
        </fieldset>

        <div className="flex min-w-0 flex-col gap-2">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-left text-xs font-medium text-foreground"
            aria-expanded={advanced}
            aria-controls={`${titleId}-advanced`}
            onClick={() => setAdvanced((a) => !a)}
          >
            <ChevronRightIcon
              className={
                advanced
                  ? "h-3 w-3 shrink-0 rotate-90 transition-transform"
                  : "h-3 w-3 shrink-0 transition-transform"
              }
            />
            Advanced
          </button>
          {advanced && (
            <div
              id={`${titleId}-advanced`}
              className="flex min-w-0 flex-col gap-3 border-0 border-l-2 border-solid border-border pl-2"
              data-testid="mcp-advanced"
            >
              {form.kind === "command" ? (
                <Field
                  label="Working directory"
                  onReset={form.cwd ? () => update({ cwd: "" }) : undefined}
                  help={
                    form.cwd.trim()
                      ? `Set by you: the server starts in ${form.cwd.trim()}. A path that is not absolute is looked up inside the workspace folder.`
                      : words.cwd
                  }
                >
                  {({ id, describedBy }) => (
                    <input
                      id={id}
                      className={`${inputClass} font-mono`}
                      value={form.cwd}
                      aria-describedby={describedBy}
                      spellCheck={false}
                      onChange={(e) => update({ cwd: e.target.value })}
                    />
                  )}
                </Field>
              ) : (
                <Field
                  label="Transport (how the editor talks to the server)"
                  onReset={
                    form.transport ? () => update({ transport: "" }) : undefined
                  }
                  help={
                    form.transport === ""
                      ? "Not set: the editor tries streamable HTTP first and falls back to SSE."
                      : `Set by you: only ${form.transport === "sse" ? "SSE" : "streamable HTTP"} is tried.`
                  }
                >
                  {({ id, describedBy }) => (
                    <select
                      id={id}
                      className={inputClass}
                      value={form.transport}
                      aria-describedby={describedBy}
                      onChange={(e) =>
                        update({
                          transport: e.target.value as McpForm["transport"],
                        })
                      }
                    >
                      <option value="">{words.transport}</option>
                      <option value="http">Streamable HTTP</option>
                      <option value="sse">SSE (older servers)</option>
                    </select>
                  )}
                </Field>
              )}
              <Field
                label="Connection timeout (seconds)"
                error={err(problems.timeout)}
                onReset={
                  form.timeoutSeconds
                    ? () => update({ timeoutSeconds: "" })
                    : undefined
                }
                help={
                  form.timeoutSeconds.trim()
                    ? `Set by you: the editor waits ${form.timeoutSeconds.trim()} seconds for the server to connect.`
                    : words.timeout
                }
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    className={inputClass}
                    inputMode="decimal"
                    value={form.timeoutSeconds}
                    aria-invalid={err(problems.timeout) ? true : undefined}
                    aria-describedby={describedBy}
                    placeholder={words.timeoutPlaceholder}
                    onChange={(e) => update({ timeoutSeconds: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Tool call timeout (seconds)"
                error={err(problems.toolTimeout)}
                onReset={
                  form.toolTimeoutSeconds
                    ? () => update({ toolTimeoutSeconds: "" })
                    : undefined
                }
                help={
                  form.toolTimeoutSeconds.trim() ? (
                    `Set by you: each tool call may take ${form.toolTimeoutSeconds.trim()} seconds, whatever the connection timeout is.`
                  ) : (
                    <span data-testid="mcp-tool-timeout">
                      {toolUnset.text}
                      {toolUnset.follows !== undefined && (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="cursor-pointer border-0 bg-transparent p-0 text-2xs text-link underline"
                            onClick={() =>
                              update({
                                toolTimeoutSeconds: String(toolUnset.follows),
                              })
                            }
                          >
                            Set it separately
                          </button>
                        </>
                      )}
                    </span>
                  )
                }
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    className={inputClass}
                    inputMode="decimal"
                    value={form.toolTimeoutSeconds}
                    aria-invalid={err(problems.toolTimeout) ? true : undefined}
                    aria-describedby={describedBy}
                    placeholder={toolUnset.placeholder}
                    onChange={(e) =>
                      update({ toolTimeoutSeconds: e.target.value })
                    }
                  />
                )}
              </Field>
              {form.kind === "command" && (
                <p className={helpClass}>
                  This server runs as a local process (stdio): the editor starts
                  it and talks to it through its input and output.
                </p>
              )}
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-medium">
                  When the server offers tools
                </span>
                <p className={helpClass} data-testid="mcp-tool-default">
                  New tools wait for your approval and are not offered to the
                  model before you approve them. Once approved, each tool is set
                  to {newToolPolicy}. {toolTrustText(form.scope)} You change
                  this per tool in the MCP servers tab; nothing here is saved in
                  the file.
                </p>
              </div>
              {editInfo && editInfo.keptKeys.length > 0 && (
                <p className={helpClass}>
                  This server also has settings this form does not show:{" "}
                  {editInfo.keptKeys.join(", ")}. Saving keeps them as they are.
                  Use Edit the file to change them.
                </p>
              )}
            </div>
          )}
        </div>

        {outcome && <OutcomePanel outcome={outcome} />}
        {busy === "test" && (
          <p className="m-0 text-xs text-description" role="status">
            {form.kind === "command"
              ? "Starting the server and asking what it offers."
              : "Connecting and asking what the server offers."}
          </p>
        )}
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="box-border flex max-h-[90vh] min-w-0 flex-col outline-none"
      data-testid="mcp-server-dialog"
    >
      <h2 id={titleId} className="m-0 shrink-0 px-4 pt-3 pr-10 pb-2 text-base">
        {title}
      </h2>
      <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-4 pb-3 [&>*]:shrink-0">
        {body}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-0 border-t border-solid border-border px-4 py-2">
        {askRun && (
          <div
            className="flex min-w-0 flex-col gap-1 text-xs"
            role="alertdialog"
            aria-label="Run this command"
            data-testid="mcp-confirm-run"
          >
            <span>
              {askRun.then === "save"
                ? "Saving starts this on your computer, now and each time the editor opens:"
                : "This will run on your computer:"}
            </span>
            <WillRun words={willRun(form)} />
            <span className={helpClass}>
              {form.cwd.trim()
                ? `In ${form.cwd.trim()}.`
                : words.cwd.replace(
                    /^Not set: /,
                    "Working directory not set: ",
                  )}
            </span>
            {askRun.findings?.map((f) => (
              <span
                key={f.code + f.message}
                className={
                  f.level === "block"
                    ? "text-2xs break-words text-error"
                    : "text-2xs break-words text-warning"
                }
              >
                {f.message}
              </span>
            ))}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                className="my-0"
                onClick={() => setAskRun(undefined)}
              >
                Not now
              </Button>
              <Button
                type="button"
                className="my-0"
                disabled={askRun.blocked}
                onClick={goAhead}
                data-testid="mcp-confirm-run-yes"
              >
                {askRun.then === "save" ? "Save and start" : "Run it and test"}
              </Button>
            </div>
          </div>
        )}
        {askDiscard && (
          <div
            className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs"
            role="alertdialog"
            aria-label="Discard changes"
            data-testid="mcp-confirm-discard"
          >
            <span className="mr-auto">Discard what you typed?</span>
            <Button
              type="button"
              variant="secondary"
              className="my-0"
              onClick={() => setAskDiscard(false)}
            >
              Keep editing
            </Button>
            <Button type="button" className="my-0" onClick={onCancel}>
              Discard
            </Button>
          </div>
        )}
        {saveError && (
          <p className={errorClass} role="alert" data-testid="mcp-save-error">
            {saveError.text}{" "}
            {saveError.suggestion && (
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-2xs text-link underline"
                onClick={() => update({ name: saveError.suggestion })}
              >
                Use {saveError.suggestion}
              </button>
            )}
          </p>
        )}
        {!askRun && !askDiscard && (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {file && (editing || form.scope === "user") && (
              <button
                type="button"
                className="mr-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-link underline"
                onClick={() => ideMessenger.post("openFile", { path: file })}
                data-testid="mcp-edit-file"
              >
                Edit the file
              </button>
            )}
            <Button
              type="button"
              variant="secondary"
              className="my-0"
              onClick={cancel}
              disabled={busy !== undefined}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              className="my-0"
              onClick={onTest}
              disabled={
                busy !== undefined || loading || !!loadError || untrusted
              }
              title={
                untrusted
                  ? "Not run: this folder's MCP servers are not trusted yet."
                  : undefined
              }
              data-testid="mcp-test"
            >
              {busy === "test" ? "Testing" : "Test"}
            </Button>
            <Button
              type="button"
              className="my-0"
              onClick={onSave}
              disabled={
                busy !== undefined || loading || !!loadError || !!notEditable
              }
              data-testid="mcp-save"
            >
              {busy === "save" ? "Saving" : "Save"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
