//! The run loop's 0.6 parts that a replay fixture can't show: a host's own reasons (§8.1), `raw` (§14); and §8.1's
//! reasons for the cases the conformance fixture leaves out.

mod common;

use common::{json, obj, Scripted};
use fausth::log::kind;
use fausth::schema::argument_reasons;
use fausth::value::Value;
use fausth::{run, Harness, Log};

fn harness() -> Harness {
    Harness::new(json(
        r#"{"spec": "harness/0.7", "name": "n", "prompt": "p",
            "tools": {"edit": {"description": "Edit.", "input": {"type": "object", "required": ["path"], "properties": {"path": {"type": "string"}}}}},
            "texts": {"invalid_arguments": "Validation failed for tool \"{tool}\":\n{reasons}"}}"#,
    ))
}

fn host(call: Value) -> Scripted {
    let mut h = Scripted::new(vec![obj(&[("tool_calls", Value::Array(vec![call]))]), json(r#"{"text": "Done."}"#)])
        .users(&["Go."]);
    h.live.insert("edit".into(), Box::new(|_| Ok(json(r#"{"ok": true, "result": "x"}"#))));
    h
}

fn bad_call() -> Value {
    json(r#"{"tool": "edit", "args": {"path": 3}}"#)
}

fn error_of(log: &Log) -> String {
    log.entries.iter().find(|e| kind(e) == "tool_result").unwrap().get("error").unwrap().as_str().unwrap().to_owned()
}

fn reason(log: &Log) -> &str {
    log.entries.last().unwrap().get("reason").unwrap().as_str().unwrap()
}

#[test]
fn without_a_host_validator_the_reasons_are_the_engines() {
    let log = run(&harness(), &mut host(bad_call()));
    assert_eq!(error_of(&log), "Validation failed for tool \"edit\":\npath: must be a string");
}

#[test]
fn a_host_may_give_its_own_validators_reasons() {
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let mut h = host(bad_call());
    let record = seen.clone();
    h.reasons = Some(Box::new(move |tool, args| {
        record.borrow_mut().push((tool.to_owned(), fausth::value::canon(args)));
        Some(Value::from("  - path: expected string"))
    }));
    let log = run(&harness(), &mut h);
    assert_eq!(error_of(&log), "Validation failed for tool \"edit\":\n  - path: expected string");
    assert_eq!(*seen.borrow(), [("edit".to_owned(), r#"{"path":3}"#.to_owned())]);
}

#[test]
fn null_from_the_host_means_the_engines_reasons_anything_else_not_a_string_fails() {
    let mut h = host(bad_call());
    h.reasons = Some(Box::new(|_, _| Some(Value::Null)));
    assert_eq!(error_of(&run(&harness(), &mut h)), "Validation failed for tool \"edit\":\npath: must be a string");
    let mut h = host(bad_call());
    h.reasons = Some(Box::new(|_, _| Some(Value::Number(3.0))));
    assert_eq!(reason(&run(&harness(), &mut h)), "infra_failure");
}

#[test]
fn a_raw_text_that_is_not_the_calls_arguments_breaks_the_interface() {
    for call in [
        r#"{"tool": "edit", "malformed": "{", "raw": "{"}"#,
        r#"{"tool": "edit", "args": {"path": "a"}, "raw": {"path": "a"}}"#,
        r#"{"tool": "edit", "args": {"path": "a"}, "raw": "{\"path\": \"b\"}"}"#,
        r#"{"tool": "edit", "args": {"path": "a"}, "raw": "{\"path\": \"a\""}"#,
    ] {
        let log = run(&harness(), &mut host(json(call)));
        assert_eq!(reason(&log), "infra_failure", "{call}");
    }
}

#[test]
fn raw_may_differ_from_args_in_how_it_writes_them() {
    let call = json(
        r#"{"tool": "edit", "args": {"path": "a", "n": 18446744073709551615}, "raw": "{ \"n\": 18446744073709551615, \"path\": \"\\u0061\" }"}"#,
    );
    let mut h = harness().0;
    h.as_object_mut().unwrap().insert("argument_text", "sorted_ascii".into());
    let log = run(&Harness::new(h), &mut host(call));
    assert_eq!(reason(&log), "stop");
    let assistant = log.entries.iter().find(|e| kind(e) == "assistant").unwrap();
    let first = &assistant.get("tool_calls").unwrap().as_array().unwrap()[0];
    assert_eq!(first.get_str("args_text"), Some(r#"{"n":18446744073709551615,"path":"a"}"#));
}

#[test]
fn reasons_booleans_are_not_numbers_and_enum_compares_canonical_forms() {
    let s = json(
        r#"{"type": "object", "properties": {"n": {"type": "integer"}, "e": {"enum": [1, "a"]}, "s": {"type": "string", "minLength": 2}}}"#,
    );
    assert_eq!(argument_reasons(&s, &json(r#"{"n": true}"#)), "n: must be an integer");
    assert_eq!(argument_reasons(&s, &json(r#"{"e": true}"#)), "e: must be one of 1, \"a\"");
    assert_eq!(argument_reasons(&s, &json(r#"{"e": 1.0, "n": 2.0}"#)), "does not match the input schema");
    assert_eq!(argument_reasons(&s, &json(r#"{"s": "🙂"}"#)), "s: at least 2 characters (it has 1)");
    assert_eq!(argument_reasons(&Value::Bool(true), &json("{}")), "does not match the input schema");
}

#[test]
fn reasons_patterns_are_ecma_262() {
    let s = json(
        r#"{"type": "object", "properties": {"id": {"type": "string", "pattern": "^[a-z]+$"}, "d": {"pattern": "^\\d$"}, "dot": {"pattern": "^.$"}}}"#,
    );
    // `$` is the end of input, `\d` is ASCII, `.` excludes line terminators (§3.2).
    assert_eq!(argument_reasons(&s, &json(r#"{"id": "ab\n"}"#)), "id: must match the pattern ^[a-z]+$");
    assert_eq!(argument_reasons(&s, &json(r#"{"d": "٣"}"#)), "d: must match the pattern ^\\d$");
    assert_eq!(argument_reasons(&s, &json(r#"{"dot": "\u2028"}"#)), "dot: must match the pattern ^.$");
    assert_eq!(argument_reasons(&s, &json(r#"{"id": "ab", "d": "3", "dot": "é"}"#)), "does not match the input schema");
    // `\b` is an ASCII word boundary; in a class it is a backspace.
    let b = json(
        r#"{"properties": {"w": {"pattern": "^a\\b"}, "nw": {"pattern": "^a\\B"}, "bs": {"pattern": "^[\\b]$"}}}"#,
    );
    assert_eq!(
        argument_reasons(&b, &json(r#"{"w": "aé", "nw": "ab", "bs": "\b"}"#)),
        "does not match the input schema"
    );
    assert_eq!(argument_reasons(&b, &json(r#"{"w": "ab"}"#)), "w: must match the pattern ^a\\b");
    assert_eq!(argument_reasons(&b, &json(r#"{"nw": "aé"}"#)), "nw: must match the pattern ^a\\B");
    assert_eq!(argument_reasons(&b, &json(r#"{"bs": "b"}"#)), "bs: must match the pattern ^[\\b]$");
}

#[test]
fn arguments_with_a_lone_surrogate_break_the_interface() {
    let answer = json(
        r#"{"choices": [{"message": {"content": "", "tool_calls": [{"id": "a", "function": {"name": "t", "arguments": "{\"x\": \"\\ud800\"}"}}]}}]}"#,
    );
    assert!(matches!(fausth::openai::from_chat(&answer, "kit"), Err(fausth::HostError::Infra(_))));
}

/// 0.7 (§14): `finish` and `failure` are strings when a response has them.
#[test]
fn finish_and_failure_must_be_strings() {
    for extra in [r#"{"text": "x", "finish": 1}"#, r#"{"text": "x", "failure": null}"#] {
        let mut h = Scripted::new(vec![json(extra)]).users(&["Go."]);
        assert_eq!(reason(&run(&harness(), &mut h)), "infra_failure", "{extra}");
    }
}
