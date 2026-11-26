//! The log (spec §7) and the view that hooks see (§5.3).

use crate::value::{canon, Map, Value};
use std::collections::HashMap;

/// Where a run writes: the top level (depth 0), or a child of the `core_spawn` call `parent_call` (§10).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scope {
    pub depth: u64,
    pub parent_call: Option<String>,
}

impl Scope {
    pub const TOP: Scope = Scope { depth: 0, parent_call: None };

    /// A scope from a JSON value `{depth, parent_call?}`.
    pub fn from_value(v: &Value) -> Scope {
        Scope {
            depth: v.get("depth").and_then(Value::as_f64).unwrap_or(0.0) as u64,
            parent_call: v.get_str("parent_call").map(str::to_owned),
        }
    }
}

/// One log entry: `seq`, `type` and its members (§7).
pub type Entry = Map;

/// One log for a whole run, child runs included: `seq` counts from 1 across all of it.
#[derive(Clone, Debug, Default)]
pub struct Log {
    pub entries: Vec<Entry>,
}

impl Log {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append an entry written by the run in `scope`; absent members are left out by the caller.
    pub fn append(&mut self, scope: &Scope, kind: &str, members: Map) -> &Entry {
        let mut entry = Map::new();
        entry.insert("seq", Value::from(self.entries.len() + 1));
        entry.insert("type", Value::from(kind));
        for (k, v) in members.iter() {
            entry.insert(k.clone(), v.clone());
        }
        if scope.depth > 0 {
            entry.insert("depth", Value::from(scope.depth));
            entry.insert("parent_call", scope.parent_call.clone().map_or(Value::Null, Value::String));
        }
        self.entries.push(entry);
        self.entries.last().expect("just pushed")
    }

    /// JSON Lines: one canonical object per line, each line ending with "\n".
    pub fn text(&self) -> String {
        self.entries.iter().map(|e| format!("{}\n", canon(&Value::Object(e.clone())))).collect()
    }
}

/// The engine's name for a call without a usable provider id (§7): `c<seq of the assistant entry>-<index>`.
pub fn call_id(assistant_seq: usize, index: usize) -> String {
    format!("c{assistant_seq}-{index}")
}

pub fn kind(e: &Entry) -> &str {
    e.get("type").and_then(Value::as_str).unwrap_or("")
}

pub fn in_scope(e: &Entry, scope: &Scope) -> bool {
    let depth = e.get("depth").and_then(Value::as_f64).unwrap_or(0.0) as u64;
    depth == scope.depth && e.get("parent_call").and_then(Value::as_str) == scope.parent_call.as_deref()
}

/// The view of the run in `scope` (§5.3): its finished tool calls and delivered interrupts, in order.
pub fn view(entries: &[Entry], scope: &Scope) -> Vec<Value> {
    let mut calls: HashMap<String, (Value, String, Value)> = HashMap::new(); // call_id → (step, tool, args)
    let mut out = Vec::new();
    let call = |step: &Value, tool: &str, args: &Value| {
        let mut m = Map::new();
        m.insert("step", step.clone());
        m.insert("tool", Value::from(tool));
        m.insert("args", args.clone());
        m
    };
    for e in entries.iter().filter(|e| in_scope(e, scope)) {
        match kind(e) {
            "assistant" => {
                let step = e.get("step").cloned().unwrap_or(Value::Null);
                for c in e.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                    let id = c.get_str("call_id").unwrap_or_default().to_owned();
                    let tool = c.get_str("tool").unwrap_or_default().to_owned();
                    calls.insert(id, (step.clone(), tool, c.get("args").cloned().unwrap_or(Value::Null)));
                }
            }
            "hook" if e.get_str("event") == Some("post_response") && e.get_str("decision") == Some("modify") => {
                // A renamed call runs under its new name (§5.4).
                for m in e.get("calls").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(c) = calls.get_mut(m.get_str("call_id").unwrap_or_default()) {
                        c.1 = m.get_str("tool").unwrap_or_default().to_owned();
                    }
                }
            }
            "hook" => {
                let Some(id) = e.get("call_id").and_then(Value::as_str) else { continue };
                let Some(c) = calls.get_mut(id) else { continue };
                match e.get("decision").and_then(Value::as_str) {
                    Some("modify") => c.2 = e.get("args").cloned().unwrap_or(Value::Null),
                    Some("deny") => {
                        let mut m = call(&c.0, &c.1, &c.2);
                        m.insert("ok", Value::Bool(false));
                        m.insert("error", e.get("text").cloned().unwrap_or(Value::Null));
                        out.push(Value::Object(m));
                    }
                    _ => {}
                }
            }
            "tool_result" => {
                let Some(c) = e.get("call_id").and_then(Value::as_str).and_then(|id| calls.get(id)) else { continue };
                let mut m = call(&c.0, &c.1, &c.2);
                if e.get("ok") == Some(&Value::Bool(true)) {
                    m.insert("ok", Value::Bool(true));
                    m.insert("result", e.get("result").cloned().unwrap_or(Value::Null));
                } else {
                    m.insert("ok", Value::Bool(false));
                    m.insert("error", e.get("error").cloned().unwrap_or(Value::Null));
                }
                out.push(Value::Object(m));
            }
            "interrupt" => {
                let mut i = Map::new();
                i.insert("source", e.get("source").cloned().unwrap_or(Value::Null));
                i.insert("text", e.get("text").cloned().unwrap_or(Value::Null));
                let mut m = Map::new();
                m.insert("step", e.get("step").cloned().unwrap_or(Value::Null));
                m.insert("interrupt", Value::Object(i));
                out.push(Value::Object(m));
            }
            _ => {}
        }
    }
    out
}
