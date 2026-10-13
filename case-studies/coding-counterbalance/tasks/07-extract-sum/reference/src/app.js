export function sum(nums) {
  let s = 0;
  for (const n of nums) s += n;
  return s;
}

export function total(nums) {
  return sum(nums);
}
