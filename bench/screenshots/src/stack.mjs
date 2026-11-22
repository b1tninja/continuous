// The height budget of the stack above the prompt: in a short panel the
// notices, task list and queue must leave some of the chat, and must not push
// the prompt, a waiting approval's buttons or a question's answer controls
// out of sight. The page reports
// what shows (measureStack); the rule runs in Node (checkStack) and has tests.
// All amounts are CSS pixels.

/** The least of the chat that must show: about four lines. */
export const MIN_TRANSCRIPT = 96;

/**
 * Runs in the page. For the chat, the prompt, each approval button and the
 * first question's answer controls: how tall the element is and how much of
 * that shows, after the viewport and every scrolling or clipping ancestor have
 * cut it. For the first approval: the whole lines that show of what it asks for.
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
  // What the first approval asks for (its command, arguments, paths or
  // fields): how many whole lines of it show above that call's buttons and
  // its pinned reason, which lie over the list when the call is taller
  const whatIsApproved = () => {
    const what = document.querySelector(
      '[data-testid^="pending-action-what-"]',
    );
    if (!what) return null;
    const text = what.querySelector("pre") ?? what;
    const style = getComputedStyle(text);
    const r = text.getBoundingClientRect();
    const first =
      r.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const last =
      r.bottom -
      parseFloat(style.borderBottomWidth) -
      parseFloat(style.paddingBottom);
    let top = Math.max(first, 0);
    let bottom = Math.min(last, window.innerHeight);
    for (let p = text.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === "visible") continue;
      const b = p.getBoundingClientRect();
      top = Math.max(top, b.top);
      bottom = Math.min(bottom, b.bottom);
    }
    const id = what.getAttribute("data-testid").slice(20);
    for (const over of [
      document.querySelector(`[data-testid="accept-tool-call-button-${id}"]`)
        ?.parentElement,
      document.querySelector(`[data-testid="policy-note-${id}"]`),
    ]) {
      if (over) bottom = Math.min(bottom, over.getBoundingClientRect().top);
    }
    const line = parseFloat(style.lineHeight) || 16;
    return {
      lines: Math.max(0, Math.floor((bottom - top + 0.5) / line)),
      // false when the text starts above what shows
      fromStart: top - first < 1,
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
    // The first question's: the others are further down a list that scrolls
    answers: one('[data-testid="question-controls"]'),
    what: whatIsApproved(),
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
  // Accept must not be in reach with none of what it accepts in sight
  if (facts.what && facts.what.lines < 1) {
    findings.push(
      "no whole line of what the first approval asks for shows above its buttons",
    );
  }
  if (facts.answers && cut(facts.answers)) {
    findings.push(
      `the question's answer controls show ${facts.answers.shown} of ${facts.answers.height} px`,
    );
  }
  return findings;
}
