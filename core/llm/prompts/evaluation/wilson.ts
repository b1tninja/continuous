/**
 * The Wilson score interval for a rate of `successes` in `n` trials, as
 * [low, high] in 0..1. Used instead of the normal approximation because the
 * runs here are small and the rates often sit at 0 or 1, where that
 * approximation gives an interval of no width. `z` is 1.96 for 95%.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): [number, number] {
  // No trials say nothing about the rate
  if (n <= 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
