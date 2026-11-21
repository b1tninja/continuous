/**
 * Micromark treats `$$\n…\n$$` as display (flow) math and `$$…$$` on one line as
 * inline. Models usually emit display equations on a single line; this reshapes
 * them into flow math so KaTeX renders them as `.katex-display`.
 */
export function normalizeDisplayMathBlocks(text: string): string {
  return text.replace(/^(\s*)\$\$([^\n$]+?)\$\$\s*$/gm, (_, indent, body) => {
    const trimmed = body.trim();
    if (!trimmed) return `${indent}$$`;
    return `${indent}$$\n${trimmed}\n${indent}$$`;
  });
}