/**
 * `continuous doctor <topic>`: read-only diagnostics.
 *
 * `network [url...]`: why does a request fail behind a proxy or a
 * TLS-inspecting gateway? Shows the proxy and CA settings the CLI would use
 * (credentials masked), then tests each URL the way the CLI sends requests
 * and prints the certificate chain it was given.
 *
 * `config`: which settings files exist and parse, and each main control's
 * value and source (see doctorConfig.ts).
 *
 * Nothing here prints a secret: proxy URLs have their user name and password
 * replaced, and only certificate subjects, issuers, dates and short
 * fingerprints are shown, never the certificate bodies.
 */

import http from "node:http";
import https from "node:https";
import type { DetailedPeerCertificate, TLSSocket } from "node:tls";

import {
  CertsCache,
  createAgentForUrl,
  defaultUseSystemCa,
  getProxy,
  getTlsErrorHint,
  shouldBypassProxy,
} from "@continuedev/fetch";

import type { NetworkRequestOptions } from "../util/networkFetch.js";

import { doctorConfigCommand, type DoctorFlags } from "./doctorConfig.js";

const PROXY_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];

/** `scheme://***@host:port` for a proxy URL; the user name and password never appear. */
export function maskProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    const auth = url.username || url.password ? "***@" : "";
    return `${url.protocol}//${auth}${url.host}`;
  } catch {
    // Not a URL: show nothing that could be a credential.
    return "(not a valid URL)";
  }
}

export interface ChainEntry {
  subject: string;
  issuer: string;
  validTo: string;
  fingerprint: string;
}

function name(field: unknown): string {
  const record = (field ?? {}) as Record<string, string | string[]>;
  const value = record.CN ?? record.O ?? "";
  return Array.isArray(value) ? value.join(",") : value || "(no name)";
}

/** The chain from the leaf up, as short lines; stops at a self-signed root or a repeat. */
export function chainSummary(
  leaf: DetailedPeerCertificate | undefined,
): ChainEntry[] {
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();
  let cert: DetailedPeerCertificate | undefined = leaf;
  while (cert && cert.fingerprint256 && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256);
    chain.push({
      subject: name(cert.subject),
      issuer: name(cert.issuer),
      validTo: cert.valid_to,
      fingerprint: cert.fingerprint256.slice(0, 23),
    });
    cert = cert.issuerCertificate;
  }
  return chain;
}

export interface HostReport {
  url: string;
  route: string;
  ok: boolean;
  status?: number;
  error?: string;
  hint?: string;
  chain: ChainEntry[];
}

function route(url: URL, options?: NetworkRequestOptions): string {
  const proxy = getProxy(url.protocol, options as never);
  if (!proxy) return "direct (no proxy configured for this scheme)";
  if (shouldBypassProxy(url.hostname, options as never)) {
    return "direct (matched NO_PROXY / noProxy)";
  }
  return `via proxy ${maskProxyUrl(proxy)}`;
}

/** Send one HEAD request the way the CLI does and report what happened. */
export async function checkHost(
  rawUrl: string,
  options?: NetworkRequestOptions,
  timeoutMs = 10_000,
): Promise<HostReport> {
  const url = new URL(rawUrl);
  const report: HostReport = {
    url: `${url.protocol}//${url.host}`,
    route: route(url, options),
    ok: false,
    chain: [],
  };
  try {
    const { agent } = await createAgentForUrl(url, options as never);
    const transport = url.protocol === "https:" ? https : http;
    await new Promise<void>((resolve, reject) => {
      const req = transport.request(
        url,
        { method: "HEAD", agent, timeout: timeoutMs },
        (res) => {
          report.status = res.statusCode;
          report.ok = true;
          const socket = res.socket as TLSSocket;
          if (typeof socket.getPeerCertificate === "function") {
            report.chain = chainSummary(socket.getPeerCertificate(true));
          }
          res.resume();
          resolve();
        },
      );
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
      req.end();
    });
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.hint = getTlsErrorHint(error);
  }
  return report;
}

function settingsLines(options?: NetworkRequestOptions): string[] {
  const lines = [`Node ${process.version} on ${process.platform}`];
  for (const key of PROXY_VARS) {
    const value = process.env[key];
    if (!value) continue;
    lines.push(
      `${key}=${key.toLowerCase() === "no_proxy" ? value : maskProxyUrl(value)}`,
    );
  }
  if (options?.proxy) {
    lines.push(`requestOptions.proxy=${maskProxyUrl(options.proxy)}`);
  }
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  if (extra) lines.push(`NODE_EXTRA_CA_CERTS=${extra}`);
  const useSystem = options?.useSystemCa ?? defaultUseSystemCa();
  const cache = CertsCache.getInstance();
  lines.push(
    `system CA store: ${useSystem ? "used" : "not used"}${
      useSystem ? ` (${cache.systemCa.length} certificates readable)` : ""
    }`,
  );
  if (options?.caBundlePath) {
    lines.push(`caBundlePath=${[options.caBundlePath].flat().join(", ")}`);
  }
  if (options?.verifySsl === false) {
    lines.push("verifySsl=false (certificates are NOT checked)");
  }
  return lines;
}

export interface DoctorOptions {
  /** Where to write; defaults to stdout. */
  write?: (line: string) => void;
  requestOptions?: NetworkRequestOptions;
  /** `--json`, for the topics that have a machine-readable form. */
  json?: boolean;
  /** The root flags of this invocation, for `config`. */
  flags?: DoctorFlags;
}

/**
 * The topics, in the order the usage line lists them. A new topic is one
 * entry here and one `case` in `doctorCommand`; `env` (what the model is told
 * about this machine, ENV28) is planned as the next one.
 */
export const DOCTOR_TOPICS: Readonly<Record<string, string>> = {
  config: "settings files (do they parse) and each control's value and source",
  network: "proxy and certificate settings, and a TLS test per URL",
};

function usage(write: (line: string) => void): number {
  write("Usage: continuous doctor <topic>");
  for (const [topic, what] of Object.entries(DOCTOR_TOPICS)) {
    write(`  ${topic.padEnd(8)} ${what}`);
  }
  return 1;
}

/** Returns the process exit code: 0 when nothing is wrong. */
export async function doctorCommand(
  topic: string | undefined,
  urls: string[],
  options: DoctorOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  switch (topic) {
    case "config":
      return doctorConfigCommand({
        json: options.json,
        flags: options.flags,
        write,
      });
    case "network":
      return doctorNetwork(urls, options, write);
    default:
      return usage(write);
  }
}

/** 0 when every URL answered. */
async function doctorNetwork(
  urls: string[],
  options: DoctorOptions,
  write: (line: string) => void,
): Promise<number> {
  write("Network settings");
  for (const line of settingsLines(options.requestOptions)) {
    write(`  ${line}`);
  }

  if (urls.length === 0) {
    write("");
    write("Usage: continuous doctor network <url...>");
    write("Pass the address you want to reach, such as your model endpoint.");
    return 0;
  }
  const targets = urls;
  let failed = 0;
  for (const target of targets) {
    write("");
    let report: HostReport;
    try {
      report = await checkHost(target, options.requestOptions);
    } catch {
      write(`${target}: not a valid URL`);
      failed++;
      continue;
    }
    write(report.url);
    write(`  route: ${report.route}`);
    if (report.ok) {
      write(`  result: HTTP ${report.status}`);
    } else {
      failed++;
      write(`  result: failed (${report.error})`);
      if (report.hint) write(`  hint: ${report.hint}`);
    }
    report.chain.forEach((entry, index) => {
      write(
        `  cert ${index}: ${entry.subject} (issuer ${entry.issuer}, expires ${entry.validTo}, sha256 ${entry.fingerprint}...)`,
      );
    });
  }
  return failed === 0 ? 0 : 1;
}
