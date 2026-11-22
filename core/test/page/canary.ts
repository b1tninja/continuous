import fs from "fs";
import { homedir } from "node:os";
import * as path from "node:path";

// A file the page project treats as bundled, so canary.page.ts can see what
// the plugin did to it. Nothing else imports it.
export function seenByBundledCode() {
  return {
    namedImport: typeof homedir,
    defaultImport: fs,
    namespace: Object.keys(path),
    process: typeof process,
    Buffer: typeof Buffer,
    global: typeof global,
    require: typeof require,
    dirname: typeof __dirname,
    setImmediate: typeof setImmediate,
    nodeEnv: process.env.NODE_ENV,
    env: process.env,
  };
}

export const joinPaths = () => path.join("a", "b");
export const readPlatform = () => process.platform;
export const encode = () => Buffer.from("a");
