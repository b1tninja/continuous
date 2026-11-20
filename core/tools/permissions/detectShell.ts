import type { ShellKind } from "../../util/shell";

/**
 * Which shell a command's TEXT was written for (plans/command-shell-dialects.md).
 * It is a scorer over syntax that only one dialect has: `$env:X`, Verb-Noun
 * cmdlets and `-eq` mean PowerShell; `export X=`, `; then`, `2>/dev/null` and
 * `<<EOF` mean a POSIX shell; `setopt` and `${(f)...}` mean zsh; `%VAR%` and
 * `if exist` mean cmd. It reads text only, so it is a hint: lint uses it to
 * say "this is bash and the shell is PowerShell", and analysis uses it to read
 * an ambiguous command under every plausible grammar. It never overrides the
 * shell that actually runs the command.
 */
export type Shell = Exclude<ShellKind, "unknown">;

export interface ShellDetection {
  /** The shells the text could be written for, best first. Empty when nothing is telling. */
  likely: Shell[];
  /** What was seen, one phrase each, so a message can show its evidence */
  evidence: string[];
  /** high: one family clearly leads; medium: leads; low: a guess or nothing */
  confidence: "high" | "medium" | "low";
}

export type ShellFamily = "posix" | "powershell" | "cmd";

export function familyOf(shell: ShellKind): ShellFamily | undefined {
  if (shell === "bash" || shell === "zsh" || shell === "sh") return "posix";
  if (shell === "powershell" || shell === "cmd") return shell;
  return undefined;
}

type Targets = Partial<Record<Shell, number>>;
interface Signal {
  re: RegExp;
  says: string;
  weight: number;
  shells: Shell[];
  /**
   * Look only at text outside quotes. Quoted text is data for another program
   * (`node -e "x=>{a,b}"`), not shell syntax.
   */
  unquoted?: boolean;
}

/**
 * The text with the inside of '...' and "..." blanked out (same length), so a
 * signal that only means something in shell syntax is not set off by a script
 * or message passed as an argument. A backslash or backtick escapes a quote.
 */
export function maskQuoted(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if ((c === "\\" || c === "`") && quote === '"' && i + 1 < text.length) {
        out += "  ";
        i++;
      } else if (c === quote) {
        quote = undefined;
        out += c;
      } else {
        out += c === "\n" ? c : " ";
      }
    } else {
      if (c === '"' || c === "'") quote = c;
      out += c;
    }
  }
  return out;
}

const POSIX_ALL: Shell[] = ["bash", "zsh", "sh"];
const BASH_ZSH: Shell[] = ["bash", "zsh"];
const WIN_PS: Shell[] = ["powershell"];

const VERBS =
  "Get|Set|New|Remove|Select|Where|ForEach|Write|Invoke|Test|Start|Stop|Import|Export|Out|Add|Clear|Copy|Move|Rename|Join|Split|Resolve|Read|Format|Measure|Sort|Group|Compare|ConvertTo|ConvertFrom|Enter|Exit|Install|Uninstall|Register|Restart|Update|Expand|Compress|Find|Show|Wait|Disable|Enable|Push|Pop|Send|Receive|Unregister|Tee|Trace|Search";

const SIGNALS: Signal[] = [
  // ---- PowerShell
  {
    re: new RegExp(`\\b(?:${VERBS})-[A-Z][A-Za-z]+\\b`),
    says: "a Verb-Noun cmdlet",
    weight: 4,
    shells: WIN_PS,
  },
  { re: /\$env:\w/i, says: "$env:NAME", weight: 4, shells: WIN_PS },
  {
    re: /\{[^}]*\$_(?![\w])|\$PSItem\b/,
    says: "$_ in a script block",
    weight: 3,
    shells: WIN_PS,
  },
  { re: /\$null\b/i, says: "$null", weight: 2, shells: WIN_PS },
  { re: /@\{/, says: "a @{} hashtable", weight: 3, shells: WIN_PS },
  {
    re: /\[[A-Za-z][\w.]*\]::\w/,
    says: "a [type]::member",
    weight: 4,
    shells: WIN_PS,
  },
  {
    re: /\$(?:LASTEXITCODE|PSVersionTable|PSScriptRoot|PWD|HOME)\b/,
    says: "a PowerShell automatic variable",
    weight: 3,
    shells: WIN_PS,
  },
  {
    re: /(?:^|[;{(]\s*)\$\w+\s*=[^=]/m,
    says: "$var = value assignment",
    weight: 3,
    shells: WIN_PS,
  },
  {
    re: /`(?:[$"'`]|[nrt0ae](?![\w])|$)/m,
    says: "a backtick escape",
    weight: 3,
    shells: WIN_PS,
  },
  {
    re: /\s-(?:Path|LiteralPath|Recurse|Force|Name|Filter|Include|Exclude|Encoding|ErrorAction|Value|Command|Uri)\b/,
    says: "a -Capitalised parameter",
    weight: 2,
    shells: WIN_PS,
  },
  {
    re: /^\s*(?:function\s+[\w-]+\s*\{|param\s*\()/m,
    says: "a function or param block",
    weight: 3,
    shells: WIN_PS,
  },
  {
    re: /\b(?:foreach|if|while|switch)\s*\(\s*\$\w/i,
    says: "a PowerShell control statement",
    weight: 3,
    shells: WIN_PS,
  },
  {
    re: /\|\s*(?:\?|%|foreach|where|select|sort|measure|ft|fl)\b\s*[{(\w]/i,
    says: "a PowerShell pipeline alias",
    weight: 2,
    shells: WIN_PS,
  },
  // ---- POSIX
  {
    re: /^\s*export\s+\w+=/m,
    says: "export NAME=value",
    weight: 4,
    shells: POSIX_ALL,
  },
  {
    re: /;\s*(?:then|do)\b|(?:^|[;\n]\s*)(?:fi|done|esac)\b/m,
    says: "if/for/case with then, do, fi, done or esac",
    weight: 4,
    shells: POSIX_ALL,
  },
  {
    re: /(?:^|[\s;&|(])(?:\d?>>?|&>)\s*\/dev\/(?:null|stderr|stdout)\b/,
    says: "a redirect to /dev/null",
    weight: 4,
    shells: POSIX_ALL,
  },
  {
    re: /<<-?\s*(?:['"\\]?[A-Za-z_]\w*)/,
    says: "a <<EOF heredoc",
    weight: 4,
    shells: POSIX_ALL,
  },
  {
    re: /\$\{[A-Za-z_]\w*(?::?[-+=?]|%%?|##?|\/|\[)/,
    says: "a ${var:-x} parameter expansion",
    weight: 3,
    shells: POSIX_ALL,
  },
  {
    re: /\$\(\s*[A-Za-z_./]/,
    says: "a $(...) substitution",
    weight: 1,
    shells: POSIX_ALL,
  },
  {
    re: /(?:^|[^\\])`[A-Za-z_./][^`\n]*`/,
    says: "a backtick substitution",
    weight: 1,
    shells: POSIX_ALL,
  },
  {
    re: /\$[0-9@#*!](?!\w)|\$\$/,
    says: "a positional or special parameter",
    weight: 1,
    shells: POSIX_ALL,
  },
  {
    re: /\b(?:sudo|chmod|chown|apt(?:-get)?|touch|xargs|awk|dirname|basename|nohup)\b/,
    says: "a Unix utility",
    weight: 3,
    shells: POSIX_ALL,
  },
  {
    re: /\b(?:ls|rm|cp|mv|cat|mkdir|grep|sed|head|tail|ps|kill|find|sort|uniq)\s+-[a-z]{2,6}\b/,
    says: "a Unix utility with bundled flags",
    weight: 3,
    shells: POSIX_ALL,
  },
  {
    re: /(?:^|[\s"'=])(?:\/(?:usr|etc|tmp|var|home|opt|bin|dev)\/)/,
    says: "a Unix path",
    weight: 1,
    shells: POSIX_ALL,
  },
  {
    re: /^#!\s*\/\S*(?:bash|sh|zsh|env\s+(?:bash|sh|zsh))\b/,
    says: "a shebang",
    weight: 5,
    shells: POSIX_ALL,
  },
  {
    re: /^\s*(?:source|\.)\s+[\w./~-]+/m,
    says: "source file",
    weight: 1,
    shells: POSIX_ALL,
  },
  {
    re: /\[\s+-[a-z]\s+[^\]]*\s\]/,
    says: "a [ -f x ] test",
    weight: 2,
    shells: POSIX_ALL,
  },
  // ---- bash and zsh, not sh
  {
    re: /\[\[\s[^\]]*\s\]\]/,
    says: "a [[ ]] test",
    weight: 3,
    shells: BASH_ZSH,
  },
  { re: /<<<\s*\S/, says: "a <<< here-string", weight: 3, shells: BASH_ZSH },
  {
    re: /\w=\([^)]*\)|\$\{\w+\[[@*]\]\}|\bdeclare\s+-[aA]\b/,
    says: "an array",
    weight: 3,
    shells: BASH_ZSH,
  },
  {
    // A word that starts with or contains {a,b} or {1..3}; not `=>{a,b}` or `({a,b})`
    re: /(?:^|[\s=])[^\s{}()>;]*\{(?:[^{}\s,$]+,[^{}\s]+|\d+\.\.\d+)\}/,
    says: "a {a,b} brace expansion",
    weight: 2,
    shells: BASH_ZSH,
    unquoted: true,
  },
  {
    re: /<\(|[^$(]>\(/,
    says: "a process substitution",
    weight: 2,
    shells: BASH_ZSH,
  },
  // ---- zsh only
  {
    re: /^\s*(?:setopt|unsetopt|autoload|zmodload|compdef|bindkey|emulate)\b/m,
    says: "a zsh builtin",
    weight: 6,
    shells: ["zsh"],
  },
  {
    re: /\$\{\([A-Za-z@:]+\)/,
    says: "a ${(flags)...} expansion",
    weight: 6,
    shells: ["zsh"],
  },
  {
    re: /\*\*\/\*\([.\/@^][^)]*\)|\*\([.\/@^e][^)]*\)/,
    says: "a glob qualifier",
    weight: 5,
    shells: ["zsh"],
  },
  {
    re: /(?:^|[\s;&|(])=[A-Za-z][\w-]*(?=$|[\s;&|)])/,
    says: "=command expansion",
    weight: 3,
    shells: ["zsh"],
  },
  // ---- cmd
  {
    re: /%(?:[A-Za-z_]\w*|~[dpnxf0-9]+\w*)%|%~\w+/,
    says: "a %VAR% expansion",
    weight: 4,
    shells: ["cmd"],
  },
  {
    re: /\bif\s+(?:not\s+)?(?:exist|errorlevel|defined)\b/i,
    says: "if exist / errorlevel",
    weight: 4,
    shells: ["cmd"],
  },
  {
    re: /\b(?:dir|copy|xcopy|del|rd|md|type|move|findstr|robocopy|attrib|tasklist|taskkill|where|mkdir|rmdir)\s+(?:\S+\s+)?\/[A-Za-z?]\b/i,
    says: "a /switch",
    weight: 3,
    shells: ["cmd"],
  },
  {
    re: /^\s*(?:set\s+"?\w+=|@echo\s+off|rem\s|goto\s|call\s+\S|for\s+%%?\w)/im,
    says: "a cmd statement (set X=, @echo off, goto, for %%)",
    weight: 4,
    shells: ["cmd"],
  },
  {
    re: /[>\s]2?>\s*nul\b/i,
    says: "a redirect to nul",
    weight: 3,
    shells: ["cmd"],
  },
  // ---- Windows paths, for the two Windows shells
  {
    re: /\b[A-Za-z]:\\[\w$.-]/,
    says: "a Windows path",
    weight: 1,
    shells: ["powershell", "cmd"],
  },
];

/** `[ a -eq b ]` is bash's: take tests out before looking for PowerShell's operators. */
const PS_OPERATOR =
  /\s-(?:eq|ne|gt|lt|ge|le|like|notlike|match|notmatch|contains|notin|in|and|or|not|is|isnot|replace|split|join|f)\s/i;

export function detectCommandShell(command: string): ShellDetection {
  const text = typeof command === "string" ? command : "";
  const score: Targets = {};
  const evidence: string[] = [];
  const add = (shells: Shell[], weight: number, says: string) => {
    for (const s of shells) score[s] = (score[s] ?? 0) + weight;
    evidence.push(`${says} (${shells.join("/")})`);
  };
  const outside = maskQuoted(text);
  for (const sig of SIGNALS) {
    if (sig.re.test(sig.unquoted ? outside : text)) {
      add(sig.shells, sig.weight, sig.says);
    }
  }
  const withoutTests = text.replace(/\[\[?\s[^\]]*\]\]?/g, " ");
  if (PS_OPERATOR.test(withoutTests)) {
    add(WIN_PS, 2, "a comparison operator such as -eq");
  }
  // `&&` and `||` are in bash, zsh, sh, cmd and PowerShell 7
  if (/&&|\|\|/.test(text)) add([...POSIX_ALL, "cmd"], 1, "&& or ||");
  if (/\s&\s+\S/.test(text) && !/&&/.test(text)) {
    add(["cmd"], 1, "a single & between commands");
  }
  // 2>&1 is common to every shell and says nothing
  const entries = Object.entries(score) as [Shell, number][];
  if (entries.length === 0) return { likely: [], evidence, confidence: "low" };

  // Plain POSIX evidence says sh as readily as bash: keep it, but behind
  // what only bash or zsh can write
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0][1];
  const likely = entries
    .filter(([, v]) => v >= 2 && v >= top - 1)
    .map(([k]) => k);
  if (likely.length === 0) return { likely: [], evidence, confidence: "low" };

  const best = new Map<ShellFamily, number>();
  for (const [k, v] of entries) {
    const f = familyOf(k);
    if (f) best.set(f, Math.max(best.get(f) ?? 0, v));
  }
  const ranked = [...best.values()].sort((a, b) => b - a);
  const gap = ranked[0] - (ranked[1] ?? 0);
  const confidence =
    ranked[0] >= 4 && gap >= 3
      ? "high"
      : ranked[0] >= 3 && gap >= 2
        ? "medium"
        : "low";
  return { likely, evidence, confidence };
}

/**
 * True when the text reads as another dialect than `shell`'s, with enough
 * evidence to say so: none of its likely shells is in the shell's family.
 */
export function mismatchedShell(
  detection: ShellDetection,
  shell: ShellKind,
): boolean {
  const family = familyOf(shell);
  if (!family || detection.likely.length === 0) return false;
  if (detection.confidence === "low") return false;
  return detection.likely.every((l) => familyOf(l) !== family);
}
