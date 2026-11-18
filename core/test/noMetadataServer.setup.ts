// Runs before every test file (vitest setupFiles). A test never reaches a
// cloud metadata server: the GCE one (google-auth-library through
// gcp-metadata, when it looks for default credentials) or the EC2 one (the AWS
// SDK's instance credentials). On a developer's machine the attempt only
// times out and prints MetadataLookupWarning; on a cloud VM it would pick up
// that machine's real credentials. liveProviderGuard sets
// METADATA_SERVER_DETECTION=none and AWS_EC2_METADATA_DISABLED for this; the
// guard below fails the test that connects anyway.
import net from "node:net";
import { afterEach, expect } from "vitest";

import { liveProviderTestsEnabled } from "./liveProviderGuard";

export const METADATA_HOSTS = [
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.google.internal.",
  "metadata",
];

/** Hosts a test tried to reach; on globalThis so the guard's own test can take them. */
export const METADATA_ATTEMPTS = Symbol.for("continuous.test.metadataAttempts");
const attempts: string[] = ((globalThis as any)[METADATA_ATTEMPTS] ??= []);

function hostOf(args: unknown[]): string | undefined {
  // net.connect() and http agents pass their already-normalized arguments
  // as one array
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (first && typeof first === "object") {
    const host = (first as { host?: unknown }).host;
    return typeof host === "string" ? host : undefined;
  }
  return typeof second === "string" ? second : undefined;
}

if (!liveProviderTestsEnabled()) {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const host = hostOf(args)
      ?.toLowerCase()
      .replace(/^\[|\]$/g, "");
    if (host && METADATA_HOSTS.includes(host)) {
      attempts.push(host);
      throw new Error(
        `A test tried to reach the cloud metadata server at ${host}; mock the auth client instead`,
      );
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;

  afterEach(() => {
    const seen = attempts.splice(0);
    expect(seen, "connections to a cloud metadata server").toEqual([]);
  });
}
