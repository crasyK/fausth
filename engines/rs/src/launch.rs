//! A binding that launches another Fausth run (spec §13.1): the harness it is handed, with its own log and limits.
//!
//! A handler bound this way takes the harness from its hook's `with` (`with.harness`: the calling file names its
//! sub-agent, so all of a system's harnesses are in one resolved document); a tool takes it from its arguments
//! (`harness`: an orchestrator's model writes a sub-agent at runtime). The launched run inherits none of the caller's
//! hooks and is not narrowed against the caller's harness (unlike `core_spawn`, §10). It is a top-level run of its
//! own: one user message, the task the binding makes from its input, and its log is not the caller's.

use crate::engine::{run, Host, HostError, Request};
use crate::harness::{harness_errors, Harness};
use crate::log::{kind, Log};
use crate::value::{Map, Value};

/// core_spawn's words (§10).
pub const INVALID: &str = "child harness is not valid";

/// The harness a binding is handed (§13.1): a hook input's `with.harness`, else a tool's `harness` argument.
pub fn handed_harness(input: &Value) -> Option<Value> {
    let m = input.as_object()?;
    if m.contains_key("event") {
        if let Some(Value::Object(with)) = m.get("with") {
            return with.get("harness").cloned();
        }
    }
    m.get("harness").cloned()
}

/// The text of the run's last top-level assistant entry, "" if none (as `core_spawn` returns it, §10).
pub fn final_text(log: &Log) -> String {
    log.entries
        .iter()
        .rev()
        .find(|e| kind(e) == "assistant" && !e.contains_key("depth"))
        .and_then(|e| e.get("text").and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

type Pick = Box<dyn Fn(&Value) -> Option<Value>>;
type Answer = Box<dyn Fn(&Log) -> Value>;
type Binds = Box<dyn Fn(&str) -> bool>;
type OnLog = Box<dyn FnMut(&Log)>;

/// How a launching binding picks its harness, makes its answer and files the launched run's log.
#[derive(Default)]
pub struct LaunchOptions {
    /// Picks the handed harness; by default `handed_harness`.
    pub harness: Option<Pick>,
    /// The answer from the log of a run that ended with `stop` or `limit`; by default `{ok: true, result: <its final
    /// text>}`.
    pub answer: Option<Answer>,
    /// Whether the launched run's deployment binds an id; a handed harness that declares another is not valid.
    pub binds: Option<Binds>,
    /// Receives every launched run's log, however it ended, for the host to keep.
    pub on_log: Option<OnLog>,
}

/// A binding (input → answer, §3.3) that runs the harness it is handed on `host`, `task(input)` its only user
/// message. A handed harness that isn't valid (§2, §3, §5.1), or declares an id the launched run's deployment
/// doesn't bind, gets `ok: false`, `child harness is not valid`: world feedback for a tool, a failed hook for a
/// handler (§5.4). `host` serves the launched run (its model transport and its own bindings); its `user()` is never
/// asked. A task that isn't a string is an infrastructure failure. A run that ends with `infra_failure` or
/// `host_end` leaves the binding without an answer: an infrastructure failure of the caller's binding (§3.3).
pub struct HarnessBinding<H: Host, T: Fn(&Value) -> Value> {
    host: H,
    task: T,
    options: LaunchOptions,
}

impl<H: Host, T: Fn(&Value) -> Value> HarnessBinding<H, T> {
    pub fn new(host: H, task: T, options: LaunchOptions) -> Self {
        HarnessBinding { host, task, options }
    }

    /// The host that serves the launched runs.
    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    /// Answer one call of the bound tool or handler.
    pub fn call(&mut self, input: &Value) -> Result<Value, HostError> {
        let handed = match &self.options.harness {
            Some(pick) => pick(input),
            None => handed_harness(input),
        }
        .unwrap_or(Value::Null);
        let invalid = || {
            let mut m = Map::new();
            m.insert("ok", Value::Bool(false));
            m.insert("error", Value::from(INVALID));
            Ok(Value::Object(m))
        };
        if !harness_errors(&handed).is_empty() {
            return invalid();
        }
        let harness = Harness::new(handed);
        if let Some(binds) = &self.options.binds {
            if !declared(&harness).iter().all(|id| binds(id)) {
                return invalid();
            }
        }
        let Value::String(text) = (self.task)(input) else {
            return Err(HostError::Infra("the binding's task is not a string".into()));
        };
        let mut launched = OneTask { host: &mut self.host, task: Some(text) };
        let log = run(&harness, &mut launched);
        if let Some(on_log) = &mut self.options.on_log {
            on_log(&log);
        }
        let reason = log.entries.last().and_then(|e| e.get("reason")).and_then(Value::as_str).unwrap_or("");
        if reason == "infra_failure" || reason == "host_end" {
            return Err(HostError::Infra(format!("the launched run ended with {reason}")));
        }
        Ok(match &self.options.answer {
            Some(answer) => answer(&log),
            None => {
                let mut m = Map::new();
                m.insert("ok", Value::Bool(true));
                m.insert("result", Value::from(final_text(&log)));
                Value::Object(m)
            }
        })
    }
}

/// A binding that launches the harness it is handed (§13.1); see `HarnessBinding`.
pub fn harness_binding<H: Host, T: Fn(&Value) -> Value>(
    host: H,
    task: T,
    options: LaunchOptions,
) -> HarnessBinding<H, T> {
    HarnessBinding::new(host, task, options)
}

/// The ids a deployment binds for a harness (§13): its tools and handlers, built-ins aside.
fn declared(harness: &Harness) -> Vec<String> {
    let mut ids: Vec<String> = harness.tool_ids();
    ids.extend(harness.handlers().into_iter().flat_map(|h| h.keys().cloned()));
    ids.retain(|id| id != "core_spawn");
    ids
}

/// The launched run's host: the task is its only user message; everything else is the given host's.
struct OneTask<'a, H: Host> {
    host: &'a mut H,
    task: Option<String>,
}

impl<H: Host> Host for OneTask<'_, H> {
    fn user(&mut self) -> Result<Option<String>, HostError> {
        Ok(self.task.take())
    }
    fn model(&mut self, request: &Request) -> Result<Value, HostError> {
        self.host.model(request)
    }
    fn call(&mut self, id: &str, input: &Value) -> Result<Value, HostError> {
        self.host.call(id, input)
    }
    fn interrupts(&mut self, step: u64) -> Vec<Value> {
        self.host.interrupts(step)
    }
    fn harness(&mut self, step: u64) -> Option<Value> {
        self.host.harness(step)
    }
    fn reasons(&mut self, tool: &str, args: &Value) -> Option<Value> {
        self.host.reasons(tool, args)
    }
}
