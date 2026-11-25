//! OpenAI-compatible Chat Completions mapping (host side, spec §9, §13): the neutral request to the API body, the
//! API's answer back to a model response. Texts pass through unchanged; tools keep their ids; calls keep the
//! provider's ids and go back with their argument text (§9.4). The twin of `engines/ts/src/openai.ts`;
//! `conformance/openai.json` pins all three. The HTTP transport is the host's: post `to_chat`'s body to
//! `<base>/chat/completions` and hand the parsed answer to `from_chat`.

use crate::engine::HostError;
use crate::render::{Message, Request};
use crate::value::{parse_json, Map, Value};

/// Which logged reasoning an adapter sends back (§9).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ReasoningReplay {
    None,
    /// What providers ask for within a tool loop: the default (§9).
    #[default]
    Turn,
    All,
}

impl ReasoningReplay {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "none" => Ok(Self::None),
            "turn" => Ok(Self::Turn),
            "all" => Ok(Self::All),
            other => Err(format!("reasoning_replay must be one of none, turn, all (not {other:?})")),
        }
    }
}

fn s(text: &str) -> Value {
    Value::from(text)
}

/// The Chat Completions body for a neutral request. `replay` says which logged reasoning goes back as
/// `reasoning_content` (§9): none, the current turn's (after the last user message), or all of it.
pub fn to_chat(request: &Request, model: &str, extra: &Map, replay: ReasoningReplay) -> Value {
    let last_user = request.messages.iter().rposition(|m| matches!(m, Message::User { .. }));
    let mut messages = Vec::new();
    if !request.system.is_empty() {
        let mut m = Map::new();
        m.insert("role", s("system"));
        m.insert("content", s(&request.system));
        messages.push(Value::Object(m));
    }
    for (i, message) in request.messages.iter().enumerate() {
        let mut m = Map::new();
        match message {
            Message::User { text } => {
                m.insert("role", s("user"));
                m.insert("content", s(text));
            }
            Message::Assistant { text, tool_calls, reasoning, .. } => {
                m.insert("role", s("assistant"));
                m.insert("content", if !text.is_empty() || tool_calls.is_empty() { s(text) } else { Value::Null });
                if !tool_calls.is_empty() {
                    let calls = tool_calls
                        .iter()
                        .map(|c| {
                            let mut f = Map::new();
                            f.insert("name", s(&c.tool));
                            f.insert("arguments", Value::from(c.text()));
                            let mut call = Map::new();
                            call.insert("id", s(&c.call_id));
                            call.insert("type", s("function"));
                            call.insert("function", Value::Object(f));
                            Value::Object(call)
                        })
                        .collect();
                    m.insert("tool_calls", Value::Array(calls));
                }
                let in_turn = last_user.is_none_or(|u| i > u);
                if let Some(r) = reasoning.as_ref().filter(|r| !r.is_empty()) {
                    if replay == ReasoningReplay::All || (replay == ReasoningReplay::Turn && in_turn) {
                        m.insert("reasoning_content", s(r));
                    }
                }
            }
            Message::Tool { call_id, text, .. } => {
                m.insert("role", s("tool"));
                m.insert("tool_call_id", s(call_id));
                m.insert("content", s(text));
            }
        }
        messages.push(Value::Object(m));
    }
    let mut body = Map::new();
    body.insert("model", s(model));
    body.insert("messages", Value::Array(messages));
    if !request.tools.is_empty() {
        let tools = request
            .tools
            .iter()
            .map(|t| {
                let mut f = Map::new();
                f.insert("name", s(&t.name));
                f.insert("description", s(&t.description));
                f.insert("parameters", t.input.clone());
                let mut tool = Map::new();
                tool.insert("type", s("function"));
                tool.insert("function", Value::Object(f));
                Value::Object(tool)
            })
            .collect();
        body.insert("tools", Value::Array(tools));
    }
    for (k, v) in extra.iter() {
        body.insert(k.clone(), v.clone());
    }
    Value::Object(body)
}

/// The model response (spec §14 shape) for a Chat Completions answer; an answer without a message is an
/// infrastructure failure.
pub fn from_chat(body: &Value, provider: &str) -> Result<Value, HostError> {
    let message = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|first| first.get("message"))
        .filter(|m| m.as_object().is_some())
        .ok_or_else(|| HostError::Infra("the answer has no message".into()))?;
    let mut out = Map::new();
    out.insert("text", s(message.get_str("content").unwrap_or("")));
    let mut calls = Vec::new();
    for c in message.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
        let empty = Value::Object(Map::new());
        let f = c.get("function").filter(|f| f.as_object().is_some()).unwrap_or(&empty);
        let mut call = Map::new();
        if let Some(name) = f.get("name") {
            call.insert("tool", name.clone());
        }
        if let Some(id) = c.get_str("id").filter(|id| !id.is_empty()) {
            call.insert("call_id", s(id)); // the provider's id (§7)
        }
        match f.get("arguments") {
            None | Some(Value::Null) => call.insert("args", Value::Object(Map::new())),
            Some(Value::String(raw)) if raw.is_empty() => call.insert("args", Value::Object(Map::new())),
            Some(Value::String(raw)) => match parse_json(raw) {
                Ok(args) => {
                    call.insert("args", args);
                    call.insert("raw", s(raw)); // the model's text, for a `sorted_ascii` harness (§9.4)
                }
                // JSON with a lone surrogate has no canonical form (§1): the response breaks the interface, as it
                // does in the other engines once they read it.
                Err(e) if e.0.contains("lone surrogate") => {
                    return Err(HostError::Infra("arguments with a lone surrogate".into()))
                }
                Err(_) => call.insert("malformed", s(raw)), // not JSON: the engine's malformed_arguments (§8.2)
            },
            Some(other) => call.insert("args", other.clone()),
        }
        calls.push(Value::Object(call));
    }
    if !calls.is_empty() {
        out.insert("tool_calls", Value::Array(calls));
    }
    let reasoning = match message.get("reasoning_content") {
        Some(r) if r.truthy() => Some(r),
        _ => message.get("reasoning"),
    };
    if let Some(Value::String(r)) = reasoning.filter(|r| r.truthy()) {
        out.insert("reasoning", s(r));
    }
    if let Some(details) = message.get("reasoning_details").filter(|d| d.truthy()) {
        let mut o = Map::new();
        o.insert("provider", s(provider));
        o.insert("data", details.clone());
        out.insert("reasoning_opaque", Value::Object(o));
    }
    if let Some(usage) = body.get("usage").filter(|u| u.as_object().is_some()) {
        out.insert("usage", usage.clone()); // the provider's report, for hooks (§5.3)
    }
    Ok(Value::Object(out))
}
