import { describe, expect, it } from "vitest";

import { needsJavaScript } from "./needsJs";

/** Synthesized shells, shaped like the real ones (no live fetches). */
const bundle = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `<script src="/static/js/chunk.${i}.a1b2c3.js" defer></script>`,
  ).join("\n");
const inlineState = `<script>window.__STATE__=${JSON.stringify({ data: "x".repeat(20_000) })}</script>`;

const CRA = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<link rel="icon" href="/favicon.ico"/><title>React App</title>
<script defer="defer" src="/static/js/main.4f1c2b.js"></script>
<link href="/static/css/main.9a8b.css" rel="stylesheet"></head>
<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>`;

const NEXT_CLIENT = `<!DOCTYPE html><html><head><meta charSet="utf-8"/><title></title>
${bundle(6)}</head><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}},"page":"/app","query":{},"buildId":"abc","nextExport":true}</script>
</body></html>`;

const ANGULAR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Console</title>
<base href="/"><link rel="stylesheet" href="styles.3ff695c00d717f2d2a11.css"></head>
<body><app-root></app-root>
<script src="runtime.js" type="module"></script><script src="polyfills.js" type="module"></script><script src="main.js" type="module"></script>
</body></html>`;

const ANGULARJS = `<html ng-app="shop"><head><script src="angular.min.js"></script></head>
<body ng-controller="Main"><div ng-view></div></body></html>`;

const DOCUSAURUS_SPA = `<!doctype html><html lang="en" dir="ltr"><head><meta charset="UTF-8">
<title>Docs</title><link rel="stylesheet" href="/assets/css/styles.css">
<script src="/assets/js/runtime~main.js" defer></script><script src="/assets/js/main.js" defer></script>
</head><body class="navigation-with-keyboard"><svg xmlns="http://www.w3.org/2000/svg" style="display:none"><defs></defs></svg>
<div id="__docusaurus"></div></body></html>`;

const SWAGGER = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Swagger UI</title>
<link rel="stylesheet" type="text/css" href="./swagger-ui.css" /></head>
<body><div id="swagger-ui"></div>
<script src="./swagger-ui-bundle.js" charset="UTF-8"> </script>
<script src="./swagger-ui-standalone-preset.js" charset="UTF-8"> </script>
<script>window.onload = function() { window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: '#swagger-ui' }); };</script>
</body></html>`;

const VUE_LOADING = `<!DOCTYPE html><html><head><title>App</title></head><body>
<div id="app"><div class="spinner"><span>Loading…</span></div></div>
<script type="module" src="/assets/index.js"></script></body></html>`;

const SVELTE = `<!doctype html><html><head><script type="module" src="/_app/start.js"></script></head>
<body><div id="svelte"><!-- app --></div></body></html>`;

const NUXT = `<!DOCTYPE html><html><head>${bundle(4)}</head><body><div id="__nuxt"></div><div id="teleports"></div></body></html>`;

const REACT_ROOT_ATTR = `<html><head></head><body><div data-reactroot=""></div>${bundle(1)}</body></html>`;

const SCRIPT_HEAVY = `<!doctype html><html><head>${bundle(8)}${inlineState}</head>
<body><div class="shell"><header>Acme</header></div></body></html>`;

const NOSCRIPT_ONLY = `<html><body><noscript><p>This site requires <b>JavaScript</b>. Please enable it &amp; reload.</p></noscript><main></main></body></html>`;

const SSR_ARTICLE_TEXT =
  "Introduction to streams. Streams are collections of data that might not be available all at once and don't have to fit in memory. This makes streams powerful when working with large amounts of data or data that comes from an external source one chunk at a time.";
const SSR_HEAVY_JS = `<!doctype html><html><head>${bundle(12)}${inlineState}</head>
<body><div id="__next"><article><h1>Streams</h1><p>${SSR_ARTICLE_TEXT}</p></article></div>
<noscript>Enable JavaScript for search.</noscript></body></html>`;

const SHORT_STATIC = `<!doctype html><html><head><title>OK</title></head><body><h1>It works!</h1><p>This is the default page.</p></body></html>`;

const SHORT_404 = `<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`;

const SHORT_WITH_ANALYTICS = `<html><head><script async src="https://www.googletagmanager.com/gtag/js"></script></head>
<body><h1>Coming soon</h1><p>We launch in spring.</p></body></html>`;

const ROOT_WITH_CONTENT = `<html><body><div id="root"><h1>Docs</h1><p>Short server-rendered page with a real root that has text in it, enough to not be empty at all.</p></div>
<script src="/hydrate.js"></script></body></html>`;

const COMMENTED_SCRIPTS = `<html><body><h1>Note</h1><!-- <script></script><script></script><script></script> --><p>Hi</p></body></html>`;

interface Case {
  name: string;
  html: string;
  contentType?: string | null;
  text: string;
  needsJs: boolean;
  confidence?: string;
  reason?: RegExp;
}

const cases: Case[] = [
  {
    name: "create-react-app shell",
    html: CRA,
    text: "You need to enable JavaScript to run this app.",
    needsJs: true,
    confidence: "high",
    reason: /^empty application root #root$/,
  },
  {
    name: "Next.js client-only",
    html: NEXT_CLIENT,
    text: "",
    needsJs: true,
    confidence: "high",
    reason: /^empty application root #__next$/,
  },
  {
    name: "Angular app-root",
    html: ANGULAR,
    text: "Console",
    needsJs: true,
    confidence: "high",
    reason: /^empty application root app-root$/,
  },
  {
    name: "AngularJS ng-app",
    html: ANGULARJS,
    text: "",
    needsJs: true,
    reason: /^empty application root \[ng-app\]$/,
  },
  {
    name: "Docusaurus with JS off",
    html: DOCUSAURUS_SPA,
    text: "",
    needsJs: true,
    reason: /#__docusaurus/,
  },
  {
    name: "Swagger UI",
    html: SWAGGER,
    text: "",
    needsJs: true,
    confidence: "high",
    reason: /3 <script> elements/,
  },
  {
    name: "Vue with a loading spinner",
    html: VUE_LOADING,
    text: "Loading…",
    needsJs: true,
    reason: /#app/,
  },
  {
    name: "SvelteKit",
    html: SVELTE,
    text: "",
    needsJs: true,
    reason: /#svelte/,
  },
  { name: "Nuxt", html: NUXT, text: "", needsJs: true, confidence: "high" },
  {
    name: "data-reactroot",
    html: REACT_ROOT_ATTR,
    text: "",
    needsJs: true,
    reason: /\[data-reactroot\]/,
  },
  {
    name: "script-heavy shell without a known root",
    html: SCRIPT_HEAVY,
    text: "Acme",
    needsJs: true,
    reason: /^\d+ <script> elements, text 0\.0% of the HTML$/,
  },
  {
    name: "noscript only",
    html: NOSCRIPT_ONLY,
    text: "",
    needsJs: true,
    reason:
      /^<noscript>: "This site requires JavaScript\. Please enable it & reload\."$/,
  },
  {
    name: "server-rendered article with heavy JS",
    html: SSR_HEAVY_JS,
    text: `# Streams\n\n${SSR_ARTICLE_TEXT}`,
    needsJs: false,
    confidence: "high",
  },
  {
    name: "short static page",
    html: SHORT_STATIC,
    text: "# It works!\n\nThis is the default page.",
    needsJs: false,
    confidence: "medium",
  },
  {
    name: "nginx 404",
    html: SHORT_404,
    text: "404 Not Found nginx",
    needsJs: false,
  },
  {
    name: "short page with one analytics script",
    html: SHORT_WITH_ANALYTICS,
    text: "Coming soon. We launch in spring.",
    needsJs: false,
  },
  {
    name: "root that has content",
    html: ROOT_WITH_CONTENT,
    text: "# Docs\n\nShort server-rendered page with a real root that has text in it.",
    needsJs: false,
  },
  {
    name: "scripts only inside a comment",
    html: COMMENTED_SCRIPTS,
    text: "Note Hi",
    needsJs: false,
  },
  {
    name: "JSON response",
    html: '{"root": ""}',
    contentType: "application/json",
    text: "",
    needsJs: false,
    reason: /not an HTML response/,
  },
  {
    name: "plain text that looks like a shell",
    html: CRA,
    contentType: "text/plain; charset=utf-8",
    text: "",
    needsJs: false,
  },
  {
    name: "no Content-Type, sniffed as HTML",
    html: CRA,
    contentType: null,
    text: "",
    needsJs: true,
  },
  {
    name: "no Content-Type, not HTML",
    html: "hello",
    contentType: undefined,
    text: "hello",
    needsJs: false,
  },
  {
    name: "XHTML",
    html: CRA,
    contentType: "application/xhtml+xml",
    text: "",
    needsJs: true,
  },
  {
    name: "empty body",
    html: "",
    contentType: "text/html",
    text: "",
    needsJs: false,
  },
];

describe("needsJavaScript", () => {
  it.each(cases)("$name", (c) => {
    const verdict = needsJavaScript(
      c.html,
      "contentType" in c ? c.contentType : "text/html; charset=utf-8",
      c.text,
    );
    expect(verdict.needsJs).toBe(c.needsJs);
    if (c.confidence) expect(verdict.confidence).toBe(c.confidence);
    if (c.reason) {
      expect(verdict.reasons.some((r) => c.reason!.test(r))).toBe(true);
    }
  });

  it("quotes the first 120 characters of the noscript text", () => {
    const long = "Please turn on JavaScript ".repeat(20);
    const v = needsJavaScript(
      `<html><body><noscript>${long}</noscript><div id="root"></div></body></html>`,
      "text/html",
      "",
    );
    expect(v.noscript).toBe(Array.from(long.trim()).slice(0, 120).join(""));
    expect(v.appRoot).toBe("#root");
  });

  it("counts the text in characters, not UTF-16 units", () => {
    const text = "😀".repeat(150);
    const v = needsJavaScript(CRA, "text/html", text);
    expect(v.textChars).toBe(150);
    expect(v.needsJs).toBe(true);
  });

  it("text of 200 characters or more is never needs-js", () => {
    const v = needsJavaScript(CRA, "text/html", "x".repeat(200));
    expect(v.needsJs).toBe(false);
    expect(v.reasons).toEqual(["200 characters of visible text"]);
  });

  it("text at 199 characters with a shell is needs-js at lower confidence", () => {
    const v = needsJavaScript(
      `<html><body><div id="root"></div></body></html>`,
      "text/html",
      "y".repeat(199),
    );
    expect(v.needsJs).toBe(true);
    expect(v.confidence).toBe("low");
  });

  it("the 2% rule measures UTF-8 bytes", () => {
    // 3 scripts, 30 characters of text: needs-js only when the HTML is over 1,500 bytes
    const small = `<html><head>${bundle(3)}</head><body><p>${"é".repeat(30)}</p></body></html>`;
    expect(needsJavaScript(small, "text/html", "é".repeat(30)).needsJs).toBe(
      false,
    );
    const padded = small.replace("<head>", `<head><!--${"ü".repeat(1_000)}-->`);
    expect(needsJavaScript(padded, "text/html", "é".repeat(30)).needsJs).toBe(
      true,
    );
  });

  it("CRLF HTML gives the same verdict", () => {
    const lf = needsJavaScript(SWAGGER, "text/html", "");
    const crlf = needsJavaScript(
      SWAGGER.replace(/\n/g, "\r\n"),
      "text/html",
      "",
    );
    expect({ ...crlf, htmlBytes: 0 }).toEqual({ ...lf, htmlBytes: 0 });
  });

  it("is the same for the same input", () => {
    for (const c of cases) {
      const a = JSON.stringify(needsJavaScript(c.html, "text/html", c.text));
      const b = JSON.stringify(needsJavaScript(c.html, "text/html", c.text));
      expect(a).toBe(b);
    }
  });
});
