export function sumTo(n) {
  let s = 0;
  for (let i = 1; i < n; i++) s += i; // bug: misses n
  return s;
}
