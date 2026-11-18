/**
 * Maps the command-line flags of scripts/esbuild.js to esbuild options.
 *
 * `vscode:prepublish` passes `--minify`. The script used to ignore it, so the
 * packaged extension shipped unminified.
 *
 * Minification is a second pass over the finished bundle, not `minify: true`
 * on the bundling pass. A minifying bundler turns every module wrapper into
 * an arrow function passed as an argument, and that file is no faster to load
 * than the unminified one; minifying the finished bundle keeps the wrappers as
 * object methods, which V8 compiles on first use. Measured in plain Node,
 * 2026-11-12: 70.9 MB and 157 MB of heap unminified; 43.6 MB, 128 MB and no
 * faster with `minify: true`; 48.0 MB, 117 MB and about 13% faster this way.
 *
 * keepNames goes with it: bundled code reads `constructor.name` and
 * `Function.prototype.name` (error classes, registries), and stack traces in
 * bug reports stay readable.
 */
function esbuildOptionsFromFlags(flags) {
  const sourcemap = flags.includes("--sourcemap");
  return {
    bundle: { sourcemap },
    minifyPass: flags.includes("--minify")
      ? { minify: true, keepNames: true, sourcemap }
      : null,
  };
}

/**
 * Minifies a finished CommonJS bundle in place. With `sourcemap`, esbuild
 * follows the bundle's own source map comment, so the new map still points at
 * the original sources.
 */
async function minifyBundleInPlace(esbuild, file, minifyPass) {
  await esbuild.build({
    entryPoints: [file],
    outfile: file,
    allowOverwrite: true,
    bundle: false,
    format: "cjs",
    platform: "node",
    logLevel: "warning",
    ...minifyPass,
  });
}

module.exports = { esbuildOptionsFromFlags, minifyBundleInPlace };
