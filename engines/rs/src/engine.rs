//! The run loop (spec §8), hooks (§5, §6) and child runs (§10).

use crate::harness::{fill, harness_errors, spawn_input, Event, Harness, Hook, TEXTS, TURN};
use crate::log::{call_id, in_scope, kind, view, Log, Scope};
use crate::render::{render, ToolCall};
use crate::schema::{argument_reasons, compile_schema, Check};
use crate::value::{
    argument_text, canon, canonical, excerpt, is_json, parse_json, sorted_ascii_text, ArgumentForm, Map, Value,
};
use std::collections::{HashMap, HashSet};

pub use crate::render::Request;

/// Why a host can't answer (§8, §12.2): an infrastructure failure, or the host ends the run (`host_end`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostError {
    /// The model, a binding or the host failed: the run ends with `infra_failure` (§3.3, §12.2).
    Infra(String),
    /// The host ends the run (its user left, `timeout_ms` passed): `host_end` (§12.2).
    End(String),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostError::Infra(m) => write!(f, "infrastructure failure: {m}"),
            HostError::End(m) => write!(f, "host end: {m}"),
        }
    }
}

impl std::error::Error for HostError {}

/// What the engine needs from a host (§13). The engine checks every answer: a model response, a binding's answer
/// and an interrupt are JSON values whose shape is part of the interface (§3.3, §11, §14).
pub trait Host {
    /// The next user message, or `None` when the conversation is over.
    fn user(&mut self) -> Result<Option<String>, HostError>;
    /// The model's response to a request (§14 shape).
    fn model(&mut self, request: &Request) -> Result<Value, HostError>;
    /// Call the binding of a tool or handler; the answer (`{ok, result}` / `{ok, error}`) is checked by the engine.
    fn call(&mut self, id: &str, input: &Value) -> Result<Value, HostError>;
    /// Interrupts (`{source, text}`) queued for delivery at this step boundary, in arrival order (§11).
    fn interrupts(&mut self, _step: u64) -> Vec<Value> {
        Vec::new()
    }
    /// A replacement harness to take at this step boundary (§12.3).
    fn harness(&mut self, _step: u64) -> Option<Value> {
        None
    }
    /// The reasons text for arguments that failed a tool's input schema, from the host's own validator; `None` or
    /// `null` for the engine's (§8.1). Anything else but a string is an infrastructure failure.
    fn reasons(&mut self, _tool: &str, _args: &Value) -> Option<Value> {
        None
    }
}

impl<H: Host + ?Sized> Host for &mut H {
    fn user(&mut self) -> Result<Option<String>, HostError> {
        (**self).user()
    }
    fn model(&mut self, request: &Request) -> Result<Value, HostError> {
        (**self).model(request)
    }
    fn call(&mut self, id: &str, input: &Value) -> Result<Value, HostError> {
        (**self).call(id, input)
    }
    fn interrupts(&mut self, step: u64) -> Vec<Value> {
        (**self).interrupts(step)
    }
    fn harness(&mut self, step: u64) -> Option<Value> {
        (**self).harness(step)
    }
    fn reasons(&mut self, tool: &str, args: &Value) -> Option<Value> {
        (**self).reasons(tool, args)
    }
}

impl<H: Host + ?Sized> Host for Box<H> {
    fn user(&mut self) -> Result<Option<String>, HostError> {
        (**self).user()
    }
    fn model(&mut self, request: &Request) -> Result<Value, HostError> {
        (**self).model(request)
    }
    fn call(&mut self, id: &str, input: &Value) -> Result<Value, HostError> {
        (**self).call(id, input)
    }
    fn interrupts(&mut self, step: u64) -> Vec<Value> {
        (**self).interrupts(step)
    }
    fn harness(&mut self, step: u64) -> Option<Value> {
        (**self).harness(step)
    }
    fn reasons(&mut self, tool: &str, args: &Value) -> Option<Value> {
        (**self).reasons(tool, args)
    }
}

/// How a run ended (§12.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Stop,
    Limit,
    InfraFailure,
    HostEnd,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Reason::Stop => "stop",
            Reason::Limit => "limit",
            Reason::InfraFailure => "infra_failure",
            Reason::HostEnd => "host_end",
        }
    }
}

/// Why the run loop stops: the run ends with `stop` or `limit`, an infrastructure failure, or the host's end.
enum Halt {
    Ended(Reason),
    Infra,
    HostEnd,
}

impl From<HostError> for Halt {
    fn from(e: HostError) -> Self {
        match e {
            HostError::Infra(_) => Halt::Infra,
            HostError::End(_) => Halt::HostEnd,
        }
    }
}

type Step<T> = Result<T, Halt>;

const LIMITS: [&str; 5] = ["max_steps", "max_tool_calls", "max_depth", "max_continues", "max_hook_text"];
const DEFAULTS: [f64; 5] = [1000.0, 1000.0, 1.0, 3.0, 4000.0];

/// The limits a run has (§12.1), in the order of `LIMITS`.
#[derive(Clone, Copy, Debug)]
struct Limits([f64; 5]);

impl Limits {
    fn top(harness: &Harness) -> Limits {
        let mut l = DEFAULTS;
        for (i, name) in LIMITS.iter().enumerate() {
            if let Some(v) = harness.limit(name) {
                l[i] = v;
            }
        }
        Limits(l)
    }

    fn get(&self, name: &str) -> f64 {
        self.0[LIMITS.iter().position(|n| *n == name).expect("a limit")]
    }

    fn hook_text(&self) -> usize {
        self.get("max_hook_text") as usize
    }
}

/// Decisions each event allows besides `allow` (§4).
fn allowed(event: Event) -> &'static [&'static str] {
    match event {
        Event::SessionStart => &["add_context"],
        Event::UserPrompt => &["deny", "add_context"],
        Event::PreRequest => &["replace_context", "add_context"],
        Event::PreTool => &["deny", "modify", "add_context"],
        Event::PostTool => &["replace", "add_context"],
        Event::Stop => &["continue", "add_context"],
        Event::Interrupt => &["deny", "add_context"],
    }
}

/// What a failed built-in check becomes (§6).
fn push_back(event: Event) -> &'static str {
    match event {
        Event::PreTool | Event::UserPrompt | Event::Interrupt => "deny",
        Event::Stop => "continue",
        Event::PostTool => "add_context",
        Event::SessionStart | Event::PreRequest => "allow",
    }
}

const ENDS_CHAIN: [&str; 3] = ["deny", "continue", "replace_context"];

/// A hook's decision (§5.4).
#[derive(Clone, Debug)]
struct Decision {
    hook: String,
    decision: String,
    text: Option<String>,
    args: Option<Value>,
    keep: Option<f64>,
    wrap: Option<bool>,
}

impl Decision {
    fn new(hook: &Hook, decision: &str, text: Option<String>) -> Self {
        Decision { hook: hook.id.clone(), decision: decision.into(), text, args: None, keep: None, wrap: None }
    }
}

/// The event's members of a hook input (§5.3).
#[derive(Default)]
struct Members {
    call: Option<(String, Value)>,
    result: Option<Value>,
    message: Option<String>,
    interrupt: Option<(String, String)>,
    continued: Option<u64>,
}

/// One run: the top level or a child (§10). Runs are kept on a stack; a child's ancestors are below it.
struct Run {
    harness: Harness,
    scope: Scope,
    limits: Limits,
    /// Requests and tool calls of this run and its children (§8, §10).
    steps_used: u64,
    tool_calls_used: u64,
    last_text: String,
    /// The step at which this run's latest user message was admitted (§5.3).
    turn: u64,
    schemas: HashMap<String, Check>,
    /// The parent's hooks, each with the index of the run whose harness declared it (§10).
    inherited: Vec<(Hook, usize)>,
}

fn compile(harness: &Harness) -> HashMap<String, Check> {
    let mut schemas = HashMap::new();
    let mut put = |key: String, schema: &Value| {
        schemas.insert(key, compile_schema(schema).expect("a valid harness's schemas compile"));
    };
    for (id, t) in harness.tools().into_iter().flat_map(Map::iter) {
        if id == "core_spawn" {
            put("tools.core_spawn.input".into(), spawn_input());
        }
        if let Some(s) = t.get("input") {
            put(format!("tools.{id}.input"), s);
        }
        if let Some(s) = t.get("output") {
            put(format!("tools.{id}.output"), s);
        }
    }
    for (id, h) in harness.handlers().into_iter().flat_map(Map::iter) {
        if let Some(s) = h.get("input") {
            put(format!("handlers.{id}.input"), s);
        }
    }
    schemas
}

impl Run {
    fn new(harness: Harness, scope: Scope, limits: Limits, inherited: Vec<(Hook, usize)>) -> Run {
        let schemas = compile(&harness);
        Run {
            harness,
            scope,
            limits,
            steps_used: 0,
            tool_calls_used: 0,
            last_text: String::new(),
            turn: 0,
            schemas,
            inherited,
        }
    }

    /// A call's argument text in this run's harness's form (§9.4), compact or indented.
    fn argument_text(&self, args: &Value, raw: Option<&str>, indented: bool) -> String {
        match self.harness.argument_form() {
            ArgumentForm::ModelOrder => argument_text(args, indented).expect("checked arguments"),
            ArgumentForm::SortedAscii => {
                let own;
                let raw = match raw {
                    Some(r) => r,
                    None => {
                        own = argument_text(args, false).expect("checked arguments");
                        &own
                    }
                };
                sorted_ascii_text(raw, indented).expect("checked arguments")
            }
        }
    }

    /// One of the engine's texts (§8.2): the harness's wording, else the default.
    fn text(&self, name: &str, values: &[(&str, &str)]) -> String {
        let default = TEXTS.iter().find(|(n, _, _)| *n == name).and_then(|(_, _, d)| *d).unwrap_or("");
        fill(self.harness.text(name).unwrap_or(default), values)
    }
}

/// A tool call of the response as the log holds it (§7), with what the response gave for it.
struct Call {
    logged: Value,
    id: String,
    tool: String,
    args: Value,
    args_text: Option<String>,
    malformed: Option<String>,
    raw: Option<String>,
    parse_error: String,
}

struct Engine<'h> {
    host: &'h mut dyn Host,
    log: Log,
    /// The current step (§8), shared by every run in the log.
    step: u64,
    runs: Vec<Run>,
}

/// Run a valid harness to its end on a host and return the log (§8).
pub fn run(harness: &Harness, host: &mut dyn Host) -> Log {
    let mut engine = Engine { host, log: Log::new(), step: 0, runs: Vec::new() };
    engine.runs.push(Run::new(harness.clone(), Scope::TOP, Limits::top(harness), Vec::new()));
    engine.run(None);
    engine.log
}

/// The source of an interrupt: an id as in §3.1.
fn is_source(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The form of the engine's own call ids (§7), which a provider's id may not take.
fn is_engine_id(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('c') else { return false };
    let Some((a, b)) = rest.split_once('-') else { return false };
    !a.is_empty() && !b.is_empty() && a.bytes().all(|c| c.is_ascii_digit()) && b.bytes().all(|c| c.is_ascii_digit())
}

fn obj(members: Vec<(&str, Value)>) -> Map {
    let mut m = Map::new();
    for (k, v) in members {
        m.insert(k, v);
    }
    m
}

impl Engine<'_> {
    fn cur(&self) -> &Run {
        self.runs.last().expect("a run")
    }

    fn cur_mut(&mut self) -> &mut Run {
        self.runs.last_mut().expect("a run")
    }

    fn is_child(&self) -> bool {
        self.runs.len() > 1
    }

    fn append(&mut self, kind: &str, members: Map) {
        let scope = self.cur().scope.clone();
        self.log.append(&scope, kind, members);
    }

    /// The hooks of the current run: inherited ones first (§10), each with the run that declared it.
    fn hooks(&self) -> Vec<(Hook, usize)> {
        let index = self.runs.len() - 1;
        let run = self.cur();
        run.inherited.iter().cloned().chain(run.harness.hooks().into_iter().map(|h| (h, index))).collect()
    }

    /// Run the current run to its end. A child's only user message is its task; the top level asks the host.
    fn run(&mut self, task: Option<String>) -> Reason {
        let members = obj(vec![
            ("harness_hash", Value::from(self.cur().harness.hash())),
            ("depth", Value::from(self.cur().scope.depth)),
        ]);
        self.append("run_start", members);
        let reason = match self.body(task) {
            Err(Halt::Ended(r)) => r,
            Err(Halt::Infra) => Reason::InfraFailure,
            Err(Halt::HostEnd) => Reason::HostEnd,
            Ok(()) => unreachable!("a run ends by a halt"),
        };
        self.append("run_end", obj(vec![("reason", Value::from(reason.name()))]));
        reason
    }

    fn body(&mut self, task: Option<String>) -> Step<()> {
        self.start()?;
        let mut pending = task;
        loop {
            let text = if self.is_child() { pending.take() } else { self.host.user()? };
            let Some(text) = text else { return Err(Halt::Ended(Reason::Stop)) };
            let decisions =
                self.chain(Event::UserPrompt, Members { message: Some(text.clone()), ..Members::default() }, None)?;
            if decisions.iter().any(|d| d.decision == "deny") {
                continue;
            }
            self.append("user", obj(vec![("text", Value::from(text))]));
            let step = self.step;
            self.cur_mut().turn = step;
            self.take_turn()?;
        }
    }

    /// Run the `session_start` hooks and log the assembled system prompt (§9.1).
    fn start(&mut self) -> Step<()> {
        let contexts = self.chain(Event::SessionStart, Members::default(), None)?;
        let mut system = self.cur().harness.prompt().to_owned();
        for d in contexts {
            system.push_str("\n\n");
            system.push_str(&crate::render::hook_wrapper(
                "session_start",
                &d.hook,
                &d.decision,
                d.text.as_deref().unwrap_or(""),
            ));
        }
        self.append("system", obj(vec![("text", Value::from(system))]));
        Ok(())
    }

    /// The top-level step boundary (§8 step 3.1): a replacement harness, then queued interrupts.
    fn boundary(&mut self) -> Step<()> {
        if let Some(next) = self.host.harness(self.step).filter(|v| !v.is_null()) {
            if !harness_errors(&next).is_empty() {
                return Err(Halt::Infra);
            }
            let harness = Harness::new(next);
            let run = self.cur_mut();
            run.limits = Limits::top(&harness);
            run.schemas = compile(&harness);
            run.harness = harness;
            let hash = self.cur().harness.hash();
            self.append("harness_changed", obj(vec![("harness_hash", Value::from(hash))]));
            self.start()?;
            if self.cur().steps_used as f64 >= self.cur().limits.get("max_steps") {
                return Err(Halt::Ended(Reason::Limit));
            }
        }
        for interrupt in self.host.interrupts(self.step) {
            let source = interrupt.get_str("source").filter(|s| is_source(s));
            let text = interrupt.get_str("text");
            let (Some(source), Some(text), Value::Object(_)) = (source, text, &interrupt) else {
                return Err(Halt::Infra);
            };
            let (source, text) = (source.to_owned(), text.to_owned());
            let members = Members { interrupt: Some((source.clone(), text.clone())), ..Members::default() };
            let decisions = self.chain(Event::Interrupt, members, None)?;
            if decisions.iter().any(|d| d.decision == "deny") {
                continue;
            }
            let step = self.step;
            self.append(
                "interrupt",
                obj(vec![("source", source.into()), ("text", text.into()), ("step", step.into())]),
            );
        }
        Ok(())
    }

    fn take_turn(&mut self) -> Step<()> {
        let mut continued = 0u64;
        loop {
            if self.cur().steps_used as f64 >= self.cur().limits.get("max_steps") {
                return Err(Halt::Ended(Reason::Limit));
            }
            if !self.is_child() {
                self.boundary()?;
            }
            self.chain(Event::PreRequest, Members::default(), None)?;
            let request = render(&self.cur().harness, &self.log.entries, &self.cur().scope);
            let response = check_response(self.host.model(&request)?)?;
            self.step += 1;
            for run in &mut self.runs {
                run.steps_used += 1;
            }
            let calls = self.logged_calls(&response);
            let text = response.get_str("text").unwrap_or("").to_owned();
            self.cur_mut().last_text = text.clone();
            let mut members = obj(vec![
                ("step", Value::from(self.step)),
                ("text", Value::from(text.clone())),
                ("tool_calls", Value::Array(calls.iter().map(|c| c.logged.clone()).collect())),
            ]);
            for k in ["reasoning", "reasoning_opaque", "usage"] {
                if let Some(v) = response.get(k) {
                    members.insert(k, v.clone());
                }
            }
            self.append("assistant", members);
            let had_calls = !calls.is_empty();
            for call in calls {
                self.tool_call(call)?;
            }
            if had_calls {
                continue;
            }
            if (continued as f64) < self.cur().limits.get("max_continues") {
                let members = Members { message: Some(text), continued: Some(continued), ..Members::default() };
                let decisions = self.chain(Event::Stop, members, None)?;
                if decisions.iter().any(|d| d.decision == "continue") {
                    continued += 1;
                    continue;
                }
            }
            return Ok(());
        }
    }

    /// The response's calls as the log holds them (§7): ids, argument texts, malformed texts.
    fn logged_calls(&self, response: &Value) -> Vec<Call> {
        let seq = self.log.entries.len() + 1;
        let mut used: HashSet<String> = HashSet::new();
        for e in self.log.entries.iter().filter(|e| kind(e) == "assistant") {
            for c in e.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                if let Some(id) = c.get_str("call_id") {
                    used.insert(id.to_owned());
                }
            }
        }
        let run = self.cur();
        let calls = response.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default();
        calls
            .iter()
            .enumerate()
            .map(|(i, c)| {
                // The provider's id, unless it is empty, taken, or of the engine's form (§7).
                let id = match c.get_str("call_id") {
                    Some(given) if !given.is_empty() && !used.contains(given) && !is_engine_id(given) => {
                        given.to_owned()
                    }
                    _ => call_id(seq, i),
                };
                used.insert(id.clone());
                let tool = c.get_str("tool").unwrap_or_default().to_owned();
                let parse_error = c.get_str("parse_error").unwrap_or("").to_owned();
                if let Some(malformed) = c.get_str("malformed") {
                    // Its arguments go back as {} (§9.4).
                    let logged = obj(vec![
                        ("call_id", id.clone().into()),
                        ("tool", tool.clone().into()),
                        ("args", Value::Object(Map::new())),
                        ("malformed", malformed.into()),
                    ]);
                    return Call {
                        logged: Value::Object(logged),
                        id,
                        tool,
                        args: Value::Object(Map::new()),
                        args_text: None,
                        malformed: Some(malformed.to_owned()),
                        raw: None,
                        parse_error,
                    };
                }
                let args = c.get("args").cloned().unwrap_or(Value::Null);
                let raw = c.get_str("raw").map(str::to_owned);
                // Written now, in the form of the harness that runs the call (§9.4).
                let text = run.argument_text(&args, raw.as_deref(), false);
                let args_text = (text != canon(&args)).then_some(text);
                let mut logged =
                    obj(vec![("call_id", id.clone().into()), ("tool", tool.clone().into()), ("args", args.clone())]);
                if let Some(t) = &args_text {
                    logged.insert("args_text", t.clone().into());
                }
                Call { logged: Value::Object(logged), id, tool, args, args_text, malformed: None, raw, parse_error }
            })
            .collect()
    }

    fn tool_call(&mut self, call: Call) -> Step<()> {
        if self.cur().tool_calls_used as f64 >= self.cur().limits.get("max_tool_calls") {
            return Err(Halt::Ended(Reason::Limit));
        }
        for run in &mut self.runs {
            run.tool_calls_used += 1;
        }
        let run = self.cur();
        let shown_args = ToolCall {
            call_id: call.id.clone(),
            tool: call.tool.clone(),
            args: call.args.clone(),
            args_text: call.args_text.clone(),
        }
        .text();
        let indented = run.argument_text(&call.args, call.raw.as_deref(), true);
        if run.harness.tool(&call.tool).is_none() {
            let error =
                run.text("unknown_tool", &[("tool", &call.tool), ("args", &shown_args), ("args_indented", &indented)]);
            self.result(&call, false, Value::from(error));
            return Ok(());
        }
        if let Some(malformed) = &call.malformed {
            let error = run.text(
                "malformed_arguments",
                &[("tool", &call.tool), ("text", malformed), ("parse_error", &call.parse_error)],
            );
            self.result(&call, false, Value::from(error));
            return Ok(());
        }
        let input_key = format!("tools.{}.input", call.tool);
        if !run.schemas[&input_key].is_valid(&call.args) {
            let schema = if call.tool == "core_spawn" {
                spawn_input().clone()
            } else {
                run.harness.tool(&call.tool).and_then(|t| t.get("input")).cloned().unwrap_or(Value::Null)
            };
            let reasons = match self.host.reasons(&call.tool, &call.args) {
                None | Some(Value::Null) => argument_reasons(&schema, &call.args),
                Some(Value::String(own)) => own,
                Some(_) => return Err(Halt::Infra),
            };
            let run = self.cur();
            let error = run.text(
                "invalid_arguments",
                &[("tool", &call.tool), ("args", &shown_args), ("args_indented", &indented), ("reasons", &reasons)],
            );
            self.result(&call, false, Value::from(error));
            return Ok(());
        }
        let members = Members { call: Some((call.tool.clone(), call.args.clone())), ..Members::default() };
        let pre = self.chain(Event::PreTool, members, Some(&call.id))?;
        if pre.iter().any(|d| d.decision == "deny") {
            return Ok(());
        }
        let args =
            pre.iter().rev().find(|d| d.decision == "modify").and_then(|d| d.args.clone()).unwrap_or(call.args.clone());
        let answer = if call.tool == "core_spawn" {
            match self.spawn(&call, &args)? {
                Some(a) => a,
                None => return Ok(()),
            }
        } else {
            let answer = self.host.call(&call.tool, &args)?;
            check_answer(answer, self.cur().schemas.get(&format!("tools.{}.output", call.tool)))?
        };
        let (ok, value) = answer;
        self.result(&call, ok, value.clone());
        let result = if ok {
            Value::Object(obj(vec![("ok", true.into()), ("result", value)]))
        } else {
            Value::Object(obj(vec![("ok", false.into()), ("error", value)]))
        };
        let members = Members { call: Some((call.tool.clone(), args)), result: Some(result), ..Members::default() };
        self.chain(Event::PostTool, members, Some(&call.id))?;
        Ok(())
    }

    fn result(&mut self, call: &Call, ok: bool, value: Value) {
        let members = obj(vec![
            ("call_id", call.id.clone().into()),
            ("tool", call.tool.clone().into()),
            ("ok", ok.into()),
            (if ok { "result" } else { "error" }, value),
        ]);
        self.append("tool_result", members);
    }

    /// `core_spawn` (§10): the narrowing check, then the child run. `None` if the check denied it.
    fn spawn(&mut self, call: &Call, args: &Value) -> Step<Option<(bool, Value)>> {
        let child = args.get("harness").cloned().unwrap_or(Value::Null);
        if let Some(denial) = self.narrowing(&child) {
            let text = excerpt(&denial, self.cur().limits.hook_text());
            let members = obj(vec![
                ("hook", "core_spawn".into()),
                ("event", "pre_tool".into()),
                ("decision", "deny".into()),
                ("text", text.into()),
                ("call_id", call.id.clone().into()),
            ]);
            self.append("hook", members);
            return Ok(None);
        }
        let child = Harness::new(child);
        let mut limits = [0.0; 5];
        for (i, name) in LIMITS.iter().enumerate() {
            limits[i] = child.limit(name).unwrap_or_else(|| self.allowance(name));
        }
        let scope = Scope { depth: self.cur().scope.depth + 1, parent_call: Some(call.id.clone()) };
        let inherited = self.hooks();
        let task = args.get_str("task").unwrap_or_default().to_owned();
        self.runs.push(Run::new(child, scope, Limits(limits), inherited));
        let reason = self.run(Some(task));
        let child = self.runs.pop().expect("the child run");
        match reason {
            Reason::InfraFailure => Err(Halt::Infra),
            Reason::HostEnd => Err(Halt::HostEnd),
            Reason::Stop | Reason::Limit => {
                let result = obj(vec![
                    ("text", child.last_text.into()),
                    ("steps", child.steps_used.into()),
                    ("tool_calls", child.tool_calls_used.into()),
                ]);
                Ok(Some((true, Value::Object(result))))
            }
        }
    }

    /// How much of a limit a child may have: what is left of a budget, else the limit itself.
    fn allowance(&self, name: &str) -> f64 {
        let run = self.cur();
        match name {
            "max_steps" => run.limits.get(name) - run.steps_used as f64,
            "max_tool_calls" => run.limits.get(name) - run.tool_calls_used as f64,
            _ => run.limits.get(name),
        }
    }

    /// The first failed narrowing check's text (§10), or `None` if the child may run.
    fn narrowing(&self, child: &Value) -> Option<String> {
        if !harness_errors(child).is_empty() {
            return Some("child harness is not valid".into());
        }
        let parent = &self.cur().harness;
        let child = Harness::new(child.clone());
        let empty = Map::new();
        let tools = parent.tools().unwrap_or(&empty);
        let child_tools = child.tools().unwrap_or(&empty);
        let mut ids: Vec<&String> = child_tools.keys().collect();
        ids.sort_by(|a, b| crate::value::utf16_order(a, b));
        for id in ids {
            let Some(theirs) = tools.get(id) else { return Some(format!("child tool {id} is not a parent tool")) };
            let input = |t: &Value| canon(t.get("input").unwrap_or(&Value::Null));
            if input(child_tools.get(id).expect("a tool")) != input(theirs) {
                return Some(format!("child tool {id} has a different input schema"));
            }
        }
        let handlers = parent.handlers().unwrap_or(&empty);
        let mut ids: Vec<&String> = child.handlers().unwrap_or(&empty).keys().collect();
        ids.sort_by(|a, b| crate::value::utf16_order(a, b));
        for id in ids {
            if !handlers.contains_key(id) {
                return Some(format!("child handler {id} is not a parent handler"));
            }
        }
        for name in LIMITS {
            if let Some(declared) = child.limit(name) {
                let allowance = self.allowance(name);
                if declared > allowance {
                    return Some(format!(
                        "child limit {name} exceeds the parent's {}",
                        canon(&Value::Number(allowance))
                    ));
                }
            }
        }
        let depth = self.cur().scope.depth;
        if child_tools.contains_key("core_spawn") && (depth + 1) as f64 >= self.cur().limits.get("max_depth") {
            return Some(format!("child at depth {} may not spawn", depth + 1));
        }
        None
    }

    /// Run the hooks of an event in order (§5.2), log each decision, and return the ones that act.
    fn chain(&mut self, event: Event, members: Members, call_id: Option<&str>) -> Step<Vec<Decision>> {
        let mut acting = Vec::new();
        let mut current = members.call.clone();
        let mut replaced: Option<String> = None;
        let key = members
            .call
            .as_ref()
            .map(|(t, _)| t.clone())
            .or_else(|| members.interrupt.as_ref().map(|(s, _)| s.clone()));
        for (hook, owner) in self.hooks() {
            if hook.on != event || !hook.matches.matches(key.as_deref()) {
                continue;
            }
            let run = self.cur();
            let mut input = obj(vec![
                ("event", event.name().into()),
                ("hook", hook.id.clone().into()),
                ("with", hook.with.clone()),
                ("step", self.step.into()),
                ("turn", run.turn.into()),
                ("view", Value::Array(view(&self.log.entries, &run.scope))),
            ]);
            if let Some((tool, args)) = &current {
                input.insert("call", Value::Object(obj(vec![("tool", tool.clone().into()), ("args", args.clone())])));
            }
            if let Some(r) = &members.result {
                input.insert("result", r.clone());
            }
            if let Some(r) = &replaced {
                input.insert("replaced", r.clone().into());
            }
            if let Some(m) = &members.message {
                input.insert("message", m.clone().into());
            }
            if let Some((source, text)) = &members.interrupt {
                input.insert(
                    "interrupt",
                    Value::Object(obj(vec![("source", source.clone().into()), ("text", text.clone().into())])),
                );
            }
            if let Some(c) = members.continued {
                input.insert("continued", c.into());
            }
            // The request's messages as they would be rendered now, and the usage the run's last response
            // reported (§5.3).
            if matches!(event, Event::PreRequest | Event::Stop) {
                let request = render(&run.harness, &self.log.entries, &run.scope);
                input.insert("context", Value::Array(request.messages.iter().map(|m| m.to_value()).collect()));
                let last = self.log.entries.iter().rev().find(|e| kind(e) == "assistant" && in_scope(e, &run.scope));
                if let Some(usage) = last.and_then(|e| e.get("usage")) {
                    input.insert("usage", usage.clone());
                }
            }
            let input = Value::Object(input);
            let tool = current.as_ref().map(|(t, _)| t.clone());
            let decision = self.decide(&hook, owner, event, &input, tool.as_deref())?;
            let mut entry = obj(vec![("hook", hook.id.clone().into()), ("event", event.name().into())]);
            let Some(d) = decision else {
                entry.insert("decision", "failed".into());
                if let Some(id) = call_id {
                    entry.insert("call_id", id.into());
                }
                self.append("hook", entry);
                if !hook.skip_on_failure {
                    return Err(Halt::Infra);
                }
                continue;
            };
            entry.insert("decision", d.decision.clone().into());
            if let Some(t) = &d.text {
                entry.insert("text", t.clone().into());
            }
            if let Some(a) = &d.args {
                entry.insert("args", a.clone());
            }
            if let Some(k) = d.keep {
                entry.insert("keep", k.into());
            }
            if let Some(w) = d.wrap {
                entry.insert("wrap", w.into());
            }
            if let Some(id) = call_id {
                entry.insert("call_id", id.into());
            }
            self.append("hook", entry);
            if d.decision == "allow" {
                continue;
            }
            if d.decision == "modify" {
                current = current.map(|(t, _)| (t, d.args.clone().unwrap_or(Value::Null)));
            }
            if d.decision == "replace" {
                replaced = d.text.clone();
            }
            let ends = ENDS_CHAIN.contains(&d.decision.as_str());
            acting.push(d);
            if ends {
                break;
            }
        }
        Ok(acting)
    }

    /// One hook's decision (§5.4), or `None` if the hook failed. Only the host's end escapes as an error.
    fn decide(
        &mut self,
        hook: &Hook,
        owner: usize,
        event: Event,
        input: &Value,
        tool: Option<&str>,
    ) -> Step<Option<Decision>> {
        let max = self.cur().limits.hook_text();
        let cap = |t: &str| excerpt(t, max);
        let w = &hook.with;
        if hook.run.starts_with("core_") {
            if hook.run == "core_context" {
                return Ok(Some(Decision::new(hook, "add_context", Some(cap(w.get_str("text").unwrap_or_default())))));
            }
            let run = self.cur();
            let entries = input.get("view").and_then(Value::as_array).cloned().unwrap_or_default();
            return Ok(Some(match check(&hook.run, w, self.step, run.turn, &entries) {
                None => Decision::new(hook, "allow", None),
                Some(failure) => Decision::new(hook, push_back(event), Some(cap(&failure))),
            }));
        }
        if let Some(schema) = self.runs[owner].schemas.get(&format!("handlers.{}.input", hook.run)) {
            if !schema.is_valid(input) {
                return Ok(None);
            }
        }
        let answer = match self.host.call(&hook.run, input) {
            Ok(a) => a,
            Err(HostError::Infra(_)) => return Ok(None),
            Err(HostError::End(_)) => return Err(Halt::HostEnd),
        };
        let Some(answer) = answer.as_object() else { return Ok(None) };
        if answer.get("ok") != Some(&Value::Bool(true)) || answer.len() != 2 {
            return Ok(None);
        }
        let Some(out) = answer.get("result").and_then(Value::as_object) else { return Ok(None) };
        let Some(decision) = out.get("decision").and_then(Value::as_str) else { return Ok(None) };
        if decision != "allow" && !allowed(event).contains(&decision) {
            return Ok(None);
        }
        let mut names: Vec<&String> = out.keys().filter(|k| *k != "decision").collect();
        names.sort();
        let members = names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",");
        let text = out.get("text");
        if decision == "allow" {
            return Ok((members.is_empty()).then(|| Decision::new(hook, "allow", None)));
        }
        if decision == "modify" {
            if members != "args" && members != "args,text" {
                return Ok(None);
            }
            if text.is_some_and(|t| t.as_str().is_none()) {
                return Ok(None);
            }
            let args = out.get("args").expect("a member");
            let schema = tool.and_then(|t| self.cur().schemas.get(&format!("tools.{t}.input")));
            if !is_json(args) || !schema.is_some_and(|s| s.is_valid(args)) {
                return Ok(None);
            }
            let mut d = Decision::new(hook, "modify", text.and_then(Value::as_str).map(cap));
            d.args = Some(args.clone());
            return Ok(Some(d));
        }
        if decision == "replace_context" && members != "text" {
            // Optional `keep` (at most the context's messages) and `wrap` (§5.4); unwrapped text is not excerpted.
            if !names.iter().any(|n| *n == "text")
                || names.iter().any(|n| !matches!(n.as_str(), "text" | "keep" | "wrap"))
            {
                return Ok(None);
            }
            let Some(text) = text.and_then(Value::as_str) else { return Ok(None) };
            let context = input.get("context").and_then(Value::as_array).map_or(0, Vec::len);
            let keep = out.get("keep");
            if let Some(k) = keep {
                let ok = k.as_f64().is_some_and(|k| k.fract() == 0.0 && k >= 0.0 && k <= context as f64);
                if !ok {
                    return Ok(None);
                }
            }
            let wrap = out.get("wrap");
            if wrap.is_some_and(|w| w.as_bool().is_none()) {
                return Ok(None);
            }
            let wrap = wrap.and_then(Value::as_bool);
            let text = if wrap == Some(false) { text.to_owned() } else { cap(text) };
            let mut d = Decision::new(hook, "replace_context", Some(text));
            d.keep = keep.and_then(Value::as_f64);
            d.wrap = wrap;
            return Ok(Some(d));
        }
        match text {
            Some(Value::String(t)) if members == "text" => Ok(Some(Decision::new(hook, decision, Some(cap(t))))),
            _ => Ok(None),
        }
    }
}

/// A built-in check (§6): `None` if it passes, else the failure text.
fn check(run: &str, w: &Value, step: u64, turn: u64, entries: &[Value]) -> Option<String> {
    let calls: Vec<&Value> = entries.iter().filter(|e| e.get("tool").is_some()).collect();
    let step_of = |e: &Value| e.get("step").and_then(Value::as_f64).unwrap_or(0.0);
    let successful = |e: &Value, tool: &Value| e.get("tool") == Some(tool) && e.get("ok") == Some(&Value::Bool(true));
    let seen = |e: &Value| step_of(e) < step as f64;
    let tool = w.get("tool").cloned().unwrap_or(Value::Null);
    match run {
        "core_called_since" => {
            let tools = match &tool {
                Value::Array(ids) => ids.clone(),
                t => vec![t.clone()],
            };
            let named = tools.iter().map(|t| t.as_str().unwrap_or_default()).collect::<Vec<_>>().join(" or ");
            let any_tool = |e: &Value| tools.iter().any(|t| successful(e, t));
            if w.get_str("since") == Some(TURN) {
                if calls.iter().any(|e| any_tool(e) && seen(e) && step_of(e) > turn as f64) {
                    return None;
                }
                return Some(format!("{named} not called this turn"));
            }
            let since = w.get("since");
            let last = since.and_then(|s| calls.iter().rposition(|e| successful(e, s)));
            let after = last.map_or(0, |i| i + 1);
            if calls[after..].iter().any(|e| any_tool(e) && seen(e)) {
                return None;
            }
            Some(match last {
                Some(_) => {
                    format!("{named} not called since the last {}", since.and_then(Value::as_str).unwrap_or_default())
                }
                None => format!("{named} not called yet"),
            })
        }
        "core_last_result" => {
            let name = tool.as_str().unwrap_or_default();
            let Some(last) = calls.iter().rev().find(|e| successful(e, &tool) && seen(e)) else {
                return Some(format!("{name} has no successful call yet"));
            };
            let path = w.get_str("path").unwrap_or_default();
            let eq = w.get("eq").cloned().unwrap_or(Value::Null);
            match at(last.get("result").unwrap_or(&Value::Null), path) {
                Some(v) if canon(v) == canon(&eq) => None,
                _ => Some(format!("last {name} result {path} is not {}", canon(&eq))),
            }
        }
        "core_count" => {
            let max = w.get("max").and_then(Value::as_f64).unwrap_or(0.0);
            let n = calls.iter().filter(|e| successful(e, &tool)).count();
            if (n as f64) < max {
                None
            } else {
                Some(format!("{} limit reached ({})", tool.as_str().unwrap_or_default(), canon(&Value::Number(max))))
            }
        }
        _ => Some(w.get_str("text").unwrap_or_default().to_owned()), // core_deny
    }
}

/// The value at a `.`-separated path of member names and array indexes (§6); `None` if none.
fn at<'v>(value: &'v Value, path: &str) -> Option<&'v Value> {
    if path.is_empty() {
        return Some(value);
    }
    let mut v = value;
    for segment in path.split('.') {
        let index = !segment.is_empty()
            && segment.bytes().all(|b| b.is_ascii_digit())
            && (segment == "0" || !segment.starts_with('0'));
        v = match v {
            Value::Array(items) if index => items.get(segment.parse::<usize>().ok()?)?,
            Value::Object(m) => m.get(segment)?,
            _ => return None,
        };
    }
    Some(v)
}

/// A tool call of a model response (§14): `args` with an optional `raw`, or `malformed` text with an optional
/// `parse_error`; an optional id.
fn is_response_call(c: &Value) -> bool {
    let Some(m) = c.as_object() else { return false };
    if m.get("tool").and_then(Value::as_str).is_none() || m.contains_key("args") == m.contains_key("malformed") {
        return false;
    }
    if m.get("call_id").is_some_and(|i| i.as_str().is_none()) {
        return false;
    }
    let parse_error = m.get("parse_error");
    if m.contains_key("malformed") {
        return m.get("malformed").and_then(Value::as_str).is_some()
            && parse_error.is_none_or(|p| p.as_str().is_some())
            && !m.contains_key("raw");
    }
    parse_error.is_none()
        && match m.get("raw") {
            None => true,
            Some(Value::String(raw)) => reads(raw, m.get("args").expect("args")),
            Some(_) => false,
        }
}

/// `raw` is JSON text whose value (read as §1 reads numbers) is `args`.
fn reads(raw: &str, args: &Value) -> bool {
    match (parse_json(raw).ok().and_then(|v| canonical(&v).ok()), canonical(args)) {
        (Some(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// A model response as the transport delivered it; anything else breaks the interface (§14).
fn check_response(v: Value) -> Step<Value> {
    let ok = v.as_object().is_some_and(|m| {
        let opt_str = |k: &str| m.get(k).is_none_or(|x| x.as_str().is_some());
        opt_str("text")
            && opt_str("reasoning")
            && m.get("reasoning_opaque").is_none_or(|o| {
                o.as_object().is_some_and(|o| {
                    o.len() == 2 && o.get("provider").and_then(Value::as_str).is_some() && o.contains_key("data")
                })
            })
            && m.get("usage").is_none_or(|u| u.as_object().is_some())
            && m.get("tool_calls").is_none_or(|c| c.as_array().is_some_and(|c| c.iter().all(is_response_call)))
    });
    if !ok || !is_json(&v) {
        return Err(Halt::Infra);
    }
    Ok(v)
}

/// A binding's answer (§3.3): `{ok: true, result}` or `{ok: false, error}`, nothing else.
fn check_answer(v: Value, output: Option<&Check>) -> Step<(bool, Value)> {
    let Some(m) = v.as_object() else { return Err(Halt::Infra) };
    if m.len() == 2 && m.get("ok") == Some(&Value::Bool(true)) {
        if let Some(result) = m.get("result").filter(|r| is_json(r)) {
            if output.is_some_and(|o| !o.is_valid(result)) {
                return Err(Halt::Infra);
            }
            return Ok((true, result.clone()));
        }
    }
    if m.len() == 2 && m.get("ok") == Some(&Value::Bool(false)) {
        if let Some(Value::String(e)) = m.get("error") {
            return Ok((false, Value::String(e.clone())));
        }
    }
    Err(Halt::Infra)
}
