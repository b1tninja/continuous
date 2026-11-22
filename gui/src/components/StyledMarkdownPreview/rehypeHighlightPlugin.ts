// Feel free to add more!
// See gui/node_modules/highlight.js/lib/languages for the full available list
import clojure from "highlight.js/lib/languages/clojure";
import delphi from "highlight.js/lib/languages/delphi";
import elixir from "highlight.js/lib/languages/elixir";
import julia from "highlight.js/lib/languages/julia";
import lisp from "highlight.js/lib/languages/lisp";
import matlab from "highlight.js/lib/languages/matlab";
import ocaml from "highlight.js/lib/languages/ocaml";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import verilog from "highlight.js/lib/languages/verilog";
import { common } from "lowlight";
import rehypeHighlight, { Options } from "rehype-highlight";

const options: Options = {
  languages: {
    ...common,
    clojure,
    delphi,
    elixir,
    julia,
    protobuf,
    verilog,
    powershell,
    ocaml,
    matlab,
    lisp,
  },
};

let transform: ReturnType<typeof rehypeHighlight> | undefined;

/**
 * One highlighter for every message. rehype-highlight registers all of the
 * languages above each time it is set up, which is once per parse, and a
 * grammar is compiled again for each new set. Its transform keeps nothing
 * between trees, so the parses share one.
 */
export function rehypeHighlightPlugin() {
  return () => (transform ??= rehypeHighlight(options));
}
