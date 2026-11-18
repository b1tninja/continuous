// Pure helpers for timing samples. No I/O.

/** Nearest-rank percentile: the smallest sample with at least p% of the samples at or below it. */
export function percentile(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) return NaN;
  if (!(p >= 0 && p <= 100)) {
    throw new RangeError("p must be between 0 and 100");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function median(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** n, min, median, mean, p95, max and the sample standard deviation. */
export function summarize(samples) {
  const n = samples.length;
  if (n === 0) {
    return {
      n: 0,
      min: NaN,
      median: NaN,
      mean: NaN,
      p95: NaN,
      max: NaN,
      stddev: NaN,
    };
  }
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    min: Math.min(...samples),
    median: median(samples),
    mean,
    p95: percentile(samples, 95),
    max: Math.max(...samples),
    stddev: Math.sqrt(variance),
  };
}

export function round(x, digits = 1) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
