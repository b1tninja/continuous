import { describe, expect, it } from "vitest";
import {
  GUI_WEBVIEW_ENABLE_COMMAND_URIS,
  renderWebviewDocument,
  webviewBootstrapScript,
  webviewContentSecurityPolicy,
} from "./webviewCsp";

const bootstrap = webviewBootstrapScript({
  vsCodeUriScheme: "vscode",
  extensionVersion: "1.2.3",
  windowId: "win",
  machineId: "machine",
  vscMediaUrl: "https://webview.example/gui",
  theme: { name: "dark" },
  workspacePaths: ["file:///work"],
  isFullScreen: false,
});

describe("webviewContentSecurityPolicy", () => {
  it("blocks default sources and allows only a nonce for inline script", () => {
    const csp = webviewContentSecurityPolicy({
      cspSource: "https://webview.example",
      nonce: "abc",
      development: false,
    });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc' https://webview.example");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("allows the dev server only in development", () => {
    const dev = webviewContentSecurityPolicy({
      cspSource: "https://webview.example",
      nonce: "abc",
      development: true,
    });
    expect(dev).toContain("http://localhost:5173");
    expect(dev).toContain("ws://localhost:5173");
  });
});

describe("renderWebviewDocument", () => {
  it("puts the policy in the page and nonces every script", () => {
    const csp = webviewContentSecurityPolicy({
      cspSource: "https://webview.example",
      nonce: "nonce-1",
      development: false,
    });
    const html = renderWebviewDocument({
      csp,
      nonce: "nonce-1",
      scriptUri: "https://webview.example/index.js",
      styleUri: "https://webview.example/index.css",
      bootstrap,
      development: false,
    });
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("script-src 'nonce-nonce-1'");
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((tag) => tag.includes('nonce="nonce-1"'))).toBe(true);
    expect(html).toContain("acquireVsCodeApi");
    expect(bootstrap).toContain("acquireVsCodeApi");
  });

  it("escapes a value that would close the script", () => {
    const script = webviewBootstrapScript({
      vsCodeUriScheme: "vscode",
      extensionVersion: "1",
      windowId: "</script><script>alert(1)",
      machineId: "m",
      vscMediaUrl: "https://webview.example",
      theme: {},
      workspacePaths: [],
      isFullScreen: false,
    });
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c");
  });

  it("still builds the page when the theme could not be loaded", () => {
    const script = webviewBootstrapScript({
      vsCodeUriScheme: "vscode",
      extensionVersion: "1",
      windowId: "w",
      machineId: "m",
      vscMediaUrl: "https://webview.example",
      theme: undefined,
      workspacePaths: [],
      isFullScreen: false,
    });
    expect(script).toContain("window.fullColorTheme = undefined;");
    expect(
      () => new Function("acquireVsCodeApi", "localStorage", "window", script),
    ).not.toThrow();
  });
});

describe("GUI_WEBVIEW_ENABLE_COMMAND_URIS", () => {
  it("does not enable command links", () => {
    expect(GUI_WEBVIEW_ENABLE_COMMAND_URIS).toBe(false);
  });
});
