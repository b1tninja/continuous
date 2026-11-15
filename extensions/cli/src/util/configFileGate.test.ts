import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readPermissionsYaml } from "../permissions/permissionsYamlLoader.js";
import { setSafeMode } from "../safeMode.js";

import {
  BROKEN_CONFIG_EXIT_CODE,
  checkConfigFiles,
  exitOnBrokenConfig,
} from "./configFileGate.js";
import { resetBrokenConfigNotices } from "./readPolicyFile.js";

const gracefulExit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./exit.js", () => ({ gracefulExit }));

describe("headless start check for broken policy files", () => {
  let root: string;
  let home: string;
  let cwd: string;
  let permissionsFile: string;
  const where = () => ({ homeDir: home, permissionsFile });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "config-gate-"));
    home = path.join(root, "home");
    cwd = path.join(root, "project");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    permissionsFile = path.join(home, "permissions.yaml");
    resetBrokenConfigNotices();
    delete process.env.CONTINUOUS_GLOBAL_DIR;
    delete process.env.CONTINUE_GLOBAL_DIR;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    gracefulExit.mockClear();
  });

  it("is silent when no policy files exist", () => {
    expect(checkConfigFiles(cwd, false, where())).toBeUndefined();
  });

  it("is silent when the files are valid", () => {
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: {} }),
    );
    fs.writeFileSync(permissionsFile, "allow: []\nask: []\nexclude: []\n");
    expect(checkConfigFiles(cwd, false, where())).toBeUndefined();
  });

  it("refuses on a broken user hook settings file, naming file and position", () => {
    const file = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(file, '{ "hooks": {},\n}');
    const refusal = checkConfigFiles(cwd, false, where());
    expect(refusal).toContain(file);
    expect(refusal).toMatch(/not valid JSON at line 2, column 1/);
    expect(refusal).toContain("--ignore-broken-config");
  });

  it("refuses on a broken project hook settings file", () => {
    fs.mkdirSync(path.join(cwd, ".claude"));
    const file = path.join(cwd, ".claude", "settings.json");
    fs.writeFileSync(file, "{ nope");
    expect(checkConfigFiles(cwd, false, where())).toContain(file);
  });

  it("refuses on a broken permissions.yaml", () => {
    fs.writeFileSync(permissionsFile, "allow: [Read\nask: x\n");
    const refusal = checkConfigFiles(cwd, false, where());
    expect(refusal).toContain(permissionsFile);
    expect(refusal).toMatch(/not valid YAML/);
  });

  it("refuses on a permissions.yaml with the wrong structure", () => {
    fs.writeFileSync(permissionsFile, "allow: Read\n");
    expect(checkConfigFiles(cwd, false, where())).toContain(
      '"allow" must be a list',
    );
  });

  it("lists every broken file", () => {
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{");
    fs.writeFileSync(permissionsFile, "allow: [Read\n");
    const refusal = checkConfigFiles(cwd, false, where())!;
    expect(refusal).toContain("settings.json");
    expect(refusal).toContain("permissions.yaml");
  });

  it("continues, with a notice, when the override is given", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    fs.writeFileSync(permissionsFile, "allow: [Read\n");
    expect(checkConfigFiles(cwd, true, where())).toBeUndefined();
    expect(String(write.mock.calls[0][0])).toContain("--ignore-broken-config");
  });

  it("exitOnBrokenConfig exits with code 2 and prints the refusal", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{");
    await exitOnBrokenConfig({}, where());
    expect(BROKEN_CONFIG_EXIT_CODE).toBe(2);
    expect(gracefulExit).toHaveBeenCalledWith(2);
    expect(String(write.mock.calls[0][0])).toContain("Cannot start");
  });

  it("exitOnBrokenConfig does not exit when the override is set", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{");
    await exitOnBrokenConfig({ ignoreBrokenConfig: true }, where());
    expect(gracefulExit).not.toHaveBeenCalled();
  });

  it("exitOnBrokenConfig does not exit in safe mode", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{");
    setSafeMode(true);
    try {
      await exitOnBrokenConfig({}, where());
    } finally {
      setSafeMode(false);
    }
    expect(gracefulExit).not.toHaveBeenCalled();
  });

  it("readPermissionsYaml: absent, empty and valid are not broken", () => {
    expect(readPermissionsYaml(permissionsFile).status).toBe("absent");
    fs.writeFileSync(permissionsFile, "# only a comment\n");
    expect(readPermissionsYaml(permissionsFile)).toEqual({
      status: "ok",
      value: {},
    });
    fs.writeFileSync(permissionsFile, "ask:\n  - Bash\n");
    expect(readPermissionsYaml(permissionsFile)).toEqual({
      status: "ok",
      value: { ask: ["Bash"] },
    });
  });
});
