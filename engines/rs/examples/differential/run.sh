#!/usr/bin/env bash
# Differential checks of the Rust engine against the TypeScript engine (and Python's float repr), beyond the
# conformance suite: number formatting, reading every harness file in the repository, JSON Schema validation and
# ECMA-262 patterns. Needs node with engines/ts installed (pnpm install) and python3. Prints the differences.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rs="$here/../.."
repo="$rs/../.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cargo build -q --release --example differential --manifest-path "$rs/Cargo.toml"
bin="$rs/target/release/examples/differential"
twin() { (cd "$repo/engines/ts" && node --import tsx "$here/twin.ts" "$@"); }

"$bin" numbers "${1:-300000}" > "$out/numbers"
python3 -I -c '
import struct, sys
bad = [l for l in open(sys.argv[1]) if repr(struct.unpack(">d", bytes.fromhex(l.split()[0]))[0]) != l.split()[2]]
print(f"numbers vs Python repr: {len(bad)} differ"); print("".join(bad[:5]), end="")' "$out/numbers"
twin numbers "$out/numbers" > "$out/numbers.ts"
echo "numbers vs ECMAScript: $(diff <(cut -d' ' -f1,2 "$out/numbers") "$out/numbers.ts" | grep -c '^>' || true) differ"

find "$repo" -path '*/node_modules' -prune -o -path '*/target' -prune -o -type f \
  \( -name '*.yaml' -o -name '*.yml' -o -name 'harness.json' -o -path '*/conformance/harnesses/*.json' \) -print \
  | sort > "$out/files"
"$bin" read "$out/files" > "$out/read.rs"
twin read "$out/files" > "$out/read.ts"
echo "harness files read: $(wc -l < "$out/files"), $(diff "$out/read.rs" "$out/read.ts" | grep -c '^>' || true) differ"
diff "$out/read.rs" "$out/read.ts" | cut -c1-300 || true

for kind in schemas patterns; do
  "$bin" "$kind" "$here/$kind.jsonl" > "$out/$kind.rs"
  twin "$kind" "$here/$kind.jsonl" > "$out/$kind.ts"
  echo "$kind: $(wc -l < "$here/$kind.jsonl") lines, $(diff "$out/$kind.rs" "$out/$kind.ts" | grep -c '^>' || true) differ"
  paste -d'\t' "$out/$kind.rs" "$out/$kind.ts" | awk -F'\t' '$1 != $2 { print "  line " NR ": rust " $1 " ts " $2 }' | cut -c1-200
done
