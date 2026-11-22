// The height budget of the stack above the prompt: in a short panel the
// notices, task list and queue must leave some of the chat, and must not push
// the prompt or a waiting approval's buttons out of sight. The page reports
// what shows (measureStack); the rule runs in Node (checkStack) and has tests.
// All amounts are CSS pixels.

/** The least of the chat that must show: about four lines. */
export const MIN_TRANSCRIPT = 96;

/**
 * Runs in the page. For the chat, the prompt and each approval button: how
 * tall the element is and how much of that shows, after the viewport and every
 * scrolling or clipping ancestor have cut it.
 */
export function measureStack() {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    let top = Math.max(r.top, 0);
    let bottom = Math.min(r.bottom, window.innerHeight);
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === "visible") continue;
      const b = p.getBoundingClientRect();
      top = Math.max(top, b.top);
      bottom = Math.min(bottom, b.bottom);
    }
    return {
      height: Math.round(r.height),
      shown: Math.max(0, Math.round(bottom - top)),
    };
  };
  const one = (selector) => {
    const el = document.querySelector(selector);
    return el ? shown(el) : null;
  };
  return {
    viewport: window.innerHeight,
    transcript: one('[aria-label="Conversation"]'),
    prompt: one(
      '[data-testid="continue-input-box-main-editor-input"] .ProseMirror',
    ),
    buttons: [
      ...document.querySelectorAll(
        '[data-testid^="accept-tool-call-button-"], [data-testid^="reject-tool-call-button-"]',
      ),
    ].map((el) => ({ name: el.getAttribute("data-testid"), ...shown(el) })),
  };
}

/**
 * What is wrong with one measurement, as plain lines; none when it is fine.
 * A part counts as visible when all of its height shows, give or take a pixel.
 */
export function checkStack(facts, { minTranscript = MIN_TRANSCRIPT } = {}) {
  const findings = [];
  const cut = (part) => part.height === 0 || part.height - part.shown > 1;
  if (!facts.transcript) {
    findings.push("no chat on the page");
  } else if (facts.transcript.shown < minTranscript) {
    findings.push(
      `the chat shows ${facts.transcript.shown} px, under ${minTranscript}`,
    );
  }
  if (!facts.prompt) {
    findings.push("no prompt on the page");
  } else if (cut(facts.prompt)) {
    findings.push(
      `the prompt shows ${facts.prompt.shown} of ${facts.prompt.height} px`,
    );
  }
  // With several approvals the list scrolls by design: the first one's
  // buttons are the ones that must show.
  const call = (b) => b.name.replace(/^(accept|reject)-tool-call-button-/, "");
  const first = facts.buttons.filter((b) => call(b) === call(facts.buttons[0]));
  for (const b of first) {
    if (cut(b)) {
      findings.push(`${b.name} shows ${b.shown} of ${b.height} px`);
    }
  }
  return findings;
}
