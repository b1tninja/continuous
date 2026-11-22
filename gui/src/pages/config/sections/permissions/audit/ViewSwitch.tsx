export type PermissionsView =
  "levels" | "rules" | "protections" | "recent" | "inbox";

export function isPermissionsView(
  value: string | null | undefined,
): value is PermissionsView {
  return VIEWS.some((v) => v.id === value);
}

const VIEWS: { id: PermissionsView; label: string; help: string }[] = [
  {
    id: "levels",
    label: "Levels",
    help: "Who decides a call your rules do not decide",
  },
  { id: "rules", label: "Rules", help: "Every rule in effect, and your own" },
  {
    id: "protections",
    label: "Protections",
    help: "Locks, built-in rules, secrets, the decision timer, shadow review",
  },
  {
    id: "recent",
    label: "Recent calls",
    help: "What the agent did and who decided",
  },
  { id: "inbox", label: "Inbox", help: "Questions nobody has answered" },
];

/** Levels, Rules, Protections, Recent calls and Inbox: the page's views. Arrow keys move between them. */
export function ViewSwitch({
  view,
  onChange,
}: {
  view: PermissionsView;
  onChange: (next: PermissionsView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Permissions views"
      data-testid="view-switch"
      className="mb-3 flex flex-wrap gap-1"
      onKeyDown={(e) => {
        const at = VIEWS.findIndex((v) => v.id === view);
        const step =
          e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = VIEWS[(at + step + VIEWS.length) % VIEWS.length].id;
        onChange(next);
        queueMicrotask(() =>
          document.getElementById(`permissions-view-tab-${next}`)?.focus(),
        );
      }}
    >
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          id={`permissions-view-tab-${v.id}`}
          aria-selected={view === v.id}
          aria-controls={
            v.id === "rules" ? undefined : `permissions-view-${v.id}`
          }
          tabIndex={view === v.id ? 0 : -1}
          title={v.help}
          data-testid={`view-${v.id}`}
          onClick={() => onChange(v.id)}
          className={`min-h-6 cursor-pointer rounded-sm border border-solid px-2 text-xs text-foreground ${
            view === v.id
              ? "border-border-focus bg-input"
              : "border-border bg-transparent"
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
