/**
 * Theme files are JSON with comments and trailing commas, which VS Code itself
 * accepts. `JSON.parse` does not, so strip both before parsing.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') {
        i += text[i] === "\\" ? 2 : 1;
      }
      i++;
      out += text.slice(start, i);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") {
        i++;
      }
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      // Keep the line count, so a parse error still names the right line.
      const comment = text.slice(i, end === -1 ? n : end + 2);
      out += comment.replace(/[^\n]/g, "");
      i += comment.length;
    } else if (ch === ",") {
      // A comma followed only by whitespace and a closing bracket is trailing.
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) {
        j++;
      }
      // Comments between the comma and the bracket are already gone only if we
      // look past them here too.
      while (text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
        if (text[j + 1] === "/") {
          while (j < n && text[j] !== "\n") {
            j++;
          }
        } else {
          const end = text.indexOf("*/", j + 2);
          j = end === -1 ? n : end + 2;
        }
        while (j < n && /\s/.test(text[j])) {
          j++;
        }
      }
      if (text[j] !== "}" && text[j] !== "]") {
        out += ch;
      }
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function parseThemeJson(themeString: string | undefined): any {
  if (themeString === undefined) {
    return {};
  }
  // A byte-order mark is legal at the start of a theme file.
  const text =
    themeString.charCodeAt(0) === 0xfeff ? themeString.slice(1) : themeString;
  return JSON.parse(stripJsonComments(text));
}
