/**
 * Chat markdown is parsed by react-remark's older micromark. Current
 * `micromark-extension-math` flow math (`$$\n…\n$$`) reads `parser.lazy`, which
 * that micromark does not have, so the parse throws. `useRemark` swallows the
 * error and keeps the last successful render, which drops the equation.
 *
 * Fenced ` ```math ` is parsed as a normal code block and `rehype-katex`
 * renders it in display mode, so turn `$$…$$` into that instead.
 */
export function normalizeDisplayMathBlocks(text: string): string {
  return text.replace(/\$\$([^\n$]+?)\$\$/g, (_, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return "$$";
    return `\n\n\`\`\`math\n${trimmed}\n\`\`\`\n\n`;
  });
}
