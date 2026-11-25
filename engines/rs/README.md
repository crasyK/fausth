# Fausth engine in Rust (spec v0.6)

The third engine for [spec v0.6](../../docs/spec-v0.6.md), next to `engines/py` and `engines/ts`. It runs only
`harness/0.6` files and reproduces every conformance fixture byte for byte: the log and the rendered requests. It is
here so that Mouseion can give a Rust harness (Codex) a runner in its own language.

## Build, test, replay

```bash
cargo build --release            # library `fausth` and the binary `fausth`
cargo test                       # the conformance suite and the engine's own tests
cargo run -- replay ../../conformance/fixtures/*/            # compare with the expected files
cargo run -- replay <fixture dir>... --write                 # rewrite them
examples/differential/run.sh     # differential checks against the TS engine and Python, beyond the suite
```

`target/` stays in this folder (`.gitignore`d). The harness schema is read at build time from
`../../schema/harness.v0.6.json` (`include_str!`), so the crate builds inside this repository; no copy can drift.

## Conformance

`cargo test` runs `tests/conformance.rs` over `conformance/`, plus `tests/engine.rs` and `tests/launch.rs` (the
ports of `engine.test.ts`, `schema.test.ts` and `launch.test.ts`). All pass:

| Category | Cases |
|---|---|
| `values.json`: canonical form and hash | 71 |
| `values.json`: excerpt | 7 |
| `values.json`: argument text `model_order` (compact and indented) | 8 |
| `values.json`: `sorted_ascii` (compact and indented), plus 7 texts that must fail | 9 + 7 |
| `harnesses/valid` (canonical form equals `*.expected`) | 16 |
| `harnesses/invalid` (each rejected; reasons checked by hand to be the intended ones) | 121 |
| `log.json`: log text, views, call ids | 1 text, 3 views, 3 ids |
| `openai.json`: request, answers, `reasoning_replay` cases, default, invalid values | 20 |
| `fixtures/*` replayed: `expected.log.jsonl` and `expected.requests.jsonl` byte for byte | 61 of 61 |
| launch pair `v06-stop-context` + `v06-stop-title-run`, binding live, both fixtures' expected files | 1 (+ 6 launch tests) |

The differential checks (`examples/differential/run.sh`, needs `node` with `engines/ts` installed and `python3`)
compare with the other engines on inputs the suite doesn't have: 300,000 doubles (ECMAScript and Python `repr`
forms: 0 differ), every harness file in the repository read and checked (400 files, YAML and JSON: 0 differ; also
run on harness-lab's and Mouseion's 226 files: 0 differ), 50 schemas × 50 values (2 differ, see below), 65
patterns × 40 strings (4 differ, see below).

## Layout

| File | Spec | What |
|---|---|---|
| `src/value.rs` | §1, §9.4 | `Value` (doubles; objects in member order), JSON reader, canonical form, hash, excerpt, `model_order` and `sorted_ascii` argument texts, ECMAScript and Python number forms |
| `src/yaml.rs` | §2 | harness text → JSON value: YAML 1.2 core schema on `saphyr-parser`'s events |
| `src/schema.rs` | §3.2, §8.1 | schema compilation, the harness structure check, ECMA-262 pattern fixes, why arguments fail |
| `src/harness.rs` | §2, §3, §5.1, §6, §8.2 | `Harness`, `harness_errors`, `harness_hash`, hooks, texts and `fill` |
| `src/log.rs` | §7, §5.3 | `Log`, `Scope`, the view |
| `src/render.rs` | §9 | `Request`, `Message`, `render`, wrappers |
| `src/engine.rs` | §8, §5, §6, §10–§12 | `Host`, `run`, hooks, built-ins, `core_spawn`, interrupts, reload |
| `src/replay.rs` | §14 | the replay host, `replay_dir` |
| `src/launch.rs` | §13.1 | `harness_binding`: a binding that launches another run |
| `src/openai.rs` | §9, §13 | Chat Completions mapping (`to_chat`, `from_chat`) |
| `src/main.rs` | | the `fausth replay` command |

About 3,600 lines of code in `src/` (4,200 with comments), 800 in tests and the differential example.

## Dependencies

| Crate | Why |
|---|---|
| `jsonschema` (default features off) | JSON Schema 2020-12: validation, the bundled meta-schemas (the harness schema checks tool schemas against them), `$ref`/`$anchor`/`$dynamicRef`, and translation of ECMA-262 patterns to Rust's regex engines. Default features off: no HTTP or file retrieval, so a remote `$ref` doesn't resolve (as in the other engines). |
| `serde_json` | only as `jsonschema`'s value type; the engine reads and writes JSON itself (`value.rs`), because it needs doubles for every number, member order and exact control of the output |
| `saphyr-parser` | a YAML 1.2 event parser; `yaml.rs` builds the value with the core schema's resolution and the checks the parser leaves to its caller (version, one document, string keys, duplicate keys, tags, recursive aliases, finite numbers) |
| `sha2` | SHA-256 for `hash` (§1) |

75 crates in all, most of them `jsonschema`'s.

## The API a Rust host calls

```rust
use fausth::{run, Harness, Host, HostError, Request, Value};

struct MyHost { /* model transport, tool implementations, the conversation */ }

impl Host for MyHost {
    fn user(&mut self) -> Result<Option<String>, HostError> { /* next user message, None when over */ }
    fn model(&mut self, request: &Request) -> Result<Value, HostError> { /* a §14 response */ }
    fn call(&mut self, id: &str, input: &Value) -> Result<Value, HostError> { /* {ok, result} / {ok, error} */ }
    // optional: interrupts(step), harness(step) for a reload, reasons(tool, args) for a host's own validator
}

let harness = Harness::read(&std::fs::read_to_string("harness.yaml")?)?;   // read and checked (§2)
let log = run(&harness, &mut MyHost { /* … */ });                          // the run loop (§8)
std::fs::write("run.log.jsonl", log.text())?;                              // the log (§7)
```

- `Request::to_value()` is the neutral request (§9); `fausth::openai::{to_chat, from_chat}` map it to and from Chat
  Completions, with `ReasoningReplay::{None, Turn, All}`. The HTTP call is the host's (no HTTP client here).
  Codex talks to the Responses API, so a Codex runner needs a Responses adapter of its own, written the same way:
  texts unchanged, call ids kept, a call's argument text from `ToolCall::text()`.
- `HostError::Infra` is an infrastructure failure, `HostError::End` the host ending the run (`host_end`).
- `fausth::launch::harness_binding(host, task, LaunchOptions)` gives a binding (`.call(input)`) that launches the
  harness it is handed as a run of its own (§13.1), like `harnessBinding` in `launch.ts`.
- `fausth::replay::{replay_dir, replay_files, ReplayHost}` replay a fixture (§14).
- `Host` is synchronous. An async runner (Codex uses tokio) runs `run` on a blocking thread
  (`tokio::task::spawn_blocking`) and blocks on its async calls inside the `Host` methods (`Handle::block_on`).

## Where this engine differs, and spec points found

Byte-identical on the whole suite. Outside it:

1. **Lone surrogates.** A Rust string can't hold one, so JSON text with a lone surrogate escape is rejected when it
   is read, not when it is canonicalized. The outcome is the same as in the other engines (no canonical form, §1):
   an invalid harness, an infrastructure failure for a model response (`from_chat` and the replay host fail with
   `HostError::Infra`, which logs exactly what the other engines log).
2. **YAML surrogate pairs.** `saphyr-parser` rejects each `\uD83D`-style escape alone; `yaml.rs` rewrites the pairs
   of the scalar the parser stopped at as one `\U` escape and parses again, so `"😀"` reads as 😀 and a
   lone one is still an error. The `%YAML` version is checked by `yaml.rs` (the parser ignores it).
3. **Patterns.** `jsonschema` translates ECMA-262 for Rust's regex engines (`.`, `\d`, `\w`, `\s`; `$` is the end of
   input). `schema.rs` also writes `\b`/`\B` as ASCII lookarounds (the translation keeps Rust's Unicode-aware ones)
   and rewrites `[\b]`, `\0`, `[]` and `[^]`, which `jsonschema`'s check rejects although they are ECMA-262. Four
   patterns of the differential set that ECMA-262 rejects are accepted here: `\-`, `\z`, `\A`, `(?i)`. The other two
   engines disagree on such patterns as well (Python accepts `\-` and `\A`, rejects `[]` and `[^]`, which TypeScript
   accepts).
4. **`multipleOf`.** `jsonschema` divides exactly (0.3 would be a multiple of 0.1); `schema.rs` replaces the keyword
   with what Ajv and Python's `jsonschema` do: the quotient of the two doubles is an integer. For quotients of 10²¹
   and more the two existing engines disagree (Ajv's `q === parseInt(q)` fails there; Python uses `x % d` for an
   integer divisor); this engine says an integral quotient passes. Spec point: §3.2's "standard semantics" doesn't
   settle `multipleOf` on doubles.
5. **Number formatting.** Rust's shortest formatting rounds a tie between two shortest digit strings up
   (`1424953923781206.25` → `…206.3`); ECMAScript and Python take the even one (`…206.2`), and `value.rs` does too.
   Not a spec bug, but a pitfall for any engine built on a language's float printer.
6. **Messages.** Why a harness is invalid is worded by `jsonschema`, not Ajv; the texts aren't part of conformance.
   Compiling a schema also checks it against the 2020-12 meta-schema (the harness check requires that anyway).
7. **Not ported:** the TS/Python `ChatModel` HTTP transport with retries (host side; no HTTP dependency here), the
   chess tools and hosts.
