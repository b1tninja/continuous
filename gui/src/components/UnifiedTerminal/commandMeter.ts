/** The numbers run_terminal_command sends with a command's output (core ContextItem.commandOutput). */
export interface CommandOutputStats {
  bytes: number;
  lines: number;
  bytesPerSecond: number;
  runaway?: string;
  outputUri?: string;
}

function size(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}

function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  return n.toLocaleString("en-US");
}

/** Below this the meter adds nothing the output does not already show. */
export const METER_MIN_BYTES = 64 * 1024;

/**
 * The meter beside a command's output: "38.2 MB · 912k lines · 3.4 MB/s", the
 * rate only while it runs. Undefined for small output.
 */
export function commandMeterText(
  stats: CommandOutputStats | undefined,
  running: boolean,
): string | undefined {
  if (!stats || stats.bytes < METER_MIN_BYTES) return undefined;
  const parts = [size(stats.bytes), `${count(stats.lines)} lines`];
  if (running && stats.bytesPerSecond > 0) {
    parts.push(`${size(stats.bytesPerSecond)}/s`);
  }
  return parts.join(" · ");
}
