//! JSON Schema 2020-12 for tool and handler schemas (spec §3.2), and why arguments fail (§8.1).
//!
//! Validation is the `jsonschema` crate's, built without network access (a `$ref` to anything but the bundled
//! meta-schemas doesn't resolve) and with ECMA-262 patterns, which it translates for Rust's regex engines (`.`
//! excludes line terminators, `\d` `\w` are ASCII, `\s` is ECMAScript's whitespace; `$` is the end of input there).

use crate::value::{canon, utf16_order, Map, Value};
use std::sync::OnceLock;

/// A compiled schema: whether a value fits it.
pub struct Check(jsonschema::Validator);

impl Check {
    pub fn is_valid(&self, value: &Value) -> bool {
        self.0.is_valid(&to_serde(value))
    }

    /// Why a value doesn't fit the schema: one line per error, `<instance path>: <message>`.
    pub fn errors(&self, value: &Value) -> Vec<String> {
        let instance = to_serde(value);
        self.0
            .iter_errors(&instance)
            .map(|e| {
                let path = e.instance_path().to_string();
                format!("{}: {e}", if path.is_empty() { "/" } else { &path })
            })
            .collect()
    }
}

impl std::fmt::Debug for Check {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Check")
    }
}

/// Compile a schema. Fails if it doesn't compile (invalid against the 2020-12 meta-schema, an unresolvable `$ref`,
/// an invalid `pattern`, …); nothing is fetched over the network.
pub fn compile_schema(schema: &Value) -> Result<Check, String> {
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .offline()
        .with_keyword("multipleOf", |_, value, _| {
            Ok(Box::new(MultipleOf(value.as_f64().unwrap_or(1.0))) as Box<dyn for<'i> jsonschema::Keyword<'i>>)
        })
        .build(&to_serde(&translated(schema)))
        .map(Check)
        .map_err(|e| e.to_string())
}

/// `multipleOf` as Ajv and Python's `jsonschema` decide it: the quotient of the two doubles is an integer. (The
/// validator's own keyword divides exactly, so `0.3` would be a multiple of `0.1`; for the other engines it isn't.)
struct MultipleOf(f64);

impl MultipleOf {
    fn fits(&self, instance: &serde_json::Value) -> bool {
        instance.as_f64().is_none_or(|x| {
            let q = x / self.0;
            q.is_finite() && q.fract() == 0.0
        })
    }
}

impl<'i> jsonschema::Keyword<'i> for MultipleOf {
    fn validate(&self, instance: &'i serde_json::Value) -> Result<(), jsonschema::ValidationError<'i>> {
        if self.fits(instance) {
            Ok(())
        } else {
            Err(jsonschema::ValidationError::custom(format!("{instance} is not a multiple of {}", self.0)))
        }
    }

    fn is_valid(&self, instance: &'i serde_json::Value) -> bool {
        self.fits(instance)
    }
}

const SCHEMA_MAPS: [&str; 4] = ["properties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_LISTS: [&str; 4] = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_ONE: [&str; 11] = [
    "additionalProperties",
    "unevaluatedProperties",
    "items",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "unevaluatedItems",
    "contentSchema",
];

/// The schema with every regular expression's `\b` and `\B` made ASCII, as ECMA-262 has them (§3.2); data inside
/// `const` and `enum` is untouched. The validator's own translation leaves them Unicode-aware (and rejects `[\b]`).
fn translated(schema: &Value) -> Value {
    let Value::Object(m) = schema else { return schema.clone() };
    let mut out = Map::new();
    for (k, v) in m.iter() {
        let v = match (k.as_str(), v) {
            ("pattern", Value::String(p)) => Value::String(ecma_pattern(p)),
            ("patternProperties", Value::Object(ps)) => {
                Value::Object(ps.iter().map(|(p, s)| (ecma_pattern(p), translated(s))).collect())
            }
            (k, Value::Object(ss)) if SCHEMA_MAPS.contains(&k) => {
                Value::Object(ss.iter().map(|(n, s)| (n.clone(), translated(s))).collect())
            }
            (k, Value::Array(ss)) if SCHEMA_LISTS.contains(&k) => Value::Array(ss.iter().map(translated).collect()),
            (k, v) if SCHEMA_ONE.contains(&k) => translated(v),
            (_, v) => v.clone(),
        };
        out.insert(k.clone(), v);
    }
    Value::Object(out)
}

/// An ECMA-262 pattern written so that the validator reads it as ECMA-262 does (§3.2): `\b` and `\B` outside
/// character classes as lookarounds over ASCII word characters (the validator's are Unicode-aware); and what its own
/// check of a pattern wrongly rejects in other words: `\b` in a class (a backspace) and `\0` (NUL) as `\x08` and
/// `\x00`, the empty class `[]` as `(?!)` and its complement `[^]` as `[\s\S]`.
fn ecma_pattern(pattern: &str) -> String {
    const W: &str = "[A-Za-z0-9_]";
    let mut out = String::with_capacity(pattern.len());
    let mut chars = pattern.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('b') if !in_class => out.push_str(&format!("(?:(?<={W})(?!{W})|(?<!{W})(?={W}))")),
                Some('B') if !in_class => out.push_str(&format!("(?:(?<={W})(?={W})|(?<!{W})(?!{W}))")),
                Some('b') => out.push_str("\\x08"),
                Some('0') if !chars.peek().is_some_and(char::is_ascii_digit) => out.push_str("\\x00"),
                Some(e) => {
                    out.push('\\');
                    out.push(e);
                }
                None => out.push('\\'),
            },
            '[' if !in_class => {
                let rest: String = chars.clone().take(2).collect();
                if rest.starts_with(']') {
                    chars.next();
                    out.push_str("(?!)");
                } else if rest == "^]" {
                    chars.next();
                    chars.next();
                    out.push_str("[\\s\\S]");
                } else {
                    in_class = true;
                    out.push(c);
                }
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}

/// The structure check of a harness file (§2): `schema/harness.v0.6.json`, with the 2020-12 meta-schema for the
/// schemas it holds.
pub fn structure() -> &'static Check {
    static STRUCTURE: OnceLock<Check> = OnceLock::new();
    STRUCTURE.get_or_init(|| {
        let text = include_str!("../../../schema/harness.v0.6.json");
        let schema = crate::value::parse_json(text).expect("the harness schema is JSON");
        compile_schema(&schema).expect("the harness schema compiles")
    })
}

/// A value for the validator. Numbers are doubles (§1): integral ones go as integers where they fit, so `1.0` and
/// `1` are the same to `type`, `const` and `enum`.
pub fn to_serde(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => serde_json::Value::Bool(*b),
        Value::Number(n) => {
            let n = *n;
            if n.fract() == 0.0 && n.abs() < 9.2e18 {
                serde_json::Value::from(n as i64)
            } else if n.fract() == 0.0 && (0.0..1.8e19).contains(&n) {
                serde_json::Value::from(n as u64)
            } else {
                serde_json::Number::from_f64(n).map_or(serde_json::Value::Null, serde_json::Value::Number)
            }
        }
        Value::String(s) => serde_json::Value::String(s.clone()),
        Value::Array(items) => serde_json::Value::Array(items.iter().map(to_serde).collect()),
        Value::Object(map) => serde_json::Value::Object(map.iter().map(|(k, v)| (k.clone(), to_serde(v))).collect()),
    }
}

/// Whether a string matches an ECMA-262 pattern, as the validator reads it (§3.2).
fn pattern_matches(pattern: &str, s: &str) -> bool {
    let mut schema = Map::new();
    schema.insert("pattern", Value::String(pattern.to_owned()));
    compile_schema(&Value::Object(schema)).map_or(true, |c| c.is_valid(&Value::String(s.to_owned())))
}

fn type_name(t: &str) -> &str {
    match t {
        "string" => "a string",
        "integer" => "an integer",
        "number" => "a number",
        "boolean" => "a boolean",
        "object" => "an object",
        "array" => "an array",
        "null" => "null",
        other => other,
    }
}

fn has_type(v: &Value, t: &str) -> bool {
    match t {
        "string" => matches!(v, Value::String(_)),
        "integer" => matches!(v, Value::Number(n) if n.fract() == 0.0),
        "number" => matches!(v, Value::Number(_)),
        "boolean" => matches!(v, Value::Bool(_)),
        "object" => matches!(v, Value::Object(_)),
        "array" => matches!(v, Value::Array(_)),
        "null" => matches!(v, Value::Null),
        _ => false,
    }
}

/// The first row of §8.1's table that the value fails, or `None`.
fn member_reason(p: &Value, v: &Value) -> Option<String> {
    if p == &Value::Bool(false) {
        return Some("not allowed".into());
    }
    let p = p.as_object()?;
    let types: Option<Vec<String>> = match p.get("type") {
        Some(Value::String(t)) => Some(vec![t.clone()]),
        Some(Value::Array(ts)) => Some(ts.iter().map(display_type).collect()),
        _ => None,
    };
    if let Some(types) = types {
        if !types.is_empty() && !types.iter().any(|t| has_type(v, t)) {
            return Some(format!("must be {}", types.iter().map(|t| type_name(t)).collect::<Vec<_>>().join(" or ")));
        }
    }
    if let Some(Value::Array(entries)) = p.get("enum") {
        let forms: Vec<String> = entries.iter().map(canon).collect();
        if !forms.contains(&canon(v)) {
            return Some(format!("must be one of {}", forms.join(", ")));
        }
    }
    if let Some(c) = p.get("const") {
        if canon(c) != canon(v) {
            return Some(format!("must be {}", canon(c)));
        }
    }
    let num = |k: &str| p.get(k).and_then(Value::as_f64);
    if let Value::String(s) = v {
        let k = s.chars().count() as f64; // code points
        if let Some(n) = num("minLength").filter(|n| k < *n) {
            return Some(format!("at least {} characters (it has {})", canon(&Value::Number(n)), k as usize));
        }
        if let Some(n) = num("maxLength").filter(|n| k > *n) {
            return Some(format!("at most {} characters (it has {})", canon(&Value::Number(n)), k as usize));
        }
        if let Some(Value::String(pattern)) = p.get("pattern") {
            if !pattern_matches(pattern, s) {
                return Some(format!("must match the pattern {pattern}"));
            }
        }
    }
    if let Value::Number(x) = v {
        let x = *x;
        type Row = (&'static str, fn(f64, f64) -> bool, &'static str);
        let rows: [Row; 4] = [
            ("minimum", |x, n| x < n, "at least"),
            ("exclusiveMinimum", |x, n| x <= n, "more than"),
            ("maximum", |x, n| x > n, "at most"),
            ("exclusiveMaximum", |x, n| x >= n, "less than"),
        ];
        for (key, fails, word) in rows {
            if let Some(n) = num(key).filter(|n| fails(x, *n)) {
                return Some(format!("{word} {}", canon(&Value::Number(n))));
            }
        }
    }
    if let Value::Array(items) = v {
        let k = items.len() as f64;
        if let Some(n) = num("minItems").filter(|n| k < *n) {
            return Some(format!("at least {} items (it has {})", canon(&Value::Number(n)), k as usize));
        }
        if let Some(n) = num("maxItems").filter(|n| k > *n) {
            return Some(format!("at most {} items (it has {})", canon(&Value::Number(n)), k as usize));
        }
    }
    None
}

/// A `type` entry as ECMAScript's `String(t)` writes it (a schema that compiles has only strings there).
fn display_type(t: &Value) -> String {
    match t {
        Value::String(s) => s.clone(),
        other => canon(other),
    }
}

/// Why arguments fail a tool's input schema (spec §8.1), for arguments JSON Schema has rejected.
pub fn argument_reasons(schema: &Value, args: &Value) -> String {
    let Some(schema) = schema.as_object() else {
        return "does not match the input schema".into();
    };
    if schema.get("type").and_then(Value::as_str) == Some("object") && !matches!(args, Value::Object(_)) {
        return "the arguments must be a JSON object".into();
    }
    let mut out: Vec<String> = Vec::new();
    if let Value::Object(args) = args {
        let empty = Map::new();
        let props = schema.get("properties").and_then(Value::as_object).unwrap_or(&empty);
        if let Some(Value::Array(required)) = schema.get("required") {
            for name in required.iter().filter_map(Value::as_str) {
                if !args.contains_key(name) {
                    out.push(format!("missing required member {name}"));
                }
            }
        }
        let ordered = |m: &Map| {
            let mut names: Vec<String> = m.keys().cloned().collect();
            names.sort_by(|a, b| utf16_order(a, b));
            names
        };
        let arg_names = ordered(args);
        if schema.get("additionalProperties") == Some(&Value::Bool(false)) && !schema.contains_key("patternProperties")
        {
            let names = ordered(props).join(", ");
            for name in &arg_names {
                if !props.contains_key(name) {
                    let members = if names.is_empty() { "(no members)".into() } else { format!("(members: {names})") };
                    out.push(format!("unknown member {name} {members}"));
                }
            }
        }
        for name in &arg_names {
            if let Some(p) = props.get(name) {
                if let Some(reason) = member_reason(p, args.get(name).expect("a member")) {
                    out.push(format!("{name}: {reason}"));
                }
            }
        }
    }
    if out.is_empty() {
        "does not match the input schema".into()
    } else {
        out.join("; ")
    }
}
