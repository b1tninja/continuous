import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  hasOpenssl,
  startTlsProxyFixture,
  type TlsProxyFixture,
} from "../test-helpers/tlsProxyFixture.js";

import { chainSummary, doctorCommand, maskProxyUrl } from "./doctor.js";

const ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];

describe("maskProxyUrl", () => {
  it("never shows credentials", () => {
    const masked = maskProxyUrl("http://alice:hunter2@proxy.corp:3128");
    expect(masked).toBe("http://***@proxy.corp:3128");
    expect(masked).not.toMatch(/alice|hunter2/);
    expect(maskProxyUrl("http://proxy.corp:3128")).toBe(
      "http://proxy.corp:3128",
    );
    expect(maskProxyUrl("alice:hunter2@nonsense")).not.toMatch(/hunter2/);
  });
});

describe("chainSummary", () => {
  it("stops at a self-signed root and does not loop", () => {
    const root: any = {
      subject: { CN: "Root" },
      issuer: { CN: "Root" },
      valid_to: "Jan 1 2030",
      fingerprint256: "AA:BB",
    };
    root.issuerCertificate = root;
    const leaf: any = {
      subject: { CN: "leaf" },
      issuer: { CN: "Root" },
      valid_to: "Jan 1 2027",
      fingerprint256: "CC:DD",
      issuerCertificate: root,
    };
    expect(chainSummary(leaf).map((c) => c.subject)).toEqual(["leaf", "Root"]);
  });
});

describe.skipIf(!hasOpenssl())("doctor network", () => {
  let fixture: TlsProxyFixture;
  beforeAll(async () => {
    fixture = await startTlsProxyFixture();
  });
  afterAll(async () => fixture.close());
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
  });

  it("reports the route, the result and the certificate chain, masking proxy credentials", async () => {
    const lines: string[] = [];
    const proxy = fixture.proxyUrl.replace("http://", "http://alice:hunter2@");
    const code = await doctorCommand("network", [fixture.url], {
      write: (l) => lines.push(l),
      requestOptions: {
        proxy,
        caBundlePath: fixture.caPath,
        useSystemCa: false,
      },
    });
    const out = lines.join("\n");
    expect(code).toBe(0);
    expect(out).toContain("via proxy http://***@127.0.0.1:");
    expect(out).toContain("HTTP 200");
    expect(out).toMatch(/cert 0: localhost \(issuer Test Inspection Root/);
    expect(out).not.toMatch(/alice|hunter2/);
  });

  it("explains an untrusted certificate", async () => {
    const lines: string[] = [];
    const code = await doctorCommand("network", [fixture.url], {
      write: (l) => lines.push(l),
      requestOptions: { proxy: fixture.proxyUrl, useSystemCa: false },
    });
    const out = lines.join("\n");
    expect(code).toBe(1);
    expect(out).toContain("failed");
    expect(out).toContain("hint:");
  });

  it("prints usage for an unknown topic", async () => {
    const lines: string[] = [];
    expect(
      await doctorCommand("other", [], { write: (l) => lines.push(l) }),
    ).toBe(1);
    expect(lines[0]).toContain("Usage");
  });

  it("checks no host by default and prints usage", async () => {
    const lines: string[] = [];
    expect(
      await doctorCommand("network", [], { write: (l) => lines.push(l) }),
    ).toBe(0);
    const out = lines.join(" | ");
    expect(out).toContain("Usage: continuous doctor network <url...>");
    expect(out).not.toContain("continue.dev");
    expect(out).not.toContain("route:");
  });
});
