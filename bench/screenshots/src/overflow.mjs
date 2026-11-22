// The overflow pass: what in a view does not fit sideways. The page reports
// facts about each candidate element (measureOverflow, run in the browser);
// classify() decides here, in Node, which of them are findings, so the rules
// can be tested without a browser. overflow-baseline.json records the known
// findings per view and width; `npm run overflow` fails only on one that is
// not in it. All amounts are CSS pixels.
import fs from "node:fs";

export const OVERFLOW_WIDTHS = [200, 250, 300, 340];

/** Sub-pixel layout and rounding of scrollWidth give up to a pixel of noise. */
export const TOLERANCE = 1;
/** A known finding may grow by this much (font hinting) before it counts as new. */
export const SLACK = 2;
/** Truncated text with less room than this shows an ellipsis at most, or nothing. */
export const SQUEEZED_BELOW = 16;
/** Long lines of code and wide tables are given a scrollbar on purpose. */
export const SCROLLS_BY_DESIGN = new Set(["pre", "code", "table"]);

/**
 * Runs in the page (it is sent as text, so it uses nothing from this module).
 * Returns the layout width and one record of facts per candidate: an element
 * whose box crosses a side edge of the viewport, or whose content is wider
 * than its box. `parent` is the index of the nearest ancestor that is also a
 * candidate, or -1.
 */
export function measureOverflow() {
  const vw = document.documentElement.clientWidth;
  const SKIP = new Set(["HTML", "HEAD", "SCRIPT", "STYLE", "LINK", "META"]);
  const FORM = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  // Utility classes only. A styled-components name (sc-..., or a bare hash
  // such as "fnxzzh") changes between builds, so a class with no "-", ":" or
  // "[" in it must be one of the one-word utilities.
  const WORDS = new Set(
    "flex grid block inline hidden contents table relative absolute fixed sticky static truncate border rounded shadow grow shrink invisible italic underline uppercase group peer".split(
      " ",
    ),
  );
  const plainClass = (c) =>
    !c.startsWith("sc-") &&
    (/^[a-z][a-z0-9]*[-:[][a-z0-9:[\]/.%!_-]*$/.test(c) || WORDS.has(c));
  // An id from useId or a component library is a counter, not a name
  const named = (el) =>
    /^[A-Za-z][A-Za-z0-9-]*$/.test(el.id) && !/headlessui|radix/.test(el.id);
  const step = (el) => {
    const tag = el.tagName.toLowerCase();
    const testid = el.getAttribute("data-testid");
    if (testid) return `${tag}[data-testid=${testid}]`;
    if (named(el)) return `${tag}#${el.id}`;
    const label = el.getAttribute("aria-label");
    const role = el.getAttribute("role");
    // A label can hold a count or an age; the digits would make a new name of each
    if (label)
      return `${tag}[aria-label="${label.slice(0, 40).replace(/\d+/g, "N")}"]`;
    const cls = [...el.classList].filter(plainClass).slice(0, 4);
    return (
      tag + (role ? `[role=${role}]` : "") + cls.map((c) => `.${c}`).join("")
    );
  };
  const anchored = (el) =>
    el.hasAttribute("data-testid") ||
    named(el) ||
    el.hasAttribute("aria-label");
  // The element, up to three ancestors, and the nearest named ancestor above them
  const describe = (el) => {
    const parts = [step(el)];
    let cur = el;
    let depth = 0;
    while (
      !anchored(cur) &&
      cur.parentElement &&
      cur.parentElement !== document.body
    ) {
      cur = cur.parentElement;
      depth++;
      if (depth <= 3 || anchored(cur)) parts.unshift(step(cur));
      else if (parts[0] !== "...") parts.unshift("...");
    }
    return parts.join(" > ");
  };

  const index = new Map();
  const out = [];
  const all = document.body.querySelectorAll("*");
  for (const el of all) {
    if (SKIP.has(el.tagName)) continue;
    // Shapes inside an icon are not laid out as boxes; the <svg> itself is checked
    if (el.ownerSVGElement) continue;
    const rect = el.getBoundingClientRect();
    const html = el instanceof HTMLElement;
    const scrollWidth = html ? el.scrollWidth : 0;
    const clientWidth = html ? el.clientWidth : 0;
    const crosses = rect.right > vw + 0.5 || rect.left < -0.5;
    if (!crosses && scrollWidth <= clientWidth) continue;

    const cs = getComputedStyle(el);
    const fact = {
      selector: describe(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
      left: Math.round(rect.left * 10) / 10,
      right: Math.round(rect.right * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      scrollWidth,
      clientWidth,
      overflowX: cs.overflowX,
      // text-overflow: ellipsis or a line clamp: cut on purpose, and shown as cut
      truncates:
        cs.overflowX !== "visible" &&
        (cs.textOverflow === "ellipsis" ||
          (cs.webkitLineClamp !== "none" && cs.webkitLineClamp !== "")),
      formControl: FORM.has(el.tagName),
      // display: none, visibility: hidden or content-visibility. Opacity 0 is
      // kept: controls shown on hover are drawn with it and must still fit.
      rendered: el.checkVisibility({
        visibilityProperty: true,
        checkVisibilityCSS: true,
      }),
      srOnly: false,
      inTruncated: false,
      reachable: false,
      parent: -1,
    };
    // Which child makes the content too wide: the first, outermost one that
    // reaches furthest past the box. A hint for the reader, not part of the name.
    if (cs.overflowX !== "visible" && scrollWidth > clientWidth + 1) {
      const lo = rect.left + el.clientLeft;
      const hi = lo + clientWidth;
      let widest;
      let most = 1;
      // What a child cuts or scrolls itself does not widen this element
      let inner;
      for (const d of el.querySelectorAll("*")) {
        if (d.ownerSVGElement || inner?.contains(d)) continue;
        if (getComputedStyle(d).overflowX !== "visible") inner = d;
        const r = d.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        const by = Math.max(r.right - hi, lo - r.left);
        if (by > most + 0.5) {
          widest = d;
          most = by;
        }
      }
      if (widest) fact.widest = describe(widest);
    }
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const as = a === el ? cs : getComputedStyle(a);
      // Tailwind's sr-only and the like: a 1 px clipped box out of the flow
      if (
        (as.position === "absolute" || as.position === "fixed") &&
        a.offsetWidth <= 1 &&
        a.offsetHeight <= 1 &&
        as.overflowX !== "visible"
      ) {
        fact.srOnly = true;
      }
      if (a === el) continue;
      if (fact.parent < 0 && index.has(a)) fact.parent = index.get(a);
      if (
        as.overflowX !== "visible" &&
        (as.textOverflow === "ellipsis" ||
          (as.webkitLineClamp !== "none" && as.webkitLineClamp !== ""))
      ) {
        fact.inTruncated = true;
      }
      // A sideways scroller reaches what lies at or after the start of its
      // content; what sticks out before it (a right-aligned or centred row)
      // cannot be scrolled to.
      if (as.overflowX === "auto" || as.overflowX === "scroll") {
        const ar = a.getBoundingClientRect();
        const start = ar.left + a.clientLeft - a.scrollLeft;
        if (rect.left >= start - 0.5) fact.reachable = true;
      }
    }
    index.set(el, out.length);
    out.push(fact);
  }
  return { viewport: vw, elements: out };
}

/**
 * The findings one measured element gives: [] or up to two of
 *   outside   its box ends outside the viewport (side: left, right or both)
 *   clipped   its content is wider than its box and the rest is cut off
 *   scroll-x  its content is wider than its box and it scrolls sideways to
 *             show the rest (a dialog or a list that was meant to fit)
 *   squeezed  text that truncates with an ellipsis has been left under
 *             SQUEEZED_BELOW pixels: the ellipsis alone, or nothing
 * Not findings: anything not rendered; visually hidden (sr-only) elements;
 * text cut on purpose with an ellipsis or a line clamp that still has room,
 * and what is inside it; what a sideways scroller can scroll to; a code
 * block or a table that scrolls sideways (SCROLLS_BY_DESIGN); form controls,
 * which scroll their own text; amounts of TOLERANCE or less.
 */
export function classifyElement(f, viewport) {
  if (!f.rendered || f.srOnly) return [];
  const extra = f.scrollWidth - f.clientWidth;
  if (f.truncates && f.text && f.width < SQUEEZED_BELOW && extra > TOLERANCE) {
    return [{ kind: "squeezed", px: extra }];
  }
  if (f.width <= 0 || f.height <= 0) return [];
  const found = [];
  // Whole pixels, so an amount near the limit is not a finding on one run only
  const left = Math.round(Math.max(0, -f.left));
  const right = Math.round(Math.max(0, f.right - viewport));
  if (Math.max(left, right) > TOLERANCE && !f.inTruncated && !f.reachable) {
    found.push({
      kind: "outside",
      side:
        left > TOLERANCE && right > TOLERANCE
          ? "both"
          : left > right
            ? "left"
            : "right",
      px: Math.max(left, right),
    });
  }
  // An inline box has no width of its own to be wider than
  if (extra > TOLERANCE && f.clientWidth > 0 && !f.formControl) {
    const cuts = f.overflowX === "hidden" || f.overflowX === "clip";
    const scrolls = f.overflowX === "auto" || f.overflowX === "scroll";
    if (cuts && !f.truncates) {
      found.push({ kind: "clipped", px: extra });
    } else if (scrolls && !SCROLLS_BY_DESIGN.has(f.tag)) {
      found.push({ kind: "scroll-x", px: extra });
    }
  }
  return found;
}

/**
 * The findings of one page, sorted. An element outside the viewport is left
 * out when an ancestor is already reported outside on that side: the
 * ancestor is the one to fix, and its children would only repeat it.
 */
export function classify(measured) {
  const { viewport, elements } = measured;
  const per = elements.map((f) => classifyElement(f, viewport));
  const outsideOf = (i) => per[i].find((x) => x.kind === "outside");
  const covers = (a, b) => a.side === "both" || a.side === b.side;
  const findings = [];
  elements.forEach((f, i) => {
    for (const x of per[i]) {
      if (x.kind === "outside") {
        let p = f.parent;
        let repeated = false;
        while (p >= 0 && !repeated) {
          const up = outsideOf(p);
          repeated = !!up && covers(up, x);
          p = elements[p].parent;
        }
        if (repeated) continue;
      }
      findings.push({
        ...x,
        selector: f.selector,
        ...(f.widest && x.kind !== "outside" ? { widest: f.widest } : {}),
        text: f.text,
        box: { left: f.left, right: f.right, width: f.width },
      });
    }
  });
  return findings.sort(
    (a, b) => findingKey(a).localeCompare(findingKey(b)) || b.px - a.px,
  );
}

/** What names a finding in the baseline: the kind and the selector. */
export function findingKey(f) {
  return `${f.kind} ${f.selector}`;
}

/**
 * Folds the entries of a run into { view: { width: { key: px } } }, keeping
 * the largest amount when several elements share a key (rows of a list).
 */
export function collapse(entries) {
  const out = {};
  for (const e of entries) {
    const at = ((out[e.view] ??= {})[String(e.width)] ??= {});
    for (const f of e.overflow ?? []) {
      const key = findingKey(f);
      at[key] = Math.max(at[key] ?? 0, f.px);
    }
  }
  return sortKeys(out);
}

function sortKeys(o) {
  return Object.fromEntries(
    Object.keys(o)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
      .map((k) => [k, typeof o[k] === "object" ? sortKeys(o[k]) : o[k]]),
  );
}

/**
 * Compares a collapsed run with the baseline. New: a key the baseline does not
 * have for that view and width, or one more than SLACK larger than recorded.
 * Improved: a recorded key that is gone or more than SLACK smaller. Only the
 * views and widths of this run are compared.
 */
export function diffBaseline(current, baseline) {
  const added = [];
  const improved = [];
  for (const [view, widths] of Object.entries(current)) {
    for (const [width, keys] of Object.entries(widths)) {
      const base = baseline[view]?.[width] ?? {};
      for (const [key, px] of Object.entries(keys)) {
        const was = base[key] ?? 0;
        if (px > (was ? was + SLACK : 0))
          added.push({ view, width, key, was, px });
      }
      for (const [key, was] of Object.entries(base)) {
        const px = keys[key] ?? 0;
        if (px < was - SLACK) improved.push({ view, width, key, was, px });
      }
    }
  }
  return { added, improved };
}

/** The baseline after a run of some views and widths: those are replaced, the rest kept. */
export function mergeBaseline(baseline, current) {
  const out = structuredClone(baseline);
  for (const [view, widths] of Object.entries(current)) {
    out[view] = { ...(out[view] ?? {}), ...widths };
  }
  return sortKeys(out);
}

export function readBaseline(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")).views ?? {};
}

export function writeBaseline(file, views, meta) {
  fs.writeFileSync(file, JSON.stringify({ ...meta, views }, null, 2) + "\n");
}
