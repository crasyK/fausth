//! A binding that launches another Fausth run (§13.1): the harness it is handed, its own log and limits.
//!
//! The two conformance fixtures are the two runs of Hermes Agent's title after the turn: v06-stop-context is the main
//! run, whose `stop` hook hands the title harness over in `with.harness` (its tools.jsonl records the binding's
//! answers), and v06-stop-title-run is the launched one. Here the binding runs live, and each run must still give its
//! own fixture's expected files.

mod common;

use common::{fixtures, json, lines, obj, Scripted};
use fausth::launch::{final_text, handed_harness, harness_binding, LaunchOptions};
use fausth::log::kind;
use fausth::value::{canon, parse_json, Value};
use fausth::{run, Harness, HostError, Log};
use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

fn allow() -> Value {
    json(r#"{"ok": true, "result": {"decision": "allow"}}"#)
}

/// A host answering from a fixture's files, with the ids in `live` bound live.
fn from_fixture(dir: &Path, live: Vec<(&str, common::Binding)>) -> Scripted {
    let ids: Vec<String> = live.iter().map(|(id, _)| id.to_string()).collect();
    let mut host = Scripted::new(lines(&dir.join("model.jsonl")));
    host.tools = lines(&dir.join("tools.jsonl"))
        .into_iter()
        .filter(|t| !ids.iter().any(|id| t.get_str("id") == Some(id)))
        .collect();
    host.users = lines(&dir.join("user.jsonl")).iter().map(|u| u.get_str("text").unwrap().to_owned()).collect();
    for (id, binding) in live {
        host.live.insert(id.to_owned(), binding);
    }
    host
}

fn harness_of(dir: &Path) -> Harness {
    Harness::read(&std::fs::read_to_string(dir.join("harness.json")).unwrap()).unwrap()
}

/// The opening user message without the host's `<system-reminder>` wrappers, cut to `with.max_chars` code points.
fn title_task(input: &Value) -> Value {
    let opening = input
        .get("context")
        .and_then(Value::as_array)
        .and_then(|c| c.iter().find(|m| m.get_str("role") == Some("user")))
        .and_then(|m| m.get_str("text"))
        .unwrap_or_default();
    let mut text = opening.to_owned();
    while let Some(start) = text.find("<system-reminder>") {
        let Some(end) = text[start..].find("</system-reminder>") else { break };
        let mut stop = start + end + "</system-reminder>".len();
        while let Some(c) = text[stop..].chars().next().filter(|c| c.is_whitespace()) {
            stop += c.len_utf8();
        }
        text.replace_range(start..stop, "");
    }
    let max = input.get("with").and_then(|w| w.get("max_chars")).and_then(Value::as_f64).unwrap() as usize;
    Value::from(text.chars().take(max).collect::<String>())
}

#[test]
fn a_stop_handler_launches_the_harness_its_hook_hands_it() {
    let main_dir = fixtures().join("v06-stop-context");
    let title_dir = fixtures().join("v06-stop-title-run");
    let saved: Rc<RefCell<fausth::Map>> = Rc::default();
    let logs: Rc<RefCell<Vec<Log>>> = Rc::default();

    let saving = saved.clone();
    let title_host = from_fixture(
        &title_dir,
        vec![(
            "save_title",
            Box::new(move |input: &Value| {
                let title = parse_json(input.get_str("message").unwrap()).unwrap();
                for (k, v) in title.as_object().unwrap().iter() {
                    saving.borrow_mut().insert(k.clone(), v.clone());
                }
                Ok(allow())
            }),
        )],
    );
    let title_requests = title_host.requests.clone();
    let filed = logs.clone();
    let options = LaunchOptions {
        answer: Some(Box::new(|_| allow())),
        on_log: Some(Box::new(move |log: &Log| filed.borrow_mut().push(log.clone()))),
        ..LaunchOptions::default()
    };
    let launch = Rc::new(RefCell::new(harness_binding(title_host, title_task, options)));
    let titled = saved.clone();
    let mut main_host =
        from_fixture(
            &main_dir,
            vec![(
                "make_title",
                Box::new(move |input: &Value| {
                    if titled.borrow().contains_key("title") {
                        Ok(allow())
                    } else {
                        launch.borrow_mut().call(input)
                    }
                }),
            )],
        );
    let main = run(&harness_of(&main_dir), &mut main_host);

    // The caller's file holds the title harness (one resolved document, §2), and the binding runs that one.
    let hooks = harness_of(&main_dir).hooks();
    assert_eq!(canon(hooks[1].with.get("harness").unwrap()), canon(harness_of(&title_dir).value()));
    // The caller's log holds only the binding's answers; the launched run has its own log and requests.
    assert_eq!(main.text(), std::fs::read_to_string(main_dir.join("expected.log.jsonl")).unwrap());
    let logs = logs.borrow();
    assert_eq!(logs.len(), 1); // the second turn's stop finds the title saved and launches nothing
    assert_eq!(logs[0].text(), std::fs::read_to_string(title_dir.join("expected.log.jsonl")).unwrap());
    assert_eq!(
        Scripted::request_lines(&title_requests),
        std::fs::read_to_string(title_dir.join("expected.requests.jsonl")).unwrap()
    );
    assert_eq!(canon(&Value::Object(saved.borrow().clone())), r#"{"title":"Empty input in parser.py parse"}"#);
    // No hook of the caller runs in the launched run (§13.1): its only hook is its own.
    let launched_hooks: Vec<&str> = logs[0]
        .entries
        .iter()
        .filter(|e| kind(e) == "hook")
        .map(|e| e.get("hook").unwrap().as_str().unwrap())
        .collect();
    assert_eq!(launched_hooks, ["save"]);
}

fn summarizer() -> Value {
    json(r#"{"spec": "harness/0.7", "name": "summarizer", "prompt": "Summarize the text in one line."}"#)
}

fn orchestrator() -> Harness {
    Harness::new(json(
        r#"{"spec": "harness/0.7", "name": "orchestrator", "prompt": "Delegate.",
            "tools": {"run_agent": {"description": "Run a sub-agent harness on a task.", "input": {
              "type": "object", "required": ["harness", "task"], "additionalProperties": false,
              "properties": {"harness": {"type": "object"}, "task": {"type": "string"}}}}},
            "limits": {"max_steps": 2}}"#,
    ))
}

/// The orchestrator's model writes a sub-agent harness at runtime and hands it to `run_agent`.
fn orchestrator_host(binding: common::Binding, harness: Value) -> Scripted {
    let call =
        obj(&[("tool", "run_agent".into()), ("args", obj(&[("harness", harness), ("task", "A long text.".into())]))]);
    Scripted::new(vec![obj(&[("tool_calls", Value::Array(vec![call]))]), json(r#"{"text": "Done."}"#)])
        .users(&["Go."])
        .live("run_agent", binding)
}

fn task_argument(input: &Value) -> Value {
    input.get("task").cloned().unwrap_or(Value::Null)
}

fn result_of(log: &Log) -> String {
    let e = log.entries.iter().find(|e| kind(e) == "tool_result").unwrap();
    let mut m = fausth::Map::new();
    for k in ["ok", "result", "error"] {
        if let Some(v) = e.get(k) {
            m.insert(k, v.clone());
        }
    }
    canon(&Value::Object(m))
}

fn reason(log: &Log) -> &str {
    log.entries.last().unwrap().get("reason").unwrap().as_str().unwrap()
}

#[test]
fn a_tool_launches_the_harness_the_model_wrote() {
    let launched = Scripted::new(vec![json(r#"{"text": "Short.", "reasoning": "r"}"#)]);
    let requests = launched.requests.clone();
    let mut binding = harness_binding(launched, task_argument, LaunchOptions::default());
    let mut host = orchestrator_host(Box::new(move |i| binding.call(i)), summarizer());
    let log = run(&orchestrator(), &mut host);
    assert_eq!(result_of(&log), r#"{"ok":true,"result":"Short."}"#);
    assert_eq!(
        canon(&requests.borrow()[0].to_value()),
        r#"{"messages":[{"role":"user","text":"A long text."}],"system":"Summarize the text in one line.","tools":[]}"#
    );
    // Its steps and limits are its own: the orchestrator's max_steps 2 still allows its own two requests, and
    // nothing of the launched run is in its log.
    assert_eq!(reason(&log), "stop");
    assert_eq!(log.entries.iter().filter(|e| kind(e) == "run_start").count(), 1);
    assert!(log.entries[1..].iter().all(|e| !e.contains_key("depth")));
}

#[test]
fn a_handed_harness_that_cant_run_is_world_feedback_for_a_tool() {
    let mut not_valid = summarizer();
    not_valid.as_object_mut().unwrap().insert("spec", "harness/0.5".into());
    let mut not_bound = summarizer();
    not_bound
        .as_object_mut()
        .unwrap()
        .insert("tools", json(r#"{"shell": {"description": "Run a command.", "input": {"type": "object"}}}"#));
    for harness in [not_valid, not_bound] {
        let launched = Scripted::new(vec![]);
        let requests = launched.requests.clone();
        let options = LaunchOptions { binds: Some(Box::new(|id| id == "read")), ..LaunchOptions::default() };
        let mut binding = harness_binding(launched, task_argument, options);
        let mut host = orchestrator_host(Box::new(move |i| binding.call(i)), harness);
        let log = run(&orchestrator(), &mut host);
        assert_eq!(result_of(&log), r#"{"error":"child harness is not valid","ok":false}"#);
        assert_eq!(requests.borrow().len(), 0);
        assert_eq!(reason(&log), "stop");
    }
}

fn caller(with_harness: Value, skip: bool) -> Harness {
    let mut hook = obj(&[
        ("id", "title".into()),
        ("on", "stop".into()),
        ("run", "make_title".into()),
        ("with", obj(&[("harness", with_harness)])),
    ]);
    if skip {
        hook.as_object_mut().unwrap().insert("on_failure", "skip".into());
    }
    let mut h = json(r#"{"spec": "harness/0.7", "name": "c", "prompt": "p", "handlers": {"make_title": {}}}"#);
    h.as_object_mut().unwrap().insert("hooks", Value::Array(vec![hook]));
    Harness::new(h)
}

fn decisions(log: &Log) -> Vec<String> {
    log.entries
        .iter()
        .filter(|e| kind(e) == "hook")
        .map(|e| e.get("decision").unwrap().as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_handed_harness_that_cant_run_fails_a_handlers_hook() {
    let mut binding = harness_binding(Scripted::new(vec![]), |_| Value::from("t"), LaunchOptions::default());
    let mut host = Scripted::new(vec![json(r#"{"text": "Hi."}"#)])
        .users(&["Hello."])
        .live("make_title", Box::new(move |i| binding.call(i)));
    let log = run(&caller(json(r#"{"name": "x"}"#), false), &mut host);
    assert_eq!(decisions(&log), ["failed"]);
    assert_eq!(reason(&log), "infra_failure"); // on_failure: end (§5.4)
}

#[test]
fn a_launched_run_that_ends_without_an_answer_is_the_bindings_infrastructure_failure() {
    let replies: [fn() -> Result<Value, HostError>; 3] =
        [|| Err(HostError::Infra("down".into())), || Err(HostError::End("left".into())), || Ok(json(r#"{"text": 3}"#))];
    for reply in replies {
        let logs: Rc<RefCell<Vec<Log>>> = Rc::default();
        let filed = logs.clone();
        let options = LaunchOptions {
            on_log: Some(Box::new(move |l: &Log| filed.borrow_mut().push(l.clone()))),
            ..LaunchOptions::default()
        };
        let mut launched = Scripted::default();
        launched.replies.push_back(reply());
        let mut binding = harness_binding(launched, task_argument, options);
        let input = obj(&[("harness", summarizer()), ("task", "t".into())]);
        assert!(matches!(binding.call(&input), Err(HostError::Infra(_))));
        assert!(["infra_failure", "host_end"].contains(&reason(&logs.borrow()[0]))); // the host still gets its log

        // In the caller: a tool's binding without an answer ends the run (§3.3) ...
        let mut launched = Scripted::default();
        launched.replies.push_back(reply());
        let mut binding = harness_binding(launched, task_argument, LaunchOptions::default());
        let mut host = orchestrator_host(Box::new(move |i| binding.call(i)), summarizer());
        assert_eq!(reason(&run(&orchestrator(), &mut host)), "infra_failure");

        // ... and fails a handler's hook, which on_failure: skip lets pass.
        let mut launched = Scripted::default();
        launched.replies.push_back(reply());
        let mut binding = harness_binding(launched, |_| Value::from("t"), LaunchOptions::default());
        let mut host = Scripted::new(vec![json(r#"{"text": "Hi."}"#)])
            .users(&["Hello."])
            .live("make_title", Box::new(move |i| binding.call(i)));
        let skipped = run(&caller(summarizer(), true), &mut host);
        assert_eq!(decisions(&skipped), ["failed"]);
        assert_eq!(reason(&skipped), "stop");
    }
}

#[test]
fn a_task_that_is_not_a_string_is_an_infrastructure_failure() {
    let mut binding = harness_binding(Scripted::new(vec![]), |_| Value::Null, LaunchOptions::default());
    assert!(matches!(binding.call(&obj(&[("harness", summarizer())])), Err(HostError::Infra(_))));
}

#[test]
fn the_handed_harness_and_the_final_text() {
    assert_eq!(handed_harness(&json(r#"{"event": "stop", "with": {"harness": 1}, "harness": 2}"#)), Some(json("1")));
    assert_eq!(handed_harness(&json(r#"{"harness": 2}"#)), Some(json("2")));
    assert_eq!(handed_harness(&json(r#"{"event": "stop", "with": {}}"#)), None);
    let one = run(&Harness::new(summarizer()), &mut Scripted::new(vec![json(r#"{"text": "One."}"#)]).users(&["a"]));
    assert_eq!(final_text(&one), "One.");
    let mut failing = Scripted::default().users(&["a"]);
    failing.replies.push_back(Err(HostError::Infra("x".into())));
    assert_eq!(final_text(&run(&Harness::new(summarizer()), &mut failing)), "");
}

/// 0.7 (§2.1, §13.1): the binding fills the handed harness's host values first.
#[test]
fn a_launched_harness_gets_the_launching_hosts_values() {
    let mut handed = summarizer();
    let m = handed.as_object_mut().unwrap();
    m.insert("prompt", "Summarize in ${CWD} for ${OWNER}.".into());
    m.insert("host_values", Value::Array(vec!["OWNER".into()]));
    let values = |pairs: &[(&str, &str)]| {
        let mut v = fausth::Map::new();
        for (k, x) in pairs {
            v.insert(*k, (*x).into());
        }
        Some(v)
    };
    let input = obj(&[("harness", handed.clone()), ("task", "t".into())]);
    let launched = Scripted::new(vec![json(r#"{"text": "One."}"#)]);
    let requests = launched.requests.clone();
    let options = LaunchOptions { values: values(&[("CWD", "/app"), ("OWNER", "me")]), ..LaunchOptions::default() };
    let mut binding = harness_binding(launched, task_argument, options);
    assert_eq!(canon(&binding.call(&input).unwrap()), r#"{"ok":true,"result":"One."}"#);
    assert_eq!(requests.borrow()[0].system, "Summarize in /app for me.");
    let options = LaunchOptions { values: values(&[("CWD", "/app")]), ..LaunchOptions::default() };
    let mut unfilled = harness_binding(Scripted::default(), task_argument, options);
    assert_eq!(canon(&unfilled.call(&input).unwrap()), r#"{"error":"child harness is not valid","ok":false}"#);
}
