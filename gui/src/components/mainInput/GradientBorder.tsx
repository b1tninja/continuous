import styled, { css, keyframes } from "styled-components";

/**
 * The colours of the CLI's wordmark and the Continuous mark (brand-src/mark.svg,
 * extensions/cli/src/asciiArt.ts): the mark's indigo, its lighter and violet
 * ends, and the cyan of the dot that travels along the loop.
 */
export const LOOP_COLORS = {
  deep: "#312E81",
  indigo: "#6366F1",
  periwinkle: "#818CF8",
  violet: "#A78BFA",
  lilac: "#C4B5FD",
  cyan: "#67E8F9",
  ice: "#A5F3FC",
} as const;

const travel = keyframes`
  to {
    --loop-angle: 360deg;
  }
`;

/**
 * While the agent works the border is the loop: an indigo track with a cyan
 * dot and its tail going round, and a violet one half a turn behind it, so
 * two lights chase each other the way the dot does along the mark's figure
 * eight. Where animated custom properties are not supported it stands still
 * as the same gradient.
 */
const loopBackground = `
  conic-gradient(
    from var(--loop-angle),
    transparent 0deg 292deg,
    ${LOOP_COLORS.periwinkle} 322deg,
    ${LOOP_COLORS.cyan} 350deg,
    ${LOOP_COLORS.ice} 360deg
  ),
  conic-gradient(
    from calc(var(--loop-angle) + 180deg),
    transparent 0deg 292deg,
    ${LOOP_COLORS.indigo} 322deg,
    ${LOOP_COLORS.violet} 350deg,
    ${LOOP_COLORS.lilac} 360deg
  ),
  linear-gradient(
    135deg,
    ${LOOP_COLORS.deep},
    ${LOOP_COLORS.indigo} 50%,
    ${LOOP_COLORS.deep}
  )
`;

export const GradientBorder = styled.div<{
  borderRadius?: string;
  borderColor?: string;
  loading: 0 | 1;
}>`
  border-radius: ${(props) => props.borderRadius || "0"};
  padding: 1px;
  background: ${(props) => props.borderColor ?? loopBackground};
  ${(props) =>
    props.loading
      ? css`
          animation: ${travel} 3.2s linear infinite;
          @media (prefers-reduced-motion: reduce) {
            animation: none;
          }
          body.vscode-reduce-motion & {
            animation: none;
          }
        `
      : ""}
  /* Gradients are dropped in forced colours: a plain border says the same */
  @media (forced-colors: active) {
    background: ButtonText;
    padding: ${(props) => (props.loading ? "2px" : "1px")};
  }
  body.vscode-high-contrast &,
  body.vscode-high-contrast-light & {
    background: var(--vscode-contrastBorder, currentColor);
  }
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-top: ${(props) => (props.loading ? "8px" : "")};
`;
