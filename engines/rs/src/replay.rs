//! The replay host (spec §14): answers a run from a fixture's recorded files.

use crate::engine::{run, Host, HostError, Request};
use crate::harness::Harness;
use crate::value::{canon, parse_json, Value};
use std::collections::VecDeque;
use std::path::Path;

/// A fixture's input files as text; the recorded ones are optional.
#[derive(Clone, Debug, Default)]
pub struct FixtureFiles {
    pub harness: String,
    pub model: Option<String>,
    pub tools: Option<String>,
    pub user: Option<String>,
    pub interrupts: Option<String>,
    pub reloads: Option<String>,
}

/// A recorded line: its value, or why it isn't JSON with a canonical form (a lone surrogate, §1), which the run meets
/// as a broken answer when it reads the line.
type Line = Result<Value, String>;

fn lines(text: Option<&str>) -> Result<VecDeque<Line>, String> {
    let mut out = VecDeque::new();
    for l in text.unwrap_or("").split('\n').filter(|l| !l.trim().is_empty()) {
        match parse_json(l) {
            Ok(v) => out.push_back(Ok(v)),
            Err(e) if e.0.contains("lone surrogate") => out.push_back(Err(e.0)),
            Err(e) => return Err(format!("a recorded line is not JSON: {e}")),
        }
    }
    Ok(out)
}

fn values(text: Option<&str>) -> Result<VecDeque<Value>, String> {
    lines(text)?.into_iter().collect::<Result<_, _>>()
}

/// The host that answers from a fixture's files, in order (§14).
pub struct ReplayHost {
    model: VecDeque<Line>,
    tools: VecDeque<Line>,
    user: VecDeque<Value>,
    pending: Vec<Value>,
    reloads: VecDeque<Value>,
    /// Every rendered request, one canonical line each.
    pub requests: String,
}

impl ReplayHost {
    pub fn new(files: &FixtureFiles) -> Result<Self, String> {
        Ok(ReplayHost {
            model: lines(files.model.as_deref())?,
            tools: lines(files.tools.as_deref())?,
            user: values(files.user.as_deref())?,
            pending: values(files.interrupts.as_deref())?.into(),
            reloads: values(files.reloads.as_deref())?,
            requests: String::new(),
        })
    }
}

fn infra(message: impl Into<String>) -> HostError {
    HostError::Infra(message.into())
}

impl Host for ReplayHost {
    fn user(&mut self) -> Result<Option<String>, HostError> {
        let Some(line) = self.user.pop_front() else { return Ok(None) };
        if line.get("end") == Some(&Value::Bool(true)) {
            return Err(HostError::End("user.jsonl ends the run".into()));
        }
        match line.get_str("text") {
            Some(t) => Ok(Some(t.to_owned())),
            None => Err(infra("a user.jsonl line has no text")),
        }
    }

    fn model(&mut self, request: &Request) -> Result<Value, HostError> {
        self.requests.push_str(&canon(&request.to_value()));
        self.requests.push('\n');
        let line = self.model.pop_front().ok_or_else(|| infra("model.jsonl has no more responses"))?;
        let line = line.map_err(infra)?;
        if line.get("end") == Some(&Value::Bool(true)) {
            return Err(HostError::End("model.jsonl ends the run".into()));
        }
        if let Some(e) = line.get("error") {
            return Err(infra(format!("{e:?}")));
        }
        Ok(line)
    }

    fn call(&mut self, id: &str, _input: &Value) -> Result<Value, HostError> {
        let missing = || infra(format!("tools.jsonl has no answer for {id}"));
        let line = self.tools.pop_front().ok_or_else(missing)?.map_err(infra)?;
        if line.get_str("id") != Some(id) || line.get("unreachable") == Some(&Value::Bool(true)) {
            return Err(missing());
        }
        let mut answer = line.as_object().cloned().unwrap_or_default();
        answer.remove("id");
        Ok(Value::Object(answer))
    }

    fn interrupts(&mut self, step: u64) -> Vec<Value> {
        let (due, rest): (Vec<Value>, Vec<Value>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|l| l.get("step").and_then(Value::as_f64).is_some_and(|s| s <= step as f64));
        self.pending = rest;
        due.into_iter()
            .map(|l| {
                let mut m = crate::value::Map::new();
                for k in ["source", "text"] {
                    if let Some(v) = l.get(k) {
                        m.insert(k, v.clone());
                    }
                }
                Value::Object(m)
            })
            .collect()
    }

    fn harness(&mut self, step: u64) -> Option<Value> {
        let line = self.reloads.front()?;
        if line.get("step").and_then(Value::as_f64).is_some_and(|s| s > step as f64) {
            return None;
        }
        let line = self.reloads.pop_front()?;
        line.get("harness").cloned()
    }
}

/// The output of a replay: the log and the rendered requests, as JSON Lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replay {
    pub log: String,
    pub requests: String,
}

/// Replay a fixture's files (§14).
pub fn replay_files(files: &FixtureFiles) -> Result<Replay, String> {
    let harness = Harness::read(&files.harness).map_err(|e| format!("invalid harness: {e}"))?;
    let mut host = ReplayHost::new(files)?;
    let log = run(&harness, &mut host);
    Ok(Replay { log: log.text(), requests: host.requests })
}

/// Read a fixture directory's files.
pub fn read_fixture(dir: &Path) -> Result<FixtureFiles, String> {
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
    Ok(FixtureFiles {
        harness: read("harness.json").ok_or_else(|| format!("{}: no harness.json", dir.display()))?,
        model: read("model.jsonl"),
        tools: read("tools.jsonl"),
        user: read("user.jsonl"),
        interrupts: read("interrupts.jsonl"),
        reloads: read("reloads.jsonl"),
    })
}

/// Replay a fixture directory.
pub fn replay_dir(dir: &Path) -> Result<Replay, String> {
    replay_files(&read_fixture(dir)?)
}
