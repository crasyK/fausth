//! The shared conformance suite (`conformance/`, spec §14): values, harnesses, the log, the Chat Completions
//! mapping, and every fixture replayed to both expected files byte for byte.

use fausth::harness::{fill, fill_host_values, harness_hash, read_harness, Harness};
use fausth::log::{call_id, view, Log, Scope};
use fausth::openai::{from_chat, to_chat, ReasoningReplay};
use fausth::render::Request;
use fausth::replay::replay_dir;
use fausth::value::{argument_text, canon, canonical, excerpt, hash, parse_json, sorted_ascii_text, Map, Value};
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn vectors(name: &str) -> Value {
    parse_json(&std::fs::read_to_string(root().join(name)).unwrap()).unwrap()
}

fn list<'a>(v: &'a Value, k: &str) -> &'a Vec<Value> {
    v.get(k).and_then(Value::as_array).unwrap()
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get_str(k).unwrap()
}

/// Collects failures so one test reports every case that differs.
#[derive(Default)]
struct Failures(Vec<String>);

impl Failures {
    fn check(&mut self, ok: bool, what: impl FnOnce() -> String) {
        if !ok {
            self.0.push(what());
        }
    }

    fn done(self, total: usize) {
        assert!(self.0.is_empty(), "{} of {total} failed:\n{}", self.0.len(), self.0.join("\n"));
        eprintln!("{total} passed");
    }
}

#[test]
fn values_canonical_and_hash() {
    let v = vectors("values.json");
    let mut f = Failures::default();
    let cases = list(&v, "canonical");
    for c in cases {
        let name = str_of(c, "name");
        let parsed = parse_json(str_of(c, "json"));
        if c.get("error") == Some(&Value::Bool(true)) {
            let fails = parsed.map_or(true, |x| canonical(&x).is_err());
            f.check(fails, || format!("canonical {name}: expected an error"));
            continue;
        }
        let x = match parsed {
            Ok(x) => x,
            Err(e) => {
                f.check(false, || format!("canonical {name}: {e}"));
                continue;
            }
        };
        let got = canonical(&x).unwrap();
        f.check(got == str_of(c, "canonical"), || format!("canonical {name}: {got}"));
        if let Some(h) = c.get_str("hash") {
            f.check(hash(&x).unwrap() == h, || format!("hash {name}"));
        }
    }
    f.done(cases.len());
}

#[test]
fn values_excerpt() {
    let v = vectors("values.json");
    let mut f = Failures::default();
    let cases = list(&v, "excerpt");
    for c in cases {
        let n = c.get("n").and_then(Value::as_f64).unwrap() as usize;
        let got = excerpt(str_of(c, "s"), n);
        f.check(got == str_of(c, "out"), || format!("excerpt {:?} {n}: {got:?}", str_of(c, "s")));
    }
    f.done(cases.len());
}

#[test]
fn values_argument_text() {
    let v = vectors("values.json");
    let mut f = Failures::default();
    let cases = list(&v, "argument_text");
    for c in cases {
        let name = str_of(c, "name");
        let x = parse_json(str_of(c, "json")).unwrap();
        let text = argument_text(&x, false).unwrap();
        let indented = argument_text(&x, true).unwrap();
        f.check(text == str_of(c, "text"), || format!("argument_text {name}: {text}"));
        f.check(indented == str_of(c, "indented"), || format!("argument_text indented {name}: {indented}"));
    }
    f.done(cases.len());
}

#[test]
fn values_sorted_ascii() {
    let v = vectors("values.json");
    let mut f = Failures::default();
    let cases = list(&v, "sorted_ascii");
    for c in cases {
        let name = str_of(c, "name");
        let raw = str_of(c, "raw");
        let text = sorted_ascii_text(raw, false).unwrap();
        let indented = sorted_ascii_text(raw, true).unwrap();
        f.check(text == str_of(c, "text"), || format!("sorted_ascii {name}: {text}"));
        f.check(indented == str_of(c, "indented"), || format!("sorted_ascii indented {name}: {indented}"));
    }
    for raw in ["NaN", "[Infinity]", "1e400", "\"\\ud800\"", "{", "", "[1,]"] {
        f.check(sorted_ascii_text(raw, false).is_err(), || format!("sorted_ascii accepts {raw:?}"));
    }
    f.done(cases.len() + 7);
}

fn harness_files(sub: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(root().join("harnesses").join(sub))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) != Some("expected"))
        .collect();
    files.sort();
    files
}

#[test]
fn harnesses_valid() {
    let mut f = Failures::default();
    let files = harness_files("valid");
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        match Harness::read(&std::fs::read_to_string(path).unwrap()) {
            Ok(h) => {
                let expected = std::fs::read_to_string(format!("{}.expected", path.display())).unwrap();
                let got = canon(h.value());
                f.check(got == expected.trim_end(), || {
                    format!("valid {name}:\n  got      {got}\n  expected {}", expected.trim_end())
                });
            }
            Err(e) => f.check(false, || format!("valid {name}: rejected: {e}")),
        }
    }
    f.done(files.len());
}

#[test]
fn harnesses_invalid() {
    let mut f = Failures::default();
    let files = harness_files("invalid");
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let text = std::fs::read_to_string(path).unwrap();
        f.check(Harness::read(&text).is_err(), || format!("invalid {name}: accepted"));
    }
    f.done(files.len());
}

/// 0.7 (§2.1): host values, filled at load (`host-values.json`).
#[test]
fn host_values() {
    let v = vectors("host-values.json");
    let cases = list(&v, "cases");
    let mut f = Failures::default();
    for c in cases {
        let values = c.get("values").and_then(Value::as_object).unwrap();
        let got = fill_host_values(c.get("harness").unwrap(), values);
        match (got, c.get("error") == Some(&Value::Bool(true))) {
            (Ok(h), false) => f.check(canon(&h) == canon(c.get("filled").unwrap()), || {
                format!("{}: {}", str_of(c, "name"), canon(&h))
            }),
            (Err(_), true) => {}
            (Ok(_), true) => f.check(false, || format!("{}: should fail", str_of(c, "name"))),
            (Err(e), false) => f.check(false, || format!("{}: {e}", str_of(c, "name"))),
        }
    }
    f.done(cases.len());
}

/// 0.6 (§2, §8.2, §9): the tool order, the hash that sees it, and the texts' placeholders.
#[test]
fn harness_tool_order_hash_and_fill() {
    let ordered = |spec: &str| {
        read_harness(&format!(
            "spec: {spec}\nname: n\nprompt: p\ntools:\n  zeta: {{ description: z, input: {{ type: object }} }}\n  \"10\": {{ description: ten, input: {{ type: object }} }}\n  Alpha: {{ description: a, input: {{ type: object }} }}\n  \"2\": {{ description: two, input: {{ type: object }} }}\n  \"007\": {{ description: seven, input: {{ type: object }} }}\n"
        ))
        .unwrap()
    };
    let h = Harness::new(ordered("harness/0.7"));
    assert_eq!(h.tool_ids(), ["2", "10", "zeta", "Alpha", "007"]);
    assert!(fausth::harness_errors(h.value()).is_empty());
    assert!(!fausth::harness_errors(&ordered("harness/0.6")).is_empty());
    let ids = Value::Array(["2", "10", "zeta", "Alpha", "007"].map(Value::from).to_vec());
    assert_eq!(h.hash(), hash(&Value::Array(vec![h.value().clone(), ids])).unwrap());

    let tools = h.tools().unwrap();
    let with = |order: [&str; 2]| {
        let mut t = Map::new();
        for id in order {
            t.insert(id, tools.get(id).unwrap().clone());
        }
        let mut v = h.value().as_object().unwrap().clone();
        v.insert("tools", Value::Object(t));
        Value::Object(v)
    };
    let (swapped, same) = (with(["Alpha", "zeta"]), with(["zeta", "Alpha"]));
    assert_eq!(canon(&swapped), canon(&same));
    assert_ne!(harness_hash(&swapped), harness_hash(&same));

    assert_eq!(
        fill(r#"{tool}: {x} {"a": 1} {y z} {tool}"#, &[("tool", "{x}"), ("x", "y")]),
        r#"{x}: y {"a": 1} {y z} {x}"#
    );
}

#[test]
fn log_text_views_and_call_ids() {
    let v = vectors("log.json");
    let mut log = Log::new();
    for a in list(&v, "appends") {
        let scope = Scope::from_value(a.get("scope").unwrap());
        log.append(&scope, str_of(a, "type"), a.get("members").unwrap().as_object().unwrap().clone());
    }
    assert_eq!(log.text(), str_of(&v, "text"));
    for (i, w) in list(&v, "views").iter().enumerate() {
        let got = Value::Array(view(&log.entries, &Scope::from_value(w.get("scope").unwrap())));
        assert_eq!(canon(&got), canon(w.get("view").unwrap()), "view {i}");
    }
    for c in list(&v, "call_ids") {
        let c = c.as_array().unwrap();
        let n = |i: usize| c[i].as_f64().unwrap() as usize;
        assert_eq!(call_id(n(0), n(1)), c[2].as_str().unwrap());
    }
    let types: Vec<&str> = list(&v, "appends").iter().map(|a| str_of(a, "type")).collect();
    for t in
        ["run_start", "system", "user", "assistant", "hook", "tool_result", "interrupt", "harness_changed", "run_end"]
    {
        assert!(types.contains(&t), "{t}");
    }
}

#[test]
fn openai_mapping() {
    let v = vectors("openai.json");
    let mut f = Failures::default();
    let mut total = 0;
    let request = Request::from_value(v.get("request").unwrap()).unwrap();
    let mut extra = Map::new();
    extra.insert("temperature", Value::Number(0.0));
    total += 1;
    let got = to_chat(&request, "m", &extra, ReasoningReplay::default());
    f.check(canon(&got) == canon(v.get("chat").unwrap()), || format!("request: {}", canon(&got)));
    for c in list(&v, "answers") {
        total += 1;
        let name = str_of(c, "name");
        let got = from_chat(c.get("answer").unwrap(), "kit");
        if c.get("error") == Some(&Value::Bool(true)) {
            f.check(got.is_err(), || format!("answer {name}: expected an infrastructure failure"));
        } else {
            let got = got.map(|g| canon(&g));
            let want = canon(c.get("response").unwrap());
            f.check(got.as_ref() == Ok(&want), || format!("answer {name}: {got:?}\n  expected {want}"));
        }
    }
    let replay = v.get("replay").unwrap();
    let request = Request::from_value(replay.get("request").unwrap()).unwrap();
    for c in list(replay, "cases") {
        total += 1;
        let mode = ReasoningReplay::parse(str_of(c, "reasoning_replay")).unwrap();
        let got = to_chat(&request, "m", &Map::new(), mode);
        f.check(canon(&got) == canon(c.get("chat").unwrap()), || format!("replay {mode:?}: {}", canon(&got)));
        if str_of(c, "reasoning_replay") == str_of(replay, "default") {
            total += 1;
            let default = to_chat(&request, "m", &Map::new(), ReasoningReplay::default());
            f.check(canon(&default) == canon(c.get("chat").unwrap()), || "the default reasoning_replay".into());
        }
    }
    for bad in list(replay, "invalid") {
        total += 1;
        let bad = bad.as_str().unwrap();
        f.check(ReasoningReplay::parse(bad).is_err(), || format!("reasoning_replay {bad:?} accepted"));
    }
    f.done(total);
}

#[test]
fn fixtures() {
    let mut dirs: Vec<PathBuf> =
        std::fs::read_dir(root().join("fixtures")).unwrap().map(|e| e.unwrap().path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    let mut f = Failures::default();
    for dir in &dirs {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        match replay_dir(dir) {
            Err(e) => f.check(false, || format!("{name}: {e}")),
            Ok(out) => {
                for (file, got) in [("expected.log.jsonl", &out.log), ("expected.requests.jsonl", &out.requests)] {
                    let want = std::fs::read_to_string(dir.join(file)).unwrap();
                    f.check(*got == want, || format!("{name}/{file}: {}", first_difference(got, &want)));
                }
            }
        }
    }
    f.done(dirs.len());
}

/// The first line that differs, for the report.
fn first_difference(got: &str, want: &str) -> String {
    for (i, (g, w)) in got.lines().zip(want.lines()).enumerate() {
        if g != w {
            return format!("line {}:\n    got      {g}\n    expected {w}", i + 1);
        }
    }
    format!("{} lines, expected {}", got.lines().count(), want.lines().count())
}
