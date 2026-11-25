//! A scripted host for the tests: model replies in order, live bindings by id, recorded answers for the rest.
#![allow(dead_code)]

use fausth::value::{canon, parse_json, Map, Value};
use fausth::{Host, HostError, Request};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;

pub type Binding = Box<dyn FnMut(&Value) -> Result<Value, HostError>>;
pub type Reasons = Box<dyn FnMut(&str, &Value) -> Option<Value>>;

#[derive(Default)]
pub struct Scripted {
    pub replies: VecDeque<Result<Value, HostError>>,
    pub live: HashMap<String, Binding>,
    pub tools: VecDeque<Value>,
    pub users: VecDeque<String>,
    pub requests: Rc<RefCell<Vec<Request>>>,
    pub reasons: Option<Reasons>,
}

impl Scripted {
    pub fn new(replies: Vec<Value>) -> Self {
        Scripted { replies: replies.into_iter().map(Ok).collect(), ..Scripted::default() }
    }

    pub fn users(mut self, users: &[&str]) -> Self {
        self.users = users.iter().map(|u| u.to_string()).collect();
        self
    }

    pub fn live(mut self, id: &str, binding: Binding) -> Self {
        self.live.insert(id.to_owned(), binding);
        self
    }

    /// The canonical request lines this host was sent.
    pub fn request_lines(requests: &Rc<RefCell<Vec<Request>>>) -> String {
        requests.borrow().iter().map(|r| format!("{}\n", canon(&r.to_value()))).collect()
    }
}

impl Host for Scripted {
    fn user(&mut self) -> Result<Option<String>, HostError> {
        Ok(self.users.pop_front())
    }

    fn model(&mut self, request: &Request) -> Result<Value, HostError> {
        self.requests.borrow_mut().push(request.clone());
        self.replies.pop_front().unwrap_or_else(|| Err(HostError::Infra("no more replies".into())))
    }

    fn call(&mut self, id: &str, input: &Value) -> Result<Value, HostError> {
        if let Some(binding) = self.live.get_mut(id) {
            return binding(input);
        }
        let line = self.tools.pop_front().expect("a recorded answer");
        assert_eq!(line.get_str("id"), Some(id));
        let mut answer = line.as_object().unwrap().clone();
        answer.remove("id");
        Ok(Value::Object(answer))
    }

    fn reasons(&mut self, tool: &str, args: &Value) -> Option<Value> {
        self.reasons.as_mut().and_then(|r| r(tool, args))
    }
}

pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

pub fn lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .map(|t| t.split('\n').filter(|l| !l.trim().is_empty()).map(|l| parse_json(l).unwrap()).collect())
        .unwrap_or_default()
}

pub fn json(text: &str) -> Value {
    parse_json(text).unwrap()
}

pub fn obj(members: &[(&str, Value)]) -> Value {
    let mut m = Map::new();
    for (k, v) in members {
        m.insert(*k, v.clone());
    }
    Value::Object(m)
}
