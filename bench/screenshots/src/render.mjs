// The production render check: fixed markdown through the chat of the built
// harness, in a browser. The unit tests run React's development build, where
// elements carry _owner and _store; the built page has neither, and the
// markdown pipeline (react-remark, rehype-react 6, hast-to-hyperscript 9)
// behaved differently there twice: a string `style` reached React (error 62,
// the chat crashed on a table and later on any formula) and `className`
// arrived as `class` (no language on code blocks, mermaid drawn as text).
import { chooseBrowser } from "./browser.mjs";
import { serve } from "./server.mjs";
import { launchOptions, loadPlaywright } from "./shoot.mjs";

const B = "\\";

/** The first line of every document; pageCheck finds the reply by it. */
export const MARKER = "render-check";

/** One document per page load, so a crash in one does not hide the others. */
export const DOCS = {
  tables: [
    "| Fruit | Colour |",
    "|-------|--------|",
    "| Apple | Red |",
    "| Lemon | Yellow |",
    "",
    "Between the tables.",
    "",
    "| Left | Centre | Right |",
    "|:-----|:------:|------:|",
    "| a | b | c |",
  ],
  math: [
    "Inline $a^2+b^2$ here.",
    "",
    "$$",
    `${B}int_0^1 x^2 ${B}, dx = ${B}frac{1}{3}`,
    "$$",
    "",
    `Parens ${B}(c^2${B}) here.`,
    "",
    `One line $$e^{i${B}pi}+1=0$$ display.`,
  ],
  code: [
    "```ts",
    "export const answer: number = 42;",
    "```",
    "",
    "Inline `code` too.",
  ],
  mermaid: ["```mermaid", "graph TD", "  A[Start] --> B[End]", "```"],
  html: [
    'Inline <span style="color: red">red span</span> text.',
    "",
    '<div style="background: blue">block div</div>',
    "",
    "After.",
  ],
  misc: [
    "A [link](https://example.com/docs) and a [bad link](javascript:alert(1)).",
    "",
    "- [ ] open task",
    "- [x] done task",
    "",
    "1. one",
    "   - nested a",
    "     - deeper",
    "   - nested b",
    "2. two",
    "",
    "![diagram](https://images.example.com/a.png?token=abc)",
  ],
};

/** The markdown of a document, with the marker line on top. */
export function docMarkdown(name) {
  return [`${MARKER} ${name}`, "", ...DOCS[name], ""].join("\n");
}

/**
 * Runs IN THE PAGE (page.evaluate), so it uses nothing from this file. Returns
 * what is wrong with the reply for document `name`, [] when it is as meant.
 */
export function pageCheck(name) {
  const problems = [];
  const expect = (ok, what) => {
    if (!ok) problems.push(what);
  };
  const marker = [...document.querySelectorAll("p")].find(
    (p) => p.textContent === `render-check ${name}`,
  );
  if (!marker) {
    const text = document.body.innerText.replace(/\s+/g, " ").slice(0, 300);
    return [`the reply is not on the page; the page says: ${text}`];
  }
  const root = marker.parentElement;
  const all = (sel) => [...root.querySelectorAll(sel)];
  const texts = (sel) => all(sel).map((e) => e.textContent.trim());
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const checks = {
    tables() {
      const tables = all("table");
      expect(tables.length === 2, `2 tables expected, ${tables.length} found`);
      if (tables.length !== 2) return;
      const [plain, aligned] = tables;
      const cells = (t) => [...t.querySelectorAll("th, td")];
      expect(
        same(
          cells(plain).map((c) => c.textContent),
          ["Fruit", "Colour", "Apple", "Red", "Lemon", "Yellow"],
        ),
        `plain table cells: ${cells(plain).map((c) => c.textContent)}`,
      );
      expect(
        plain.querySelectorAll("tbody tr").length === 2,
        "plain table: 2 body rows expected",
      );
      expect(
        cells(plain).every((c) => c.style.textAlign === ""),
        "plain table: a cell has a text-align",
      );
      // Twice: the header row and the body row
      const want = ["left", "center", "right", "left", "center", "right"];
      expect(
        same(
          cells(aligned).map((c) => c.style.textAlign),
          want,
        ),
        `aligned table: style.textAlign is ${cells(aligned).map((c) => c.style.textAlign || "(none)")}`,
      );
      expect(
        same(
          cells(aligned).map((c) => getComputedStyle(c).textAlign),
          want,
        ),
        `aligned table: computed text-align is ${cells(aligned).map((c) => getComputedStyle(c).textAlign)}`,
      );
    },
    math() {
      const tex = texts(".katex annotation");
      expect(
        tex.includes("a^2+b^2"),
        `inline $a^2+b^2$ is not KaTeX output (formulas: ${tex.join(" | ") || "none"})`,
      );
      const display = all(".katex-display").length;
      expect(display === 2, `2 display formulas expected, ${display} found`);
      expect(
        all(".katex .mfrac").length === 1,
        "the fraction of the display formula is missing",
      );
      // A style React took as an object is an attribute the browser parsed.
      const styled = all(".katex [style]");
      expect(styled.length > 0, "no KaTeX element has a style attribute");
      const unparsed = styled.filter((e) => e.style.length === 0);
      expect(
        unparsed.length === 0,
        `${unparsed.length} KaTeX elements have a style attribute with no parsed property`,
      );
      const struts = all(".katex-strut");
      expect(
        struts.length > 0 && struts.every((e) => /em$/.test(e.style.height)),
        "a .katex-strut has no height in em",
      );
      // \( \) is not a math delimiter in this pipeline today: it stays text.
      // Either way the formula must not vanish.
      expect(
        tex.includes("c^2") || root.textContent.includes("(c^2)"),
        "the \\(c^2\\) formula is neither KaTeX nor text",
      );
    },
    code() {
      const code = root.querySelector("pre > code");
      expect(!!code, "no <pre><code>");
      if (!code) return;
      // The className -> class regression: the class is how the language is known
      expect(
        code.classList.contains("language-ts"),
        `the code element's class is "${code.className}", language-ts expected`,
      );
      expect(
        code.querySelectorAll(".hljs-keyword").length === 2,
        "the code is not highlighted (2 keywords expected)",
      );
      const toggle = root.querySelector('[data-testid="toggle-codeblock"]');
      const label = toggle?.nextElementSibling?.textContent;
      expect(
        label === "ts",
        `the code block toolbar shows "${label ?? "(no toolbar)"}", "ts" expected`,
      );
      expect(texts("p > code").includes("code"), "the inline code is missing");
    },
    mermaid() {
      const svg = root.querySelector('.mermaid svg[id^="mermaid-id-"]');
      expect(
        !root.querySelector("code"),
        "the mermaid fence is drawn as a plain <code>",
      );
      expect(!!svg, "the mermaid fence did not become a diagram (no svg)");
      if (!svg) return;
      const nodes = svg.querySelectorAll(".node").length;
      expect(nodes === 2, `2 diagram nodes expected, ${nodes} found`);
      expect(
        svg.textContent.includes("Start") && svg.textContent.includes("End"),
        "the diagram does not show the node labels",
      );
    },
    html() {
      // Raw HTML is not rendered: remark-rehype runs without allowDangerousHtml,
      // so an inline tag is dropped and its text stays, and a block of HTML is
      // dropped whole. No element, and so no style, comes from the markdown.
      expect(
        same(texts("p"), [
          `render-check ${name}`,
          "Inline red span text.",
          "After.",
        ]),
        `paragraphs: ${JSON.stringify(texts("p"))}`,
      );
      expect(
        root.children.length === 3 && all("span, div, [style]").length === 0,
        "an element from the raw HTML reached the page",
      );
      expect(
        !root.textContent.includes("block div"),
        "the block of raw HTML reached the page",
      );
    },
    misc() {
      const links = all("a");
      const good = links.find((a) => a.textContent === "link");
      expect(
        good?.getAttribute("href") === "https://example.com/docs" &&
          good.target === "_blank" &&
          good.rel === "noreferrer",
        `the link is ${good?.outerHTML.slice(0, 200) ?? "missing"}`,
      );
      const bad = links.find((a) => a.textContent === "bad link");
      expect(
        !!bad && !bad.hasAttribute("href"),
        `the javascript: link is ${bad?.outerHTML.slice(0, 200) ?? "missing"}`,
      );
      // No GFM here: a task list is a plain list (its "[ ]" stays text)
      const tasks = texts("ul > li").filter((t) => /(open|done) task$/.test(t));
      expect(tasks.length === 2, `2 task items expected: ${tasks}`);
      expect(
        all("ol > li").length === 2 &&
          same(texts("ol > li > ul > li > ul > li"), ["deeper"]) &&
          all("ol > li > ul > li").length === 2,
        "the nested lists are not nested as written",
      );
      // The remote image stays behind its gate
      expect(
        !root.querySelector("img"),
        "the remote image was put on the page",
      );
      expect(
        texts("button").includes("Load Image"),
        'no "Load Image" button for the remote image',
      );
      expect(
        root.textContent.includes("Image blocked for security") &&
          root.textContent.includes("images.example.com"),
        "the image gate does not name the host",
      );
    },
  };
  if (!checks[name]) return [`no check for document ${name}`];
  checks[name]();
  return problems;
}

/**
 * Console errors that mean a render went wrong. In a production build React
 * reports "Minified React error #n", and an error a boundary caught is logged
 * as "<Name>Error: ...". The mock IDE logs the names of messages it has no
 * answer for as errors too ("history/load"); those are not ours.
 */
export function isRenderError(text) {
  return /Minified React error|\b[A-Z]\w*Error: |^Error: |react-dom/.test(text);
}

/** What fails a document: page errors, render errors on the console, wrong content. */
export function verdict({ pageErrors, consoleErrors, requests, problems }) {
  return [
    ...pageErrors.map((m) => `pageerror: ${m}`),
    ...consoleErrors.filter(isRenderError).map((m) => `console: ${m}`),
    ...requests.map((u) => `request to another host: ${u}`),
    ...problems,
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Renders every document (or `o.docs`) and returns one result per document:
 * { name, ms, failures, consoleErrors }, plus the React build of the page.
 * @param {object} o
 * @param {string} o.dist built harness folder
 * @param {string} o.playwrightDir folder of playwright-core
 * @param {string} o.browser auto|chromium|edge|chrome
 * @param {string[]} [o.docs] names from DOCS
 * @param {number} [o.timeout] ms a document may take to come out right
 */
export async function renderCheck(o) {
  const timeout = o.timeout ?? 20_000;
  const chromium = await loadPlaywright(o.playwrightDir);
  const choice = chooseBrowser(o.browser, {
    playwrightExecutable: () => {
      try {
        return chromium.executablePath();
      } catch {
        return undefined;
      }
    },
  });
  const server = await serve(o.dist);
  const results = [];
  let browser;
  let build;
  try {
    browser = await chromium.launch(launchOptions(choice));
    for (const name of o.docs ?? Object.keys(DOCS)) {
      const t0 = Date.now();
      const context = await browser.newContext({
        viewport: { width: 800, height: 900 },
        reducedMotion: "reduce",
      });
      // Nothing but the harness itself is fetched: the fixture names remote
      // hosts (a link, an image) and none of them may be asked for anything.
      const requests = [];
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(server.url)) return route.continue();
        requests.push(url);
        return route.abort();
      });
      await context.addInitScript((markdown) => {
        window.__renderMarkdown = markdown;
      }, docMarkdown(name));
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 500));
      });
      await page.goto(`${server.url}?fixture=render-markdown&theme=dark`, {
        waitUntil: "load",
      });
      let problems;
      try {
        await page.waitForFunction(() => window.__shotReady === true, null, {
          timeout: 30_000,
        });
        build ??= await page.evaluate(() => window.__reactBuild);
        const harnessError = await page.evaluate(() => window.__shotError);
        if (harnessError) pageErrors.push(`harness: ${harnessError}`);
        // The markdown is rendered after an effect and the diagram after a
        // debounce, so ask until the reply is right or the time is up.
        // A reply that threw does not get better: 2 s after a render error
        // is enough to collect what else is logged.
        const deadline = Date.now() + timeout;
        let crashedAt;
        for (;;) {
          problems = await page.evaluate(pageCheck, name);
          const now = Date.now();
          if (pageErrors.length || consoleErrors.some(isRenderError)) {
            crashedAt ??= now;
          }
          if (problems.length === 0 || now > deadline) break;
          if (crashedAt && now - crashedAt > 2000) break;
          await sleep(100);
        }
      } catch (e) {
        problems = [`the page did not get ready: ${e.message.split("\n")[0]}`];
      }
      await context.close();
      results.push({
        name,
        ms: Date.now() - t0,
        failures: verdict({ pageErrors, consoleErrors, requests, problems }),
        consoleErrors,
      });
    }
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }
  return { build, browser: choice.kind, results };
}
