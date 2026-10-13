export function identity(x) {
  return x;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
