//! Rust engine for the Fausth harness spec v0.7 (`docs/spec-v0.7.md`); it runs only `harness/0.7` files.
//!
//! The twin of `engines/ts` and `engines/py`: for every conformance fixture the three produce byte-identical logs
//! and requests. A host implements [`Host`] and calls [`run`] with a checked [`Harness`]; [`replay`] answers a run
//! from a fixture's files; [`launch`] binds a tool or handler to another run (§13.1); [`openai`] maps the neutral
//! request to Chat Completions and back.

pub mod engine;
pub mod harness;
pub mod launch;
pub mod log;
pub mod openai;
pub mod render;
pub mod replay;
pub mod schema;
pub mod value;
mod yaml;

pub use engine::{run, Host, HostError, Reason};
pub use harness::{harness_errors, read_harness, Harness, SPEC};
pub use launch::{harness_binding, HarnessBinding, LaunchOptions};
pub use log::{Log, Scope};
pub use render::{Message, Request, ToolCall, ToolSpec};
pub use value::{canonical, parse_json, Map, Value};
