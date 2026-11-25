//! Reading a harness file (spec §2): YAML 1.2, core schema, duplicate keys an error; JSON is read as YAML.
//!
//! `saphyr-parser` gives the YAML 1.2 event stream; this module builds the JSON value from it with the core schema's
//! resolution (the same as the TypeScript `yaml` package and the Python engine's loader), and checks what the parser
//! leaves to its caller: the `%YAML` version, one document, string keys only, no duplicate keys, no tag outside the
//! core schema, no alias inside its own anchor, finite numbers only.

use crate::value::{Map, Value};
use saphyr_parser::{Event, Parser, ScalarStyle, ScanError, Tag};
use std::collections::HashMap;

/// Harness text as a JSON value: YAML 1.2 core schema, JSON read as YAML (§2).
pub fn read_harness(text: &str) -> Result<Value, String> {
    check_directives(text)?;
    let mut source = text.to_owned();
    loop {
        match events(&source) {
            Ok(events) => return Builder::new(events).document(),
            Err(e) => match join_surrogate_escapes(&source, &e) {
                // YAML writes a character above U+FFFF as two \u escapes, as JSON does; the parser reads each
                // escape alone. Such pairs in the scalar the parser stopped at are joined into one \U escape.
                Some(fixed) => source = fixed,
                None => return Err(format!("{} at line {}", e.info(), e.marker().line())),
            },
        }
    }
}

/// Only YAML 1.2 is supported: a `%YAML` directive with another version is an error, as in the other engines.
fn check_directives(text: &str) -> Result<(), String> {
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(directive) = line.strip_prefix('%') else { break };
        let mut words = directive.split_whitespace();
        if words.next() == Some("YAML") && words.next() != Some("1.2") {
            return Err("only YAML 1.2 is supported".into());
        }
    }
    Ok(())
}

fn events(text: &str) -> Result<Vec<Event<'static>>, ScanError> {
    let mut parser = Parser::new_from_str(text);
    let mut out = Vec::new();
    while let Some(event) = parser.next_event() {
        let (event, _) = event?;
        out.push(into_owned(event));
    }
    Ok(out)
}

fn into_owned(event: Event<'_>) -> Event<'static> {
    use std::borrow::Cow;
    let tag = |t: Option<Cow<'_, Tag>>| t.map(|t| Cow::Owned(t.into_owned()));
    match event {
        Event::Nothing => Event::Nothing,
        Event::StreamStart => Event::StreamStart,
        Event::StreamEnd => Event::StreamEnd,
        Event::DocumentStart(explicit) => Event::DocumentStart(explicit),
        Event::DocumentEnd => Event::DocumentEnd,
        Event::Alias(id) => Event::Alias(id),
        Event::Scalar(v, style, anchor, t) => Event::Scalar(Cow::Owned(v.into_owned()), style, anchor, tag(t)),
        Event::SequenceStart(anchor, t) => Event::SequenceStart(anchor, tag(t)),
        Event::SequenceEnd => Event::SequenceEnd,
        Event::MappingStart(anchor, t) => Event::MappingStart(anchor, tag(t)),
        Event::MappingEnd => Event::MappingEnd,
    }
}

/// If the parser stopped at a `\u` escape of a surrogate inside a double-quoted scalar, the text with that scalar's
/// surrogate pairs (`😀`) written as single escapes (`\U0001F600`); `None` if there is none to join (a
/// lone surrogate, which has no canonical form, §1).
fn join_surrogate_escapes(text: &str, e: &ScanError) -> Option<String> {
    if !e.info().contains("invalid Unicode character escape code") {
        return None;
    }
    let (start, _) = text.char_indices().nth(e.marker().index())?;
    let open = start + text[start..].find('"')?;
    let bytes = text.as_bytes();
    let hex = |at: usize| -> Option<u32> {
        let h = text.get(at..at + 4)?;
        h.bytes().all(|b| b.is_ascii_hexdigit()).then(|| u32::from_str_radix(h, 16).ok())?
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..=open]);
    let mut i = open + 1;
    let mut joined = false;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => break,
            b'\\' if bytes.get(i + 1) == Some(&b'u') => {
                if let (Some(high @ 0xD800..=0xDBFF), true) = (hex(i + 2), text[i + 6..].starts_with("\\u")) {
                    if let Some(low @ 0xDC00..=0xDFFF) = hex(i + 8) {
                        let c = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                        out.push_str(&format!("\\U{c:08X}"));
                        i += 12;
                        joined = true;
                        continue;
                    }
                }
                out.push_str("\\u");
                i += 2;
            }
            b'\\' => {
                let next = text[i + 1..].chars().next().map_or(0, char::len_utf8);
                out.push_str(&text[i..i + 1 + next]);
                i += 1 + next;
            }
            _ => {
                let len = text[i..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&text[i..i + len]);
                i += len;
            }
        }
    }
    out.push_str(&text[i..]);
    joined.then_some(out)
}

enum Anchor {
    Building,
    Done(Value),
}

struct Builder {
    events: std::vec::IntoIter<Event<'static>>,
    anchors: HashMap<usize, Anchor>,
}

const YAML_TAG: &str = "tag:yaml.org,2002:";

impl Builder {
    fn new(events: Vec<Event<'static>>) -> Self {
        Self { events: events.into_iter(), anchors: HashMap::new() }
    }

    fn next(&mut self) -> Result<Event<'static>, String> {
        self.events.next().ok_or_else(|| "unexpected end of the YAML events".to_owned())
    }

    /// The one document of the stream; an empty stream is `null`.
    fn document(mut self) -> Result<Value, String> {
        let mut value = None;
        loop {
            match self.next()? {
                Event::StreamStart | Event::Nothing | Event::DocumentEnd => {}
                Event::StreamEnd => return Ok(value.unwrap_or(Value::Null)),
                Event::DocumentStart(_) => {
                    if value.is_some() {
                        return Err("the source contains more than one document".into());
                    }
                    let first = self.next()?;
                    value = Some(self.node(first, 0)?);
                }
                _ => return Err("unexpected YAML event".into()),
            }
        }
    }

    fn node(&mut self, event: Event<'static>, depth: usize) -> Result<Value, String> {
        if depth > 1000 {
            return Err("YAML nested too deeply".into());
        }
        match event {
            Event::Alias(id) => match self.anchors.get(&id) {
                Some(Anchor::Done(v)) => Ok(v.clone()),
                Some(Anchor::Building) => Err("an alias inside its own anchor".into()),
                None => Err("an alias without an anchor".into()),
            },
            Event::Scalar(text, style, anchor, tag) => {
                let v = scalar(&text, style, tag.as_deref())?;
                self.anchor(anchor, &v);
                Ok(v)
            }
            Event::SequenceStart(anchor, tag) => {
                collection_tag(tag.as_deref(), "seq")?;
                if anchor > 0 {
                    self.anchors.insert(anchor, Anchor::Building);
                }
                let mut items = Vec::new();
                loop {
                    match self.next()? {
                        Event::SequenceEnd => break,
                        e => items.push(self.node(e, depth + 1)?),
                    }
                }
                let v = Value::Array(items);
                self.anchor(anchor, &v);
                Ok(v)
            }
            Event::MappingStart(anchor, tag) => {
                collection_tag(tag.as_deref(), "map")?;
                if anchor > 0 {
                    self.anchors.insert(anchor, Anchor::Building);
                }
                let mut map = Map::new();
                loop {
                    let key = match self.next()? {
                        Event::MappingEnd => break,
                        e => self.node(e, depth + 1)?,
                    };
                    let Value::String(key) = key else {
                        return Err("a mapping key is not a string".into());
                    };
                    if map.contains_key(&key) {
                        return Err(format!("duplicate key {key:?}"));
                    }
                    let e = self.next()?;
                    let v = self.node(e, depth + 1)?;
                    map.insert(key, v);
                }
                let v = Value::Object(map);
                self.anchor(anchor, &v);
                Ok(v)
            }
            _ => Err("unexpected YAML event".into()),
        }
    }

    fn anchor(&mut self, anchor: usize, v: &Value) {
        if anchor > 0 {
            self.anchors.insert(anchor, Anchor::Done(v.clone()));
        }
    }
}

fn full_tag(tag: &Tag) -> String {
    format!("{}{}", tag.handle, tag.suffix)
}

fn collection_tag(tag: Option<&Tag>, kind: &str) -> Result<(), String> {
    match tag.map(full_tag) {
        None => Ok(()),
        Some(t) if t == "!" || t == format!("{YAML_TAG}{kind}") => Ok(()),
        Some(t) => Err(format!("tag {t} is not in the YAML 1.2 core schema")),
    }
}

/// A scalar as the core schema reads it: a tag decides, else a quoted or block scalar is a string, else the plain
/// scalar's form (null, bool, int, float, string).
fn scalar(text: &str, style: ScalarStyle, tag: Option<&Tag>) -> Result<Value, String> {
    if let Some(tag) = tag {
        let t = full_tag(tag);
        let kind = t.strip_prefix(YAML_TAG);
        return match (t.as_str(), kind) {
            ("!", _) | (_, Some("str")) => Ok(Value::String(text.to_owned())),
            (_, Some("null")) if is_null(text) => Ok(Value::Null),
            (_, Some("bool")) if is_bool(text) => Ok(Value::Bool(text.starts_with(['t', 'T']))),
            (_, Some("int")) if is_int(text) => int(text),
            (_, Some("float")) if is_not_finite(text) => Err("infinity and NaN are not JSON".into()),
            (_, Some("float")) if is_float(text) => float(text),
            (_, Some("null" | "bool" | "int" | "float")) => Err(format!("{text:?} is not a valid {t}")),
            _ => Err(format!("tag {t} is not in the YAML 1.2 core schema")),
        };
    }
    if style != ScalarStyle::Plain {
        return Ok(Value::String(text.to_owned()));
    }
    if is_null(text) {
        Ok(Value::Null)
    } else if is_bool(text) {
        Ok(Value::Bool(text.starts_with(['t', 'T'])))
    } else if is_int(text) {
        int(text)
    } else if is_not_finite(text) {
        Err("infinity and NaN are not JSON".into())
    } else if is_float(text) {
        float(text)
    } else {
        Ok(Value::String(text.to_owned()))
    }
}

fn is_null(s: &str) -> bool {
    matches!(s, "" | "~" | "null" | "Null" | "NULL")
}

fn is_bool(s: &str) -> bool {
    matches!(s, "true" | "True" | "TRUE" | "false" | "False" | "FALSE")
}

fn all(s: &str, f: impl Fn(u8) -> bool) -> bool {
    !s.is_empty() && s.bytes().all(f)
}

/// `0o[0-7]+`, `[-+]?[0-9]+` or `0x[0-9a-fA-F]+`.
fn is_int(s: &str) -> bool {
    if let Some(d) = s.strip_prefix("0o") {
        return all(d, |b| (b'0'..=b'7').contains(&b));
    }
    if let Some(d) = s.strip_prefix("0x") {
        return all(d, |b| b.is_ascii_hexdigit());
    }
    all(s.strip_prefix(['-', '+']).unwrap_or(s), |b| b.is_ascii_digit())
}

/// `[-+]?(\.[0-9]+|[0-9]+\.[0-9]*)([eE][-+]?[0-9]+)?` or `[-+]?[0-9]+[eE][-+]?[0-9]+`: a float needs a `.` or an
/// exponent, as in the TypeScript `yaml` package (there `!!float 1` is an error).
fn is_float(s: &str) -> bool {
    let s = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(at) => (&s[..at], Some(&s[at + 1..])),
        None => (s, None),
    };
    if let Some(e) = exponent {
        if !all(e.strip_prefix(['-', '+']).unwrap_or(e), |b| b.is_ascii_digit()) {
            return false;
        }
    }
    match mantissa.split_once('.') {
        Some((whole, frac)) => {
            whole.bytes().all(|b| b.is_ascii_digit())
                && frac.bytes().all(|b| b.is_ascii_digit())
                && (!whole.is_empty() || !frac.is_empty())
        }
        None => exponent.is_some() && all(mantissa, |b| b.is_ascii_digit()),
    }
}

fn is_not_finite(s: &str) -> bool {
    let unsigned = s.strip_prefix(['-', '+']).unwrap_or(s);
    matches!(unsigned, ".inf" | ".Inf" | ".INF") || matches!(s, ".nan" | ".NaN" | ".NAN")
}

/// An integer as the double an engine reads (§1).
fn int(s: &str) -> Result<Value, String> {
    let n = if let Some(d) = s.strip_prefix("0o") {
        radix(d, 8)
    } else if let Some(d) = s.strip_prefix("0x") {
        radix(d, 16)
    } else {
        s.parse::<f64>().map_err(|e| e.to_string())?
    };
    finite(n)
}

fn radix(digits: &str, base: u32) -> f64 {
    match u128::from_str_radix(digits, base) {
        Ok(n) => n as f64,
        Err(_) => digits.chars().fold(0.0, |acc, c| acc * f64::from(base) + f64::from(c.to_digit(base).unwrap_or(0))),
    }
}

fn float(s: &str) -> Result<Value, String> {
    finite(s.parse::<f64>().map_err(|e| e.to_string())?)
}

fn finite(n: f64) -> Result<Value, String> {
    if n.is_finite() {
        Ok(Value::Number(n))
    } else {
        Err(format!("{n} is not a finite number"))
    }
}
