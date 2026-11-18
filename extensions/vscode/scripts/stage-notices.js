// Ship the legal files in the VSIX: NOTICE, and a THIRD_PARTY_NOTICES.txt generated from the
// lockfiles of everything the extension bundles (extension host, core, webview, local packages).
// vsce picks both up from the extension folder; LICENSE.txt is tracked there already.
// Fails the build on a copyleft or unknown licence (scripts/licenses/exceptions.json).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const extDir = path.join(__dirname, "..");
const root = path.join(extDir, "..", "..");

function stageNotices() {
  fs.copyFileSync(path.join(root, "NOTICE"), path.join(extDir, "NOTICE"));
  const packages = fs
    .readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        fs.existsSync(path.join(root, "packages", d.name, "package-lock.json")),
    )
    .map((d) => path.join(root, "packages", d.name));
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "licenses", "third-party-notices.mjs"),
      path.join(extDir, "THIRD_PARTY_NOTICES.txt"),
      path.join(root, "core"),
      path.join(root, "gui"),
      extDir,
      ...packages,
    ],
    { stdio: "inherit" },
  );
}

module.exports = { stageNotices };
