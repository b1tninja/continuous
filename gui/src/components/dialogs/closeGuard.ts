/*
  The app dialog closes on Escape, on its X and on a click beside it. A dialog
  with a form can ask to be consulted first, so typed text is not lost to a
  stray click: it sets a guard while it is open, and the container closes only
  when the guard says yes. One dialog shows at a time, so one guard is enough.
*/

let guard: (() => boolean) | undefined;

/** Set by the open dialog; returns the function that removes it again. */
export function setDialogCloseGuard(next: () => boolean): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = undefined;
  };
}

/** False when the open dialog wants to stay (it then asks the person itself). */
export function dialogMayClose(): boolean {
  return guard ? guard() : true;
}
