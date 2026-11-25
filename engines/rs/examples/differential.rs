//! Differential checks against the other engines, beyond the conformance suite (`examples/differential/run.sh`):
//!
//! - `numbers <n>`: n pseudo-random doubles as `<bits hex> <ECMAScript form> <Python repr>`;
//! - `read <list file>`: for each harness path, `valid|invalid <canonical form>` or `error`;
//! - `schemas <jsonl>`: for each line `[schema, [values]]`, a 0/1 per value, or `error`;
//! - `patterns <jsonl>`: for each line `[pattern, [strings]]`, a 0/1 per string, or `error`.

use fausth::value::{number, python_float};
use fausth::{canonical, harness_errors, parse_json, read_harness, Map, Value};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
    match arg(0).as_str() {
        "numbers" => numbers(arg(1).parse().unwrap_or(100_000)),
        "read" => {
            for path in std::fs::read_to_string(arg(1)).unwrap().lines().filter(|l| !l.is_empty()) {
                let out = match read_harness(&std::fs::read_to_string(path).unwrap()) {
                    Ok(v) => {
                        let verdict = if harness_errors(&v).is_empty() { "valid" } else { "invalid" };
                        format!("{verdict} {}", canonical(&v).unwrap_or_default())
                    }
                    Err(_) => "error".into(),
                };
                println!("{path}\t{out}");
            }
        }
        kind @ ("schemas" | "patterns") => {
            for line in std::fs::read_to_string(arg(1)).unwrap().lines().filter(|l| !l.is_empty()) {
                let row = parse_json(line).unwrap();
                let row = row.as_array().unwrap();
                let schema = if kind == "patterns" {
                    let mut m = Map::new();
                    m.insert("pattern", row[0].clone());
                    Value::Object(m)
                } else {
                    row[0].clone()
                };
                match fausth::schema::compile_schema(&schema) {
                    Err(_) => println!("error"),
                    Ok(c) => {
                        let bits: String =
                            row[1].as_array().unwrap().iter().map(|v| if c.is_valid(v) { '1' } else { '0' }).collect();
                        println!("{bits}");
                    }
                }
            }
        }
        _ => eprintln!("usage: differential numbers <n> | read <list> | schemas <jsonl> | patterns <jsonl>"),
    }
}

fn numbers(n: usize) {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for i in 0..n {
        // Random bit patterns, quarters of integers (ties between two shortest forms), binary fractions, and
        // decimals with few digits at every magnitude.
        let x = match i % 4 {
            0 => f64::from_bits(next()),
            1 => (next() % 10_000_000_000_000_000) as f64 / 4.0 * if i % 8 == 1 { 1.0 } else { 1e-3 },
            2 => (next() >> 11) as f64 * 2f64.powi((next() % 200) as i32 - 100),
            _ => ((next() % 1_000_000) as f64 + 0.5) * 10f64.powi((next() % 40) as i32 - 20),
        };
        if x.is_finite() {
            println!("{:016x} {} {}", x.to_bits(), number(x).unwrap(), python_float(x));
        }
    }
}
