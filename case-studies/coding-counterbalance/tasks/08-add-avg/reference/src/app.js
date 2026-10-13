export function sum(nums) {
  let s = 0;
  for (const n of nums) s += n;
  return s;
}

export function average(nums) {
  return nums.length === 0 ? 0 : sum(nums) / nums.length;
}
