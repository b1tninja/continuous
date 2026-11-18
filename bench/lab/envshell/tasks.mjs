// The env-shell-tasks suite: 13 small tasks that need a command run on the
// host shell, each with a deterministic checker. Prompts name relative paths
// only and never name a shell: what the model knows about the host is the
// arm's business (arms.mjs). Tasks use node and git, which the host has, so
// the programs are the same on every shell and only the shell text differs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  checkJson,
  checkText,
  lines,
  normRel,
  samePath,
  toNativePath,
} from "./checkers.mjs";

const w = (dir, rel, text) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// the same file may be named by a short (8.3) or a long Windows path
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

/** Read a file under the task directory, or null. */
export const readIn = (dir) => (rel) => {
  try {
    return fs.readFileSync(path.join(dir, rel));
  } catch {
    return null;
  }
};

const merge = (...rs) => ({
  pass: rs.every((r) => r.pass),
  reasons: rs.flatMap((r) => r.reasons),
  encoding: rs.map((r) => r.encoding).find(Boolean) ?? null,
});

const NUMS = [
  ["ada", 31],
  ["bob", 77],
  ["cyd", 12],
  ["dee", 95],
  ["eli", 58],
  ["fay", 64],
  ["gus", 3],
  ["hal", 88],
];

/**
 * A task: id, title, covers (failure classes it can provoke), minCommands (the
 * fewest commands a good solution needs: the base for "wasted turns"),
 * prompt(ctx), setup(ctx), env(ctx), check(ctx). ctx = { dir, token, read,
 * shell }. `check` returns { pass, reasons, encoding }.
 */
export const TASKS = [
  {
    id: "ES01",
    title: "create two files",
    covers: ["path-form", "alias-flags", "tool-missing"],
    minCommands: 1,
    prompt: () =>
      "Create a folder named out in the current directory, and in it two files: a.txt containing exactly the text alpha and b.txt containing exactly the text beta.",
    setup: () => {},
    check: ({ read }) =>
      merge(
        checkText(read("out/a.txt"), "alpha"),
        checkText(read("out/b.txt"), "beta"),
      ),
  },
  {
    id: "ES02",
    title: "chain two steps",
    covers: ["parse-bashism"],
    minCommands: 1,
    prompt: () =>
      "In ONE command line that chains the steps (so the second step only runs if the first succeeded): create a folder named build, then create build/result.txt containing exactly the word done.",
    setup: () => {},
    check: ({ read }) => checkText(read("build/result.txt"), "done"),
  },
  {
    id: "ES03",
    title: "read an environment variable",
    covers: ["env-form"],
    minCommands: 1,
    prompt: () =>
      "The environment variable TASK_TOKEN is set. Write its value, and nothing else, to the file token.txt in the current directory.",
    setup: () => {},
    env: ({ token }) => ({ TASK_TOKEN: token }),
    check: ({ read, token }) => checkText(read("token.txt"), token),
  },
  {
    id: "ES04",
    title: "write JSON with quotes",
    covers: ["quoting", "encoding"],
    minCommands: 1,
    prompt: () =>
      'Create config.json in the current directory holding exactly this JSON value: {"name":"demo","tags":["a","b"],"note":"say \\"hi\\""} (the note value is: say "hi" with the double quotes escaped in JSON). It must parse with a standard JSON parser.',
    setup: () => {},
    check: ({ read }) =>
      checkJson(read("config.json"), {
        name: "demo",
        tags: ["a", "b"],
        note: 'say "hi"',
      }),
  },
  {
    id: "ES05",
    title: "run a script, save its output",
    covers: ["encoding", "alias-flags"],
    minCommands: 1,
    prompt: () =>
      "Run `node sum.js 3 4 5` and save what it prints to sum.txt in the current directory.",
    setup: ({ dir }) =>
      w(
        dir,
        "sum.js",
        "console.log(process.argv.slice(2).reduce((a, b) => a + Number(b), 0));\n",
      ),
    check: ({ read }) => checkText(read("sum.txt"), "12"),
  },
  {
    id: "ES06",
    title: "git branch and commit in a temp repo",
    covers: ["quoting", "hang", "parse-bashism"],
    minCommands: 2,
    prompt: () =>
      'The current directory is a git repository. Create a branch named feature/x, append a line "second line" to notes.txt, and commit it with exactly this commit message: fix: handle "quoted" input',
    setup: ({ dir }) => {
      w(dir, "notes.txt", "first line\n");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "eval@example.invalid");
      git(dir, "config", "user.name", "eval");
      git(dir, "config", "core.autocrlf", "false");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "init");
    },
    check: ({ dir, read }) => {
      const reasons = [];
      try {
        if (git(dir, "rev-parse", "--abbrev-ref", "HEAD") !== "feature/x")
          reasons.push("HEAD is not on feature/x");
        if (
          git(dir, "log", "-1", "--format=%s") !== 'fix: handle "quoted" input'
        )
          reasons.push("commit subject is wrong");
        if (git(dir, "status", "--porcelain") !== "")
          reasons.push("working tree not clean");
      } catch (e) {
        reasons.push(`git failed: ${String(e.message).slice(0, 60)}`);
      }
      const notes = lines(read("notes.txt"));
      if (
        JSON.stringify(notes) !== JSON.stringify(["first line", "second line"])
      )
        reasons.push("notes.txt lines are wrong");
      return { pass: reasons.length === 0, reasons, encoding: null };
    },
  },
  {
    id: "ES07",
    title: "pipe, sort and take the top three",
    covers: ["alias-flags", "tool-missing", "parse-bashism"],
    minCommands: 1,
    prompt: () =>
      "data.csv has a header line (name,score) and one row per person. Write the names of the three people with the highest score, highest first, one per line, to top3.txt.",
    setup: ({ dir }) =>
      w(
        dir,
        "data.csv",
        ["name,score", ...NUMS.map((r) => r.join(","))].join("\n") + "\n",
      ),
    check: ({ read }) => checkText(read("top3.txt"), "dee\nhal\nbob"),
  },
  {
    id: "ES08",
    title: "list files that contain a word",
    covers: ["path-form", "tool-missing", "alias-flags"],
    minCommands: 1,
    prompt: () =>
      "Find every file under the folder src (any depth) whose text contains the word TODO. Write their paths relative to the current directory, with forward slashes, one per line, sorted alphabetically, to todo.txt.",
    setup: ({ dir }) => {
      w(dir, "src/a.js", "// TODO fix\n");
      w(dir, "src/lib/b.js", "ok\n");
      w(dir, "src/lib/deep/c.js", "x // TODO later\n");
      w(dir, "src/lib/d.md", "todo in lowercase only\n");
      w(dir, "src/e.txt", "TODO\n");
    },
    check: ({ read }) => {
      const got = lines(read("todo.txt"));
      const ok =
        JSON.stringify(got?.map(normRel)) ===
        JSON.stringify(["src/a.js", "src/e.txt", "src/lib/deep/c.js"]);
      const bs = (read("todo.txt") ?? Buffer.alloc(0)).includes(0x5c);
      return {
        pass: ok && !bs,
        reasons: ok
          ? bs
            ? ["paths use backslashes"]
            : []
          : [`got ${JSON.stringify(got)}`],
        encoding: null,
      };
    },
  },
  {
    id: "ES09",
    title: "paths with spaces, absolute path out",
    covers: ["path-form", "quoting"],
    minCommands: 1,
    prompt: () =>
      'Copy the file "my docs/report 1.txt" to "archive/report-1.txt" (create the archive folder), then write the absolute path of the copy, and nothing else, to path.txt.',
    setup: ({ dir }) => w(dir, "my docs/report 1.txt", "quarterly\n"),
    check: ({ dir, read }) => {
      const copy = read("archive/report-1.txt");
      const reasons = [];
      if (copy == null || copy.toString().trim() !== "quarterly")
        reasons.push("archive/report-1.txt missing or wrong");
      if (read("my docs/report 1.txt") == null)
        reasons.push("original was removed");
      const written = lines(read("path.txt"));
      if (!written || written.length !== 1)
        reasons.push("path.txt should hold one line");
      else {
        const native = toNativePath(written[0]);
        const want = path.join(dir, "archive", "report-1.txt");
        if (!path.isAbsolute(native)) reasons.push("path is not absolute");
        else if (!samePath(real(native), real(want)))
          reasons.push("path is not the copy's path");
      }
      return { pass: reasons.length === 0, reasons, encoding: null };
    },
  },
  {
    id: "ES10",
    title: "start a background process, then stop it",
    covers: ["hang"],
    minCommands: 3,
    prompt: () =>
      "The script ticker.js appends a line to ticks.log every 100 ms and never exits on its own. Start it in the background so your command returns at once, wait about one second, write the number of lines in ticks.log to count.txt (just the number), then stop the ticker process so nothing keeps running.",
    setup: ({ dir }) =>
      w(
        dir,
        "ticker.js",
        [
          'const fs = require("fs");',
          'fs.writeFileSync("ticker.pid", String(process.pid));',
          'setInterval(() => fs.appendFileSync("ticks.log", "tick\\n"), 100);',
          "setTimeout(() => process.exit(0), 60000);",
          "",
        ].join("\n"),
      ),
    check: ({ read, shell }) => {
      const reasons = [];
      const n = Number((read("count.txt") ?? "").toString().trim());
      const ticks = lines(read("ticks.log"))?.length ?? 0;
      if (!Number.isInteger(n) || n < 3)
        reasons.push("count.txt is not a number of at least 3");
      if (ticks < 3) reasons.push("the ticker did not run");
      const pid = Number((read("ticker.pid") ?? "").toString().trim());
      if (shell !== "wsl" && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          reasons.push("ticker is still running");
        } catch {
          /* gone: good */
        }
      }
      return { pass: reasons.length === 0, reasons, encoding: null };
    },
    cleanup: ({ read }) => {
      const pid = Number((read("ticker.pid") ?? "").toString().trim());
      if (Number.isInteger(pid) && pid > 0)
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
    },
  },
  {
    id: "ES11",
    title: "nested quoting through node -e",
    covers: ["quoting"],
    minCommands: 1,
    prompt: () =>
      `Using a single \`node -e\` command (no script file), write the text He said "it's fine" & left to the file q.txt, exactly, with no trailing newline needed.`,
    setup: () => {},
    check: ({ read }) => checkText(read("q.txt"), `He said "it's fine" & left`),
  },
  {
    id: "ES12",
    title: "replace text, keep LF line endings",
    covers: ["encoding"],
    minCommands: 1,
    prompt: () =>
      "In notes.txt replace every occurrence of the word foo with bar, and save it in place. The file uses LF line endings and must keep them, with no byte order mark.",
    setup: ({ dir }) => w(dir, "notes.txt", "foo one\ntwo foo\nthree\n"),
    check: ({ read }) => {
      return checkText(read("notes.txt"), "bar one\ntwo bar\nthree", {
        allowCrlf: false,
      });
    },
  },
  {
    id: "ES13",
    title: "read an exit code",
    covers: ["env-form", "alias-flags"],
    minCommands: 1,
    prompt: () =>
      "Run `node check.js`. It prints a message and exits with a nonzero status. Write that exit status, and nothing else, to code.txt.",
    setup: ({ dir }) =>
      w(dir, "check.js", 'console.log("checks failed");\nprocess.exit(3);\n'),
    check: ({ read }) => checkText(read("code.txt"), "3"),
  },
];

export const taskById = (id) => TASKS.find((t) => t.id === id);

/** Create a fresh task directory; returns the context a checker needs. */
export function prepare(task, dir, { token, shell }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ctx = { dir, token, shell, read: readIn(dir) };
  task.setup(ctx);
  return ctx;
}
