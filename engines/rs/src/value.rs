//! Values (spec §1): JSON values with ECMAScript member order, the canonical form (RFC 8785), hash, excerpt, and
//! the argument text in both of its forms (§9.4).

use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fmt;

/// A JSON value as every engine reads it (§1): numbers are IEEE 754 doubles; an object keeps its members in member
/// order (array-index names first, ascending, then the others in document order; a repeated name keeps its first
/// place and its last value), which is the order ECMAScript gives an object's own keys.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Map),
}

/// An object's members in member order (§1).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Map {
    entries: Vec<(String, Value)>,
}

/// The array index a member name denotes, if it is one: `0`, or digits without a leading zero, below 2^32 − 1 (§1).
pub fn array_index(name: &str) -> Option<u32> {
    if name.is_empty() || name.len() > 10 || !name.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if name.len() > 1 && name.starts_with('0') {
        return None;
    }
    let n: u64 = name.parse().ok()?;
    (n < 4_294_967_295).then_some(n as u32)
}

impl Map {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&Value> {
        self.entries.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, name: &str) -> Option<&mut Value> {
        self.entries.iter_mut().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    pub fn contains_key(&self, name: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == name)
    }

    /// Set a member: a name already present keeps its place and takes the new value; a new array-index name goes
    /// among the index names in ascending order, any other new name last (§1).
    pub fn insert(&mut self, name: impl Into<String>, value: Value) {
        let name = name.into();
        if let Some(slot) = self.get_mut(&name) {
            *slot = value;
            return;
        }
        match array_index(&name) {
            Some(i) => {
                let at = self
                    .entries
                    .iter()
                    .position(|(k, _)| array_index(k).is_none_or(|j| j > i))
                    .unwrap_or(self.entries.len());
                self.entries.insert(at, (name, value));
            }
            None => self.entries.push((name, value)),
        }
    }

    pub fn remove(&mut self, name: &str) -> Option<Value> {
        let at = self.entries.iter().position(|(k, _)| k == name)?;
        Some(self.entries.remove(at).1)
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.iter().map(|(k, _)| k)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }
}

impl FromIterator<(String, Value)> for Map {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(iter: I) -> Self {
        let mut map = Map::new();
        for (k, v) in iter {
            map.insert(k, v);
        }
        map
    }
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Map> {
        match self {
            Value::Object(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_object_mut(&mut self) -> Option<&mut Map> {
        match self {
            Value::Object(m) => Some(m),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// The member `name` of an object; `None` for anything else.
    pub fn get(&self, name: &str) -> Option<&Value> {
        self.as_object().and_then(|m| m.get(name))
    }

    /// The member `name` of an object if it is a string.
    pub fn get_str(&self, name: &str) -> Option<&str> {
        self.get(name).and_then(Value::as_str)
    }

    /// ECMAScript truthiness of a JSON value (for the adapters' `||`).
    pub fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::String(s) => !s.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::String(s.to_owned())
    }
}

impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::String(s)
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}

impl From<f64> for Value {
    fn from(n: f64) -> Self {
        Value::Number(n)
    }
}

impl From<u64> for Value {
    fn from(n: u64) -> Self {
        Value::Number(n as f64)
    }
}

impl From<usize> for Value {
    fn from(n: usize) -> Self {
        Value::Number(n as f64)
    }
}

impl From<Map> for Value {
    fn from(m: Map) -> Self {
        Value::Object(m)
    }
}

impl From<Vec<Value>> for Value {
    fn from(a: Vec<Value>) -> Self {
        Value::Array(a)
    }
}

/// An object from `(name, value)` pairs, in member order.
#[macro_export]
macro_rules! object {
    ($($k:expr => $v:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut m = $crate::value::Map::new();
        $( m.insert($k, $crate::value::Value::from($v)); )*
        $crate::value::Value::Object(m)
    }};
}

/// A value without a canonical form (§1), or text that isn't JSON.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValueError(pub String);

impl fmt::Display for ValueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ValueError {}

fn err<T>(message: impl Into<String>) -> Result<T, ValueError> {
    Err(ValueError(message.into()))
}

// ---------------------------------------------------------------------------------------------------------------
// Reading JSON text

/// Read JSON text (RFC 8259) as an engine reads it (§1): every number a double (an integer beyond 2^53 rounds as
/// ECMAScript rounds it; one beyond the doubles reads as an infinity, which then has no canonical form); a repeated
/// name keeps its first place and its last value. A lone surrogate escape is an error here: a Rust string can't
/// hold one, and such a string has no canonical form anyway.
pub fn parse_json(text: &str) -> Result<Value, ValueError> {
    let mut r = Reader { s: text.as_bytes(), text, i: 0 };
    r.space();
    let v = r.value(0)?;
    r.space();
    if r.i != r.s.len() {
        return err("unexpected text after the JSON value");
    }
    Ok(v)
}

struct Reader<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
}

const MAX_DEPTH: usize = 10_000;

impl Reader<'_> {
    fn space(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn expect(&mut self, b: u8) -> Result<(), ValueError> {
        if self.peek() == Some(b) {
            self.i += 1;
            Ok(())
        } else {
            err(format!("expected '{}' at {}", b as char, self.i))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, ValueError> {
        if depth > MAX_DEPTH {
            return err("JSON nested too deeply");
        }
        match self.peek() {
            Some(b'{') => {
                self.i += 1;
                let mut map = Map::new();
                self.space();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(Value::Object(map));
                }
                loop {
                    self.space();
                    let name = self.string()?;
                    self.space();
                    self.expect(b':')?;
                    self.space();
                    let v = self.value(depth + 1)?;
                    map.insert(name, v);
                    self.space();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Object(map));
                        }
                        _ => return err(format!("expected ',' or '}}' at {}", self.i)),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.space();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(Value::Array(items));
                }
                loop {
                    self.space();
                    items.push(self.value(depth + 1)?);
                    self.space();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Array(items));
                        }
                        _ => return err(format!("expected ',' or ']' at {}", self.i)),
                    }
                }
            }
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') => self.word("true", Value::Bool(true)),
            Some(b'f') => self.word("false", Value::Bool(false)),
            Some(b'n') => self.word("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => {
                let token = self.number_token()?;
                token.parse::<f64>().map(Value::Number).map_err(|e| ValueError(e.to_string()))
            }
            _ => err(format!("unexpected character at {}", self.i)),
        }
    }

    fn word(&mut self, word: &str, v: Value) -> Result<Value, ValueError> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            err(format!("unexpected word at {}", self.i))
        }
    }

    /// A number token (`-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`) as written.
    fn number_token(&mut self) -> Result<&str, ValueError> {
        let start = self.i;
        let digits = |r: &mut Self| {
            let from = r.i;
            while r.peek().is_some_and(|b| b.is_ascii_digit()) {
                r.i += 1;
            }
            r.i - from
        };
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                digits(self);
            }
            _ => return err(format!("bad number at {start}")),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if digits(self) == 0 {
                return err(format!("bad number at {start}"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return err(format!("bad number at {start}"));
            }
        }
        Ok(&self.text[start..self.i])
    }

    fn hex4(&mut self) -> Result<u32, ValueError> {
        let h = self.s.get(self.i..self.i + 4).ok_or_else(|| ValueError("bad \\u escape".into()))?;
        let h = std::str::from_utf8(h).map_err(|_| ValueError("bad \\u escape".into()))?;
        if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return err("bad \\u escape");
        }
        self.i += 4;
        Ok(u32::from_str_radix(h, 16).expect("hex digits"))
    }

    fn string(&mut self) -> Result<String, ValueError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() && !matches!(self.s[self.i], b'"' | b'\\') && self.s[self.i] >= 0x20 {
                self.i += 1;
            }
            out.push_str(&self.text[start..self.i]);
            match self.peek() {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let e = self.peek().ok_or_else(|| ValueError("unterminated string".into()))?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let u = self.hex4()?;
                            let c = if (0xD800..0xDC00).contains(&u) {
                                if self.s[self.i..].starts_with(b"\\u") {
                                    self.i += 2;
                                    let low = self.hex4()?;
                                    if !(0xDC00..0xE000).contains(&low) {
                                        return err("a string with a lone surrogate has no canonical form");
                                    }
                                    0x10000 + ((u - 0xD800) << 10) + (low - 0xDC00)
                                } else {
                                    return err("a string with a lone surrogate has no canonical form");
                                }
                            } else if (0xDC00..0xE000).contains(&u) {
                                return err("a string with a lone surrogate has no canonical form");
                            } else {
                                u
                            };
                            out.push(char::from_u32(c).expect("a scalar value"));
                        }
                        _ => return err(format!("bad escape at {}", self.i)),
                    }
                }
                _ => return err("unterminated string or control character in a string"),
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical form, hash, excerpt

/// The canonical form of a value (§1, RFC 8785). Fails for a value that has none (a non-finite number).
pub fn canonical(value: &Value) -> Result<String, ValueError> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

/// Whether a value has a canonical form (§1).
pub fn is_json(value: &Value) -> bool {
    canonical(value).is_ok()
}

/// The canonical form of a value known to have one (one the engine made, or checked).
pub fn canon(value: &Value) -> String {
    canonical(value).expect("a value with a canonical form")
}

/// RFC 8785's member order: names compared by UTF-16 code units.
pub fn utf16_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), ValueError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(*n)?),
        Value::String(s) => quote(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(v, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut names: Vec<&String> = map.keys().collect();
            names.sort_by(|a, b| utf16_order(a, b));
            out.push('{');
            for (i, k) in names.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(k, out);
                out.push(':');
                write_canonical(map.get(k).expect("a member"), out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// A string as ECMAScript's `JSON.stringify` writes it: only `"`, `\` and characters below U+0020 escaped.
pub fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The shortest decimal digits that read back as `x` (finite, positive) and the exponent of the first digit:
/// `x = d₁.d₂…dₖ × 10^e`. Rust's shortest formatting picks, like ECMAScript and Python, the closest such digits, but
/// where two are exactly as close it rounds up; ECMAScript (Number::toString) and Python (`repr`) take the even one,
/// so a tie is settled here (`1424953923781206.25` is `1424953923781206.2`).
fn shortest(x: f64) -> (String, i32) {
    let split = |s: &str| {
        let (mantissa, exp) = s.split_once('e').expect("exponent form");
        (mantissa.replace('.', ""), exp.parse::<i32>().expect("an exponent"))
    };
    let (digits, e) = split(&format!("{x:e}"));
    // The exact value of the double (at most 767 significant digits).
    let (exact, exact_e) = split(&format!("{x:.800e}"));
    let exact = exact.trim_end_matches('0');
    let k = digits.len();
    if exact_e != e || exact.len() != k + 1 || !exact.ends_with('5') || k == 0 {
        return (digits, e);
    }
    // x lies exactly halfway between the k-digit candidates `below` and `below + 1`.
    let below = &exact[..k];
    let other = if digits == below { increment(below) } else { below.to_owned() };
    let even = |d: &str| d.as_bytes()[d.len() - 1].is_multiple_of(2);
    let reads_back = |d: &str| {
        let text = format!("{}.{}e{e}", &d[..1], &d[1..]);
        other.len() == k && text.parse::<f64>() == Ok(x)
    };
    if !even(&digits) && even(&other) && reads_back(&other) {
        let trimmed = other.trim_end_matches('0');
        return (if trimmed.is_empty() { "0".into() } else { trimmed.to_owned() }, e);
    }
    (digits, e)
}

/// A string of decimal digits plus one in its last place (the same length unless it carries out).
fn increment(digits: &str) -> String {
    let mut bytes = digits.as_bytes().to_vec();
    for b in bytes.iter_mut().rev() {
        if *b == b'9' {
            *b = b'0';
        } else {
            *b += 1;
            return String::from_utf8(bytes).expect("digits");
        }
    }
    format!("1{}", String::from_utf8(bytes).expect("digits"))
}

/// ECMAScript's Number::toString of a double: the number format of the canonical form (§1).
pub fn number(x: f64) -> Result<String, ValueError> {
    if !x.is_finite() {
        return err("a non-finite number has no canonical form");
    }
    if x == 0.0 {
        return Ok("0".into());
    }
    if x < 0.0 {
        return Ok(format!("-{}", number(-x)?));
    }
    let (digits, e) = shortest(x);
    let k = digits.len() as i32;
    let n = e + 1;
    Ok(if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let head = if k == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        format!("{head}e{}{}", if n > 0 { "+" } else { "-" }, (n - 1).abs())
    })
}

/// Python's `float.__repr__` of a finite double (§9.4, `sorted_ascii`).
pub fn python_float(x: f64) -> String {
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    if x < 0.0 {
        return format!("-{}", python_float(-x));
    }
    let (digits, e) = shortest(x);
    if !(-4..16).contains(&e) {
        let head = if digits.len() == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        return format!("{head}e{}{:02}", if e < 0 { "-" } else { "+" }, e.abs());
    }
    let n = e + 1; // digits before the decimal point
    let k = digits.len() as i32;
    if n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else if n < k {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else {
        format!("{digits}{}.0", "0".repeat((n - k) as usize))
    }
}

/// Lowercase hex SHA-256 of the UTF-8 bytes of the canonical form (§1).
pub fn hash(value: &Value) -> Result<String, ValueError> {
    let digest = Sha256::digest(canonical(value)?.as_bytes());
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

pub const TRUNCATED: &str = "…[truncated]";

/// `s` if it has at most `n` code points, else its first `n` code points and `…[truncated]` (§1).
pub fn excerpt(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        None => s.to_owned(),
        Some((at, _)) => format!("{}{TRUNCATED}", &s[..at]),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The argument text (§9.4)

/// How a call's arguments go back to the model (§9.4): a harness's `argument_text`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgumentForm {
    ModelOrder,
    SortedAscii,
}

/// The argument text of a value in the form `model_order` (§9.4): ECMAScript's `JSON.stringify(value)`, or with
/// `indented`, `JSON.stringify(value, null, 2)`. Fails if the value has no canonical form.
pub fn argument_text(value: &Value, indented: bool) -> Result<String, ValueError> {
    canonical(value)?;
    let mut out = String::new();
    write_ordered(value, if indented { Some("\n") } else { None }, &mut out);
    Ok(out)
}

fn write_ordered(value: &Value, newline: Option<&str>, out: &mut String) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            let inner = newline.map(|n| format!("{n}  "));
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(inner) = &inner {
                    out.push_str(inner);
                }
                write_ordered(v, inner.as_deref(), out);
            }
            if let Some(n) = newline {
                out.push_str(n);
            }
            out.push(']');
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            let inner = newline.map(|n| format!("{n}  "));
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(inner) = &inner {
                    out.push_str(inner);
                }
                quote(k, out);
                out.push_str(if inner.is_some() { ": " } else { ":" });
                write_ordered(v, inner.as_deref(), out);
            }
            if let Some(n) = newline {
                out.push_str(n);
            }
            out.push('}');
        }
        v => write_canonical(v, out).expect("checked"),
    }
}

/// A JSON value as Python's `json.loads` reads it: an integer token stays exact (its digits), any other number is a
/// double; a repeated name keeps its last value.
enum PyValue {
    Null,
    Bool(bool),
    Str(String),
    Int(String),
    Float(f64),
    List(Vec<PyValue>),
    Dict(Vec<(String, PyValue)>),
}

/// Read JSON text keeping each number token's kind (§9.4, `sorted_ascii`). The text must already be known as JSON.
fn read_tokens(text: &str) -> Result<PyValue, ValueError> {
    let mut r = Reader { s: text.as_bytes(), text, i: 0 };
    r.space();
    let v = py_value(&mut r)?;
    r.space();
    if r.i != r.s.len() {
        return err("not JSON");
    }
    Ok(v)
}

fn py_value(r: &mut Reader) -> Result<PyValue, ValueError> {
    r.space();
    match r.peek() {
        Some(b'{') => {
            r.i += 1;
            let mut members: Vec<(String, PyValue)> = Vec::new();
            r.space();
            if r.peek() == Some(b'}') {
                r.i += 1;
                return Ok(PyValue::Dict(members));
            }
            loop {
                r.space();
                let name = r.string()?;
                r.space();
                r.expect(b':')?;
                let v = py_value(r)?;
                match members.iter_mut().find(|(k, _)| *k == name) {
                    Some(slot) => slot.1 = v, // a repeated name keeps its last value
                    None => members.push((name, v)),
                }
                r.space();
                match r.peek() {
                    Some(b',') => r.i += 1,
                    Some(b'}') => {
                        r.i += 1;
                        return Ok(PyValue::Dict(members));
                    }
                    _ => return err("not JSON"),
                }
            }
        }
        Some(b'[') => {
            r.i += 1;
            let mut items = Vec::new();
            r.space();
            if r.peek() == Some(b']') {
                r.i += 1;
                return Ok(PyValue::List(items));
            }
            loop {
                items.push(py_value(r)?);
                r.space();
                match r.peek() {
                    Some(b',') => r.i += 1,
                    Some(b']') => {
                        r.i += 1;
                        return Ok(PyValue::List(items));
                    }
                    _ => return err("not JSON"),
                }
            }
        }
        Some(b'"') => Ok(PyValue::Str(r.string()?)),
        Some(b't') => r.word("true", Value::Null).map(|_| PyValue::Bool(true)),
        Some(b'f') => r.word("false", Value::Null).map(|_| PyValue::Bool(false)),
        Some(b'n') => r.word("null", Value::Null).map(|_| PyValue::Null),
        _ => {
            let token = r.number_token()?;
            if token.contains(['.', 'e', 'E']) {
                Ok(PyValue::Float(token.parse().map_err(|_| ValueError("not JSON".into()))?))
            } else if token == "-0" {
                Ok(PyValue::Int("0".into()))
            } else {
                Ok(PyValue::Int(token.to_owned()))
            }
        }
    }
}

/// A string as Python's `json.dumps` writes it with `ensure_ascii`: every character outside U+0020–U+007E escaped,
/// a character above U+FFFF as its UTF-16 surrogate pair, hex digits in lowercase.
fn ascii_quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(c),
            c => {
                let mut units = [0u16; 2];
                for u in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{u:04x}"));
                }
            }
        }
    }
    out.push('"');
}

fn write_python(v: &PyValue, newline: Option<&str>, out: &mut String) {
    match v {
        PyValue::Null => out.push_str("null"),
        PyValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        PyValue::Str(s) => ascii_quote(s, out),
        PyValue::Int(digits) => out.push_str(digits),
        PyValue::Float(x) => out.push_str(&python_float(*x)),
        PyValue::List(items) if items.is_empty() => out.push_str("[]"),
        PyValue::Dict(members) if members.is_empty() => out.push_str("{}"),
        PyValue::List(items) => {
            let inner = newline.map(|n| format!("{n}  "));
            out.push('[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(inner) = &inner {
                    out.push_str(inner);
                }
                write_python(x, inner.as_deref(), out);
            }
            if let Some(n) = newline {
                out.push_str(n);
            }
            out.push(']');
        }
        PyValue::Dict(members) => {
            // Python's string order: by code points, which is the byte order of UTF-8.
            let mut sorted: Vec<&(String, PyValue)> = members.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            let inner = newline.map(|n| format!("{n}  "));
            out.push('{');
            for (i, (k, x)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(inner) = &inner {
                    out.push_str(inner);
                }
                ascii_quote(k, out);
                out.push_str(if inner.is_some() { ": " } else { ":" });
                write_python(x, inner.as_deref(), out);
            }
            if let Some(n) = newline {
                out.push_str(n);
            }
            out.push('}');
        }
    }
}

/// The argument text in the form `sorted_ascii` (§9.4), from the model's argument text `raw`: what Python writes
/// with `json.dumps(json.loads(raw), separators=(",", ":"), sort_keys=True)`; with `indented`,
/// `json.dumps(json.loads(raw), indent=2, sort_keys=True)`. Fails if `raw` isn't JSON with a canonical form (§1).
pub fn sorted_ascii_text(raw: &str, indented: bool) -> Result<String, ValueError> {
    canonical(&parse_json(raw)?)?;
    let mut out = String::new();
    write_python(&read_tokens(raw)?, if indented { Some("\n") } else { None }, &mut out);
    Ok(out)
}
