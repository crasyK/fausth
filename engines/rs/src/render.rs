//! Rendering (spec §9): the provider-neutral request, a function of the harness and the log.

use crate::harness::{fill, shown_tool, Harness};
use crate::log::{in_scope, kind, Entry, Scope};
use crate::value::{canon, Map, Value};
use std::collections::HashMap;

/// A tool offered to the model (§9).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input: Value,
}

/// A tool call as the request carries it (§9): `args_text` only when it isn't the canonical form of `args` (§9.4).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub call_id: String,
    pub tool: String,
    pub args: Value,
    pub args_text: Option<String>,
}

impl ToolCall {
    /// The argument text of the call (§9.4): its `args_text`, else the canonical form of its `args`.
    pub fn text(&self) -> String {
        self.args_text.clone().unwrap_or_else(|| canon(&self.args))
    }

    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("call_id", Value::from(self.call_id.as_str()));
        m.insert("tool", Value::from(self.tool.as_str()));
        m.insert("args", self.args.clone());
        if let Some(t) = &self.args_text {
            m.insert("args_text", Value::from(t.as_str()));
        }
        Value::Object(m)
    }

    /// A call from a logged or requested call object (a log's `malformed` is left out).
    pub fn from_value(v: &Value) -> ToolCall {
        ToolCall {
            call_id: v.get_str("call_id").unwrap_or_default().to_owned(),
            tool: v.get_str("tool").unwrap_or_default().to_owned(),
            args: v.get("args").cloned().unwrap_or(Value::Null),
            args_text: v.get_str("args_text").map(str::to_owned),
        }
    }
}

/// A message of the request (§9).
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    User { text: String },
    Assistant { text: String, tool_calls: Vec<ToolCall>, reasoning: Option<String>, reasoning_opaque: Option<Value> },
    Tool { call_id: String, tool: String, text: String },
}

impl Message {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        match self {
            Message::User { text } => {
                m.insert("role", Value::from("user"));
                m.insert("text", Value::from(text.as_str()));
            }
            Message::Assistant { text, tool_calls, reasoning, reasoning_opaque } => {
                m.insert("role", Value::from("assistant"));
                m.insert("text", Value::from(text.as_str()));
                m.insert("tool_calls", Value::Array(tool_calls.iter().map(ToolCall::to_value).collect()));
                if let Some(r) = reasoning {
                    m.insert("reasoning", Value::from(r.as_str()));
                }
                if let Some(o) = reasoning_opaque {
                    m.insert("reasoning_opaque", o.clone());
                }
            }
            Message::Tool { call_id, tool, text } => {
                m.insert("role", Value::from("tool"));
                m.insert("call_id", Value::from(call_id.as_str()));
                m.insert("tool", Value::from(tool.as_str()));
                m.insert("text", Value::from(text.as_str()));
            }
        }
        Value::Object(m)
    }

    pub fn from_value(v: &Value) -> Option<Message> {
        let text = || v.get_str("text").unwrap_or_default().to_owned();
        Some(match v.get_str("role")? {
            "user" => Message::User { text: text() },
            "assistant" => Message::Assistant {
                text: text(),
                tool_calls: v
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(|c| c.iter().map(ToolCall::from_value).collect())
                    .unwrap_or_default(),
                reasoning: v.get_str("reasoning").map(str::to_owned),
                reasoning_opaque: v.get("reasoning_opaque").cloned(),
            },
            "tool" => Message::Tool {
                call_id: v.get_str("call_id").unwrap_or_default().to_owned(),
                tool: v.get_str("tool").unwrap_or_default().to_owned(),
                text: text(),
            },
            _ => return None,
        })
    }
}

/// The provider-neutral request (§9): what the model sees.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub system: String,
    pub tools: Vec<ToolSpec>,
    pub messages: Vec<Message>,
}

impl Request {
    /// The request as JSON, the shape `expected.requests.jsonl` records (§9, §14).
    pub fn to_value(&self) -> Value {
        let tools = self
            .tools
            .iter()
            .map(|t| {
                let mut m = Map::new();
                m.insert("name", Value::from(t.name.as_str()));
                m.insert("description", Value::from(t.description.as_str()));
                m.insert("input", t.input.clone());
                Value::Object(m)
            })
            .collect();
        let mut m = Map::new();
        m.insert("system", Value::from(self.system.as_str()));
        m.insert("tools", Value::Array(tools));
        m.insert("messages", Value::Array(self.messages.iter().map(Message::to_value).collect()));
        Value::Object(m)
    }

    pub fn from_value(v: &Value) -> Option<Request> {
        Some(Request {
            system: v.get_str("system")?.to_owned(),
            tools: v
                .get("tools")?
                .as_array()?
                .iter()
                .map(|t| ToolSpec {
                    name: t.get_str("name").unwrap_or_default().to_owned(),
                    description: t.get_str("description").unwrap_or_default().to_owned(),
                    input: t.get("input").cloned().unwrap_or(Value::Null),
                })
                .collect(),
            messages: v.get("messages")?.as_array()?.iter().map(Message::from_value).collect::<Option<_>>()?,
        })
    }
}

/// The wrapper of a hook decision (§9.2).
pub fn hook_wrapper(event: &str, id: &str, decision: &str, text: &str) -> String {
    format!(
        "<hook event=\"{event}\" id=\"{id}\" decision=\"{decision}\">{}</hook>",
        text.replace("</hook>", "&lt;/hook>")
    )
}

/// The wrapper of a delivered interrupt (§9.2).
pub fn interrupt_wrapper(source: &str, text: &str) -> String {
    format!("<interrupt source=\"{source}\">{}</interrupt>", text.replace("</interrupt>", "&lt;/interrupt>"))
}

/// What the model sees of a tool result (§9.3); a failed one through the harness's `tool_error` text, if any.
pub fn result_text(ok: bool, value: &Value, tool_error: Option<&str>) -> String {
    if !ok {
        return match (tool_error, value) {
            (Some(t), Value::String(e)) => fill(t, &[("error", e)]),
            (Some(t), other) => fill(t, &[("error", &canon(other))]),
            (None, v) => {
                let mut m = Map::new();
                m.insert("error", v.clone());
                canon(&Value::Object(m))
            }
        };
    }
    match value {
        Value::String(s) => s.clone(),
        v => canon(v),
    }
}

/// A call's tool message while its log entries are read (§9.3).
#[derive(Default)]
struct Slot {
    call_id: String,
    tool: String,
    modifies: Vec<String>,
    result: Option<String>,
    denied: Option<String>,
    replaced: Option<String>,
    contexts: Vec<String>,
}

/// A message so far, or a tool message still being read. `kept`: a message a `replace_context` kept, which stays as
/// it was (it never merges into the message before it, §9.3).
enum Item {
    Message(Message, bool),
    Slot(usize),
}

fn joined(parts: &[String]) -> String {
    parts.iter().map(|p| format!("\n\n{p}")).collect()
}

/// The messages the items make (§9.3): tool messages built, user contributions in a row merged.
fn messages_of(items: &[Item], slots: &[Slot]) -> Vec<(Message, bool)> {
    let mut messages: Vec<(Message, bool)> = Vec::new();
    for item in items {
        let (message, kept) = match item {
            Item::Slot(i) => {
                let s = &slots[*i];
                let Some(body) = s.denied.as_ref().or(s.replaced.as_ref()).or(s.result.as_ref()) else {
                    continue; // the call never finished
                };
                let text = format!(
                    "{}{body}{}",
                    s.modifies.iter().map(|m| format!("{m}\n")).collect::<String>(),
                    joined(&s.contexts)
                );
                (Message::Tool { call_id: s.call_id.clone(), tool: s.tool.clone(), text }, false)
            }
            Item::Message(m, kept) => (m.clone(), *kept),
        };
        if let (Message::User { text }, false) = (&message, kept) {
            if let Some((Message::User { text: last }, _)) = messages.last_mut() {
                last.push_str("\n\n");
                last.push_str(text);
                continue;
            }
        }
        messages.push((message, kept));
    }
    messages
}

/// The request for the run in `scope` (§9): its system prompt, the harness's tools, the messages of its log.
pub fn render(harness: &Harness, entries: &[Entry], scope: &Scope) -> Request {
    let tool_error = harness.text("tool_error");
    let mut system = String::new();
    let mut items: Vec<Item> = Vec::new();
    let mut slots: Vec<Slot> = Vec::new();
    let mut slot_of: HashMap<String, usize> = HashMap::new();
    let mut user_contexts: Vec<String> = Vec::new();
    let mut interrupt_contexts: Vec<String> = Vec::new();
    let s = |e: &Entry, k: &str| e.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();

    for e in entries.iter().filter(|e| in_scope(e, scope)) {
        match kind(e) {
            "system" => system = s(e, "text"),
            "user" => {
                let text = format!("{}{}", s(e, "text"), joined(&user_contexts));
                items.push(Item::Message(Message::User { text }, false));
                user_contexts.clear();
            }
            "interrupt" => {
                let text =
                    format!("{}{}", interrupt_wrapper(&s(e, "source"), &s(e, "text")), joined(&interrupt_contexts));
                items.push(Item::Message(Message::User { text }, false));
                interrupt_contexts.clear();
            }
            "assistant" => {
                // A call's `malformed` text is the log's record; the request carries what goes back (§9.4).
                let calls: Vec<ToolCall> = e
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(|c| c.iter().map(ToolCall::from_value).collect())
                    .unwrap_or_default();
                let message = Message::Assistant {
                    text: s(e, "text"),
                    tool_calls: calls.clone(),
                    reasoning: e.get("reasoning").and_then(Value::as_str).map(str::to_owned),
                    reasoning_opaque: e.get("reasoning_opaque").cloned(),
                };
                items.push(Item::Message(message, false));
                for c in calls {
                    slots.push(Slot { call_id: c.call_id.clone(), tool: c.tool.clone(), ..Slot::default() });
                    slot_of.insert(c.call_id, slots.len() - 1);
                    items.push(Item::Slot(slots.len() - 1));
                }
            }
            "tool_result" => {
                if let Some(&i) = e.get("call_id").and_then(Value::as_str).and_then(|id| slot_of.get(id)) {
                    slots[i].result = Some(if e.get("ok") == Some(&Value::Bool(true)) {
                        result_text(true, e.get("result").unwrap_or(&Value::Null), None)
                    } else {
                        result_text(false, e.get("error").unwrap_or(&Value::Null), tool_error)
                    });
                }
            }
            "hook" => {
                let event = s(e, "event");
                let decision = s(e, "decision");
                let text = match (decision.as_str(), e.get("text").and_then(Value::as_str)) {
                    ("modify", t) => Some(t.unwrap_or("args changed").to_owned()),
                    (_, t) => t.map(str::to_owned),
                };
                let wrapper = match text {
                    None => String::new(),
                    Some(t) if e.get("wrap") == Some(&Value::Bool(false)) => t,
                    Some(t) => hook_wrapper(&event, &s(e, "hook"), &decision, &t),
                };
                let slot = e.get("call_id").and_then(Value::as_str).and_then(|id| slot_of.get(id)).copied();
                if let Some(i) = slot {
                    let slot = &mut slots[i];
                    match decision.as_str() {
                        "modify" => slot.modifies.push(wrapper),
                        "deny" => slot.denied = Some(wrapper),
                        "replace" => slot.replaced = Some(wrapper),
                        "add_context" => slot.contexts.push(wrapper),
                        _ => {}
                    }
                } else if event == "user_prompt" {
                    match decision.as_str() {
                        "add_context" => user_contexts.push(wrapper),
                        "deny" => user_contexts.clear(),
                        _ => {}
                    }
                } else if event == "interrupt" {
                    match decision.as_str() {
                        "add_context" => interrupt_contexts.push(wrapper),
                        "deny" => interrupt_contexts.clear(),
                        _ => {}
                    }
                } else if event == "pre_request" && decision == "replace_context" {
                    // The newest `keep` messages stay as they were; the text replaces the ones before them.
                    let keep = e.get("keep").and_then(Value::as_f64).unwrap_or(0.0) as usize;
                    let mut next = vec![Item::Message(Message::User { text: wrapper }, false)];
                    if keep > 0 {
                        let messages = messages_of(&items, &slots);
                        let from = messages.len().saturating_sub(keep);
                        next.extend(messages.into_iter().skip(from).map(|(m, _)| Item::Message(m, true)));
                    }
                    items = next;
                } else if (event == "pre_request" || event == "stop")
                    && (decision == "add_context" || decision == "continue")
                {
                    items.push(Item::Message(Message::User { text: wrapper }, false));
                }
            }
            _ => {}
        }
    }

    let messages = messages_of(&items, &slots).into_iter().map(|(m, _)| m).collect();
    let tools = harness
        .tools()
        .map(|declared| {
            declared
                .iter()
                .map(|(name, t)| {
                    let (description, input) = shown_tool(name, t);
                    ToolSpec { name: name.clone(), description, input }
                })
                .collect()
        })
        .unwrap_or_default();
    Request { system, tools, messages }
}
