import { vscForeground } from "..";
import { LOOP_PATH } from "./LoopIcon";

interface ContinuedLogoProps {
  /** Height in pixels; the width follows (mark plus wordmark). */
  height?: number;
}

/**
 * The Continuous mark (brand-src/mark.svg: an endless loop in the brand
 * gradient on a dark navy badge with a thin glowing gradient frame; the dot is only in the
 * running LoopIcon) with the "Continuous" wordmark in the editor's foreground colour.
 */
export default function ContinuedLogo({ height = 75 }: ContinuedLogoProps) {
  return (
    <svg
      height={height}
      viewBox="0 0 1700 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Continuous"
    >
      <defs>
        <linearGradient id="continuous-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1B2455" />
          <stop offset="1" stopColor="#150F3D" />
        </linearGradient>
        <linearGradient
          id="continuous-loop"
          gradientUnits="userSpaceOnUse"
          x1="100"
          y1="0"
          x2="412"
          y2="0"
        >
          <stop offset="0" stopColor="#3B82F6" />
          <stop offset="0.5" stopColor="#818CF8" />
          <stop offset="1" stopColor="#A78BFA" />
        </linearGradient>
        <linearGradient
          id="continuous-edge"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="512"
          y2="512"
        >
          <stop offset="0" stopColor="#4C8DFF" />
          <stop offset="0.55" stopColor="#8B7CF6" />
          <stop offset="1" stopColor="#A78BFA" />
        </linearGradient>
        <filter
          id="continuous-glow"
          x="-10%"
          y="-10%"
          width="120%"
          height="120%"
        >
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>
      <rect
        x="16"
        y="16"
        width="480"
        height="480"
        rx="112"
        fill="url(#continuous-bg)"
      />
      <rect
        x="28"
        y="28"
        width="456"
        height="456"
        rx="96"
        fill="none"
        stroke="url(#continuous-edge)"
        strokeWidth="10"
        filter="url(#continuous-glow)"
        opacity="0.7"
      />
      <rect
        x="28"
        y="28"
        width="456"
        height="456"
        rx="96"
        fill="none"
        stroke="url(#continuous-edge)"
        strokeWidth="5"
      />
      <path
        d={LOOP_PATH}
        fill="none"
        stroke="url(#continuous-loop)"
        strokeWidth="44"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="560"
        y="330"
        fill={vscForeground}
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="210"
        fontWeight="600"
      >
        Continuous
      </text>
    </svg>
  );
}
