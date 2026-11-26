//! The harness file (spec §2, §2.1, §3, §5.1, §6, §8.2): checking it, its hash, filling its host values, and
//! reading its parts.
//!
//! A harness stays the JSON value it was read as (the resolved harness, §2), so its hash sees every member; the
//! accessors read its parts.

use crate::schema::{compile_schema, structure};
use crate::value::{canonical, hash, parse_json, ArgumentForm, Map, Value};
use std::sync::OnceLock;

pub use crate::yaml::read_harness;

/// The only spec value this engine runs: a 0.7 engine runs only `harness/0.7` files (spec, Versions).
pub const SPEC: &str = "harness/0.7";

/// The engine's texts (§8.2): each one's name, placeholders and default (`tool_error` has none: §9.3).
pub const TEXTS: [(&str, &[&str], Option<&str>); 4] = [
    ("unknown_tool", &["tool", "args", "args_indented"], Some("invalid arguments: unknown tool")),
    ("invalid_arguments", &["tool", "args", "args_indented", "reasons"], Some("invalid arguments: {reasons}")),
    (
        "malformed_arguments",
        &["tool", "text", "parse_error"],
        Some("invalid arguments: the arguments must be a JSON object"),
    ),
    ("tool_error", &["error"], None),
];

/// The `{name}` placeholders of a template (§8.2), in order, with their byte ranges.
fn placeholders(template: &str) -> Vec<(std::ops::Range<usize>, &str)> {
    let bytes = template.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j].is_ascii_lowercase() || bytes[j] == b'_') {
                j += 1;
            }
            if j > i + 1 && j < bytes.len() && bytes[j] == b'}' {
                out.push((i..j + 1, &template[i + 1..j]));
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// A text of `texts` (or its default) with its placeholders filled in (§8.2); values are not escaped and not read
/// again, and a `{name}` without a value stays as written.
pub fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut at = 0;
    for (range, name) in placeholders(template) {
        if let Some((_, v)) = values.iter().find(|(k, _)| *k == name) {
            out.push_str(&template[at..range.start]);
            out.push_str(v);
            at = range.end;
        }
    }
    out.push_str(&template[at..]);
    out
}

pub const BUILT_INS: [&str; 5] = ["core_called_since", "core_last_result", "core_count", "core_deny", "core_context"];
/// `core_called_since`'s `since` for "since the current turn began" (§6); `@` can't occur in a tool id (§3.1).
pub const TURN: &str = "@turn";

/// The built-in tool `core_spawn` as the model sees it (§10).
pub const SPAWN_DESCRIPTION: &str = "Run a child agent on a subtask. harness: the child's complete harness; it may use only tools and handlers you have. task: its first user message. Returns the child's final text.";

/// `core_spawn`'s fixed input schema (§10).
pub fn spawn_input() -> &'static Value {
    static INPUT: OnceLock<Value> = OnceLock::new();
    INPUT.get_or_init(|| {
        parse_json(r#"{"type":"object","required":["harness","task"],"additionalProperties":false,"properties":{"harness":{"type":"object"},"task":{"type":"string"}}}"#)
            .expect("JSON")
    })
}

/// The events of §4.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Event {
    SessionStart,
    UserPrompt,
    PreRequest,
    PostResponse,
    PreCheck,
    PreTool,
    PostTool,
    Stop,
    Interrupt,
}

impl Event {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "session_start" => Self::SessionStart,
            "user_prompt" => Self::UserPrompt,
            "pre_request" => Self::PreRequest,
            "post_response" => Self::PostResponse,
            "pre_check" => Self::PreCheck,
            "pre_tool" => Self::PreTool,
            "post_tool" => Self::PostTool,
            "stop" => Self::Stop,
            "interrupt" => Self::Interrupt,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::SessionStart => "session_start",
            Self::UserPrompt => "user_prompt",
            Self::PreRequest => "pre_request",
            Self::PostResponse => "post_response",
            Self::PreCheck => "pre_check",
            Self::PreTool => "pre_tool",
            Self::PostTool => "post_tool",
            Self::Stop => "stop",
            Self::Interrupt => "interrupt",
        }
    }
}

/// A hook's `match` (§5.1).
#[derive(Clone, Debug, PartialEq)]
pub enum Match {
    Any,
    One(String),
    List(Vec<String>),
}

impl Match {
    pub fn matches(&self, key: Option<&str>) -> bool {
        match self {
            Match::Any => true,
            Match::One(id) => key == Some(id.as_str()),
            Match::List(ids) => key.is_some_and(|k| ids.iter().any(|id| id == k)),
        }
    }
}

/// A hook of a valid harness (§5.1).
#[derive(Clone, Debug)]
pub struct Hook {
    pub id: String,
    pub on: Event,
    pub matches: Match,
    pub run: String,
    /// `with`, `{}` when the hook has none.
    pub with: Value,
    pub skip_on_failure: bool,
}

/// A harness: the resolved harness document (§2), checked or not.
#[derive(Clone, Debug, PartialEq)]
pub struct Harness(pub Value);

impl Harness {
    /// A harness from its document; `harness_errors` says whether it is valid.
    pub fn new(value: Value) -> Self {
        Harness(value)
    }

    /// Read and check harness text (§2); the reasons if it is invalid.
    pub fn read(text: &str) -> Result<Self, String> {
        let value = read_harness(text)?;
        let errors = harness_errors(&value);
        if errors.is_empty() {
            Ok(Harness(value))
        } else {
            Err(errors.join("; "))
        }
    }

    pub fn value(&self) -> &Value {
        &self.0
    }

    pub fn prompt(&self) -> &str {
        self.0.get_str("prompt").unwrap_or("")
    }

    /// `tools`, in member order (§1).
    pub fn tools(&self) -> Option<&Map> {
        self.0.get("tools").and_then(Value::as_object)
    }

    pub fn tool(&self, id: &str) -> Option<&Value> {
        self.tools().and_then(|t| t.get(id))
    }

    pub fn handlers(&self) -> Option<&Map> {
        self.0.get("handlers").and_then(Value::as_object)
    }

    /// The ids of `tools` in the order the model is offered them (§9): member order (§1).
    pub fn tool_ids(&self) -> Vec<String> {
        self.tools().map(|t| t.keys().cloned().collect()).unwrap_or_default()
    }

    /// The hooks of a valid harness, in declaration order.
    pub fn hooks(&self) -> Vec<Hook> {
        let Some(Value::Array(hooks)) = self.0.get("hooks") else { return Vec::new() };
        hooks
            .iter()
            .map(|h| Hook {
                id: h.get_str("id").unwrap_or_default().to_owned(),
                on: h.get_str("on").and_then(Event::parse).unwrap_or(Event::Stop),
                matches: match h.get("match") {
                    Some(Value::String(s)) if s != "*" => Match::One(s.clone()),
                    Some(Value::Array(ids)) => {
                        Match::List(ids.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                    }
                    _ => Match::Any,
                },
                run: h.get_str("run").unwrap_or_default().to_owned(),
                with: h.get("with").cloned().unwrap_or(Value::Object(Map::new())),
                skip_on_failure: h.get_str("on_failure") == Some("skip"),
            })
            .collect()
    }

    /// A declared limit (§12.1), if the harness sets it.
    pub fn limit(&self, name: &str) -> Option<f64> {
        self.0.get("limits").and_then(|l| l.get(name)).and_then(Value::as_f64)
    }

    /// The harness's wording of one of the engine's texts (§8.2), if it has one.
    pub fn text(&self, name: &str) -> Option<&str> {
        self.0.get("texts").and_then(|t| t.get_str(name))
    }

    /// How a call's arguments go back to the model (§9.4); `model_order` when absent.
    pub fn argument_form(&self) -> ArgumentForm {
        match self.0.get_str("argument_text") {
            Some("sorted_ascii") => ArgumentForm::SortedAscii,
            Some("as_sent") => ArgumentForm::AsSent,
            _ => ArgumentForm::ModelOrder,
        }
    }

    /// `harness_hash` (§2): the hash of the resolved harness with its tool order.
    pub fn hash(&self) -> String {
        harness_hash(&self.0)
    }
}

/// `harness_hash` (§2): `hash([<resolved harness>, <the ids of its tools in member order>])`.
pub fn harness_hash(value: &Value) -> String {
    let ids = Harness(value.clone()).tool_ids().into_iter().map(Value::String).collect();
    hash(&Value::Array(vec![value.clone(), Value::Array(ids)])).expect("a harness with a canonical form")
}

/// A declared tool as the model sees it: `core_spawn` gets its fixed schema and default description.
pub fn shown_tool(id: &str, tool: &Value) -> (String, Value) {
    if id == "core_spawn" {
        return (tool.get_str("description").unwrap_or(SPAWN_DESCRIPTION).to_owned(), spawn_input().clone());
    }
    (
        tool.get_str("description").unwrap_or("").to_owned(),
        tool.get("input").cloned().unwrap_or(Value::Object(Map::new())),
    )
}

/// What is wrong with a harness; empty if it is valid (§2, §3, §5.1, §6, §8.2).
pub fn harness_errors(value: &Value) -> Vec<String> {
    if let Err(e) = canonical(value) {
        return vec![format!("no canonical form (§1): {e}")];
    }
    if !structure().is_valid(value) {
        return structure().errors(value);
    }
    let h = Harness(value.clone());
    let empty = Map::new();
    let tools = h.tools().unwrap_or(&empty);
    let handlers = h.handlers().unwrap_or(&empty);
    let mut errors = Vec::new();

    for id in handlers.keys() {
        if tools.contains_key(id) {
            errors.push(format!("{id}: declared as a tool and as a handler"));
        }
    }
    let mut schemas: Vec<(String, &Value)> = Vec::new();
    for (id, t) in tools.iter() {
        for k in ["input", "output"] {
            if let Some(s) = t.get(k) {
                schemas.push((format!("tools.{id}.{k}"), s));
            }
        }
    }
    for (id, x) in handlers.iter() {
        if let Some(s) = x.get("input") {
            schemas.push((format!("handlers.{id}.input"), s));
        }
    }
    for (place, schema) in schemas {
        if let Err(e) = compile_schema(schema) {
            errors.push(format!("{place}: {e}"));
        }
    }

    let mut hook_ids: Vec<&str> = Vec::new();
    let Some(Value::Array(hooks)) = value.get("hooks") else {
        return errors_with_texts(&h, errors);
    };
    for hook in hooks {
        let id = hook.get_str("id").unwrap_or_default();
        let run = hook.get_str("run").unwrap_or_default();
        if hook_ids.contains(&id) {
            errors.push(format!("hook {id}: id is not unique"));
        }
        hook_ids.push(id);
        let built_in = BUILT_INS.contains(&run);
        if !built_in && !handlers.contains_key(run) {
            errors.push(format!("hook {id}: {run} is not a declared handler or a built-in"));
        }
        let mut refs: Vec<&Value> = Vec::new();
        if matches!(hook.get_str("on"), Some("pre_check" | "pre_tool" | "post_tool")) {
            match hook.get("match") {
                Some(Value::String(s)) if s == "*" => {}
                Some(Value::Array(ids)) => refs.extend(ids),
                Some(m) => refs.push(m),
                None => {}
            }
        }
        if built_in {
            let with = hook.get("with");
            match with.and_then(|w| w.get("tool")) {
                Some(Value::Array(ids)) => refs.extend(ids),
                Some(t) => refs.push(t),
                None => {}
            }
            if let Some(since) = with.and_then(|w| w.get("since")) {
                if since.as_str() != Some(TURN) {
                    refs.push(since);
                }
            }
        }
        for r in refs {
            if let Some(tid) = r.as_str() {
                if !tools.contains_key(tid) {
                    errors.push(format!("hook {id}: {tid} is not a declared tool"));
                }
            }
        }
    }
    errors_with_texts(&h, errors)
}

/// The standard host values (§2.1); a file declares any other name it uses in `host_values`.
pub const STANDARD_VALUES: [&str; 8] = ["CWD", "HOME", "DATE", "YEAR", "TIMEZONE", "OS", "MODEL", "PROVIDER"];

/// `${NAME}` at byte `i` of `text` (which starts there with `${`): the name and the end of the placeholder.
fn placeholder_at(text: &str, i: usize) -> Option<(&str, usize)> {
    let rest = text.get(i + 2..)?;
    let bytes = rest.as_bytes();
    if !bytes.first().is_some_and(u8::is_ascii_uppercase) {
        return None;
    }
    let mut j = 1;
    while j < bytes.len() && (bytes[j].is_ascii_uppercase() || bytes[j].is_ascii_digit() || bytes[j] == b'_') {
        j += 1;
    }
    (bytes.get(j) == Some(&b'}')).then(|| (&rest[..j], i + 2 + j + 1))
}

/// Whether a paragraph ends at byte `i`: the text ends there, or a blank line follows.
fn paragraph_ends(text: &str, i: usize) -> bool {
    i == text.len() || text[i..].starts_with("\n\n")
}

/// One text filled in the three steps of §2.1.
fn fill_text(text: &str, value: &dyn Fn(&str) -> Result<String, String>) -> Result<String, String> {
    // 1. Blocks: `\n\n${if NAME}\n` body `\n${end}` at the end of a paragraph, the shortest body.
    let mut out = String::new();
    let (mut copied, mut i) = (0, 0);
    while let Some(off) = text[i..].find("\n\n${if ") {
        let start = i + off;
        let name_at = start + "\n\n${if ".len();
        let name_len = text[name_at..]
            .bytes()
            .enumerate()
            .take_while(|(k, b)| {
                if *k == 0 {
                    b.is_ascii_uppercase()
                } else {
                    b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_'
                }
            })
            .count();
        let body_at = name_at + name_len + 2;
        if name_len == 0 || !text[name_at + name_len..].starts_with("}\n") {
            i = start + 1;
            continue;
        }
        let mut end = None;
        let mut k = body_at;
        while let Some(off) = text.get(k..).and_then(|t| t.find("\n${end}")) {
            let j = k + off;
            if paragraph_ends(text, j + "\n${end}".len()) {
                end = Some(j);
                break;
            }
            k = j + 1;
        }
        let Some(j) = end else {
            i = start + 1;
            continue;
        };
        out.push_str(&text[copied..start]);
        if !value(&text[name_at..name_at + name_len])?.is_empty() {
            out.push_str("\n\n");
            out.push_str(&text[body_at..j]);
        }
        copied = j + "\n${end}".len();
        i = copied;
    }
    out.push_str(&text[copied..]);
    // 2. Slots: a paragraph that is only `${NAME}` disappears when its value is empty.
    let text = out;
    let mut out = String::new();
    let (mut copied, mut i) = (0, 0);
    while let Some(off) = text[i..].find("\n\n${") {
        let start = i + off;
        match placeholder_at(&text, start + 2) {
            Some((name, end)) if paragraph_ends(&text, end) => {
                if value(name)?.is_empty() {
                    out.push_str(&text[copied..start]);
                    copied = end;
                }
                i = end;
            }
            _ => i = start + 1,
        }
    }
    out.push_str(&text[copied..]);
    // 3. Placeholders, and `$${` as `${`, in one pass from left to right; values are not read again.
    let text = out;
    let mut out = String::new();
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if rest.starts_with("$${") {
            out.push_str("${");
            i += 3;
            continue;
        }
        if rest.starts_with("${") {
            if let Some((name, end)) = placeholder_at(&text, i) {
                out.push_str(&value(name)?);
                i = end;
                continue;
            }
            if rest.starts_with("${if ") || rest.starts_with("${end}") {
                return Err("${if …} or ${end} outside a block".into());
            }
        }
        let c = rest.chars().next().expect("a character");
        out.push(c);
        i += c.len_utf8();
    }
    Ok(out)
}

/// The harness with its host values filled in (§2.1): `prompt` and every tool's `description`. Fails for a load
/// error: a name neither standard nor declared, a name without a value, a value that isn't a string, or `${if …}` /
/// `${end}` outside a block. The harness itself is checked by `harness_errors`, not here.
pub fn fill_host_values(harness: &Value, values: &Map) -> Result<Value, String> {
    let declared: Vec<&str> =
        harness.get("host_values").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let value = |name: &str| -> Result<String, String> {
        if !STANDARD_VALUES.contains(&name) && !declared.contains(&name) {
            return Err(format!("${{{name}}} is neither a standard host value nor declared in host_values"));
        }
        match values.get(name) {
            None => Err(format!("no value for ${{{name}}}")),
            Some(Value::String(v)) => Ok(v.clone()),
            Some(_) => Err(format!("the value of ${{{name}}} is not a string")),
        }
    };
    let mut out = harness.clone();
    let Some(m) = out.as_object_mut() else { return Ok(out) };
    if let Some(Value::String(prompt)) = m.get("prompt") {
        let filled = fill_text(prompt, &value)?;
        m.insert("prompt", Value::String(filled));
    }
    if let Some(Value::Object(tools)) = m.get_mut("tools") {
        let ids: Vec<String> = tools.keys().cloned().collect();
        for id in ids {
            if let Some(Value::Object(t)) = tools.get_mut(&id) {
                if let Some(Value::String(d)) = t.get("description") {
                    let filled = fill_text(d, &value)?;
                    t.insert("description", Value::String(filled));
                }
            }
        }
    }
    Ok(out)
}

fn errors_with_texts(h: &Harness, mut errors: Vec<String>) -> Vec<String> {
    if let Some(Value::Object(texts)) = h.0.get("texts") {
        for (name, template) in texts.iter() {
            let allowed = TEXTS.iter().find(|(n, _, _)| n == name).map_or(&[][..], |(_, p, _)| p);
            for (_, placeholder) in placeholders(template.as_str().unwrap_or("")) {
                if !allowed.contains(&placeholder) {
                    errors.push(format!("texts.{name}: {{{placeholder}}} is not one of its placeholders"));
                }
            }
        }
    }
    errors
}
