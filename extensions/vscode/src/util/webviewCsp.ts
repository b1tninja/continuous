/**
 * Content-Security-Policy for the Continuous chat webview.
 * Inline scripts run only with the page nonce. Diagram and chat HTML cannot
 * add their own script.
 */
export function webviewContentSecurityPolicy(options: {
  cspSource: string;
  nonce: string;
  development: boolean;
}): string {
  const { cspSource, nonce, development } = options;
  const scriptSrc = [
    `'nonce-${nonce}'`,
    cspSource,
    ...(development ? ["http://localhost:5173"] : []),
  ].join(" ");
  const styleSrc = [
    cspSource,
    "'unsafe-inline'",
    ...(development ? ["http://localhost:5173"] : []),
  ].join(" ");
  const connectSrc = [
    cspSource,
    "https:",
    "http:",
    ...(development ? ["http://localhost:5173", "ws://localhost:5173"] : []),
  ].join(" ");
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `img-src ${cspSource} https: http: data: blob:`,
    `font-src ${cspSource} data:`,
    `connect-src ${connectSrc}`,
    `frame-src ${cspSource} data: blob: about:`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function jsLiteral(value: unknown): string {
  // JSON.stringify returns undefined for undefined, a function or a symbol.
  // A theme that failed to load is such a value, and it must not stop the page.
  const json: string | undefined = JSON.stringify(value);
  return json === undefined ? "undefined" : json.replace(/</g, "\\u003c");
}

export interface WebviewBootstrapInput {
  vsCodeUriScheme: string;
  extensionVersion: string;
  windowId: string;
  machineId: string;
  vscMediaUrl: string;
  theme: unknown;
  workspacePaths: string[];
  isFullScreen: boolean;
  edits?: unknown;
  page?: string;
}

/** One nonce'd script: the VS Code API plus the values the page reads at start. */
export function webviewBootstrapScript(input: WebviewBootstrapInput): string {
  const lines = [
    "const vscode = acquireVsCodeApi();",
    `localStorage.setItem("ide", ${jsLiteral(JSON.stringify("vscode"))});`,
    `localStorage.setItem("vsCodeUriScheme", ${jsLiteral(JSON.stringify(input.vsCodeUriScheme))});`,
    `localStorage.setItem("extensionVersion", ${jsLiteral(JSON.stringify(input.extensionVersion))});`,
    `window.windowId = ${jsLiteral(input.windowId)};`,
    `window.vscMachineId = ${jsLiteral(input.machineId)};`,
    `window.vscMediaUrl = ${jsLiteral(input.vscMediaUrl)};`,
    `window.ide = "vscode";`,
    `window.fullColorTheme = ${jsLiteral(input.theme)};`,
    `window.colorThemeName = "dark-plus";`,
    `window.workspacePaths = ${jsLiteral(input.workspacePaths)};`,
    `window.isFullScreen = ${input.isFullScreen ? "true" : "false"};`,
  ];
  if (input.edits !== undefined) {
    lines.push(`window.edits = ${jsLiteral(input.edits)};`);
  }
  if (input.page) {
    lines.push(`window.location.pathname = ${jsLiteral(input.page)};`);
  }
  return lines.join("\n");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** Chat panel is not given command links. */
export const GUI_WEBVIEW_ENABLE_COMMAND_URIS = false;

export function renderWebviewDocument(options: {
  csp: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  bootstrap: string;
  development: boolean;
}): string {
  const nonce = escapeAttr(options.nonce);
  const csp = escapeAttr(options.csp);
  const scriptUri = escapeAttr(options.scriptUri);
  const styleUri = escapeAttr(options.styleUri);
  const devRefresh = options.development
    ? `<script type="module" nonce="${nonce}">
          import RefreshRuntime from "http://localhost:5173/@react-refresh"
          RefreshRuntime.injectIntoGlobalHook(window)
          window.$RefreshReg$ = () => {}
          window.$RefreshSig$ = () => (type) => type
          window.__vite_plugin_react_preamble_installed__ = true
          </script>`
    : "";
  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <link href="${styleUri}" rel="stylesheet">
        <title>Continuous</title>
      </head>
      <body>
        <div id="root"></div>
        <script nonce="${nonce}">
${options.bootstrap}
        </script>
        ${devRefresh}
        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
    </html>`;
}
