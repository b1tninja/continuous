/**
 * What no rule can override. Shown on every area that has rules, so a person
 * who is about to write an Always rule sees what it cannot reach.
 */
const LOCKS: { id: string; label: string; reason: string }[] = [
  {
    id: "floor",
    label: "Always-on rules",
    reason:
      "Never rules in your permissions.yaml bind at every level below IDGAF; at IDGAF they are recorded, not applied. They are changed by editing that file, not here.",
  },
  {
    id: "protected-paths",
    label: "Protected paths",
    reason:
      "Credentials, keys and similar files always ask, whatever an Always rule says.",
  },
  {
    id: "policy-files",
    label: "Your policy files",
    reason:
      "config.yaml, permissions.yaml and the files that change what runs later cannot be written by the agent without asking you. A rule cannot allow it.",
  },
];

export function LocksSection() {
  return (
    <section aria-label="Locks" data-testid="locks">
      <h5 className="my-1 text-xs font-semibold">Locks</h5>
      <p className="my-1 text-2xs text-description-muted">
        These always win. No rule here, from you or anyone, turns them into a
        yes.
      </p>
      <ul className="m-0 flex flex-col gap-1 p-0">
        {LOCKS.map((l) => (
          <li
            key={l.id}
            className="list-none rounded-sm border border-solid border-border px-2 py-1"
            data-testid={`lock-${l.id}`}
          >
            <div className="flex flex-wrap items-center gap-1">
              <span className="inline-block rounded-sm border border-solid border-border px-1 text-2xs text-description">
                Locked
              </span>
              <span className="text-xs">{l.label}</span>
            </div>
            <div className="text-2xs text-description-muted">{l.reason}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
