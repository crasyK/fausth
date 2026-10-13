"""D4: YAML 1.2 core-schema parsing identical to the TS ``yaml`` package (PY-1)."""
import math
from pathlib import Path

import pytest

from fausth.canonical import canonical_json
from fausth.registry import YamlError, agent_yaml_to_ir, load_agent_dir, load_yaml_text

ROOT = Path(__file__).resolve().parents[3]


def test_greenhouse_recovery_on_is_a_string_key():
    agent = load_agent_dir(ROOT / "examples" / "greenhouse")
    assert agent["recovery"]["on"] == "verify_effect_failed"
    assert True not in agent["recovery"]
    canonical_json(agent)  # PY-1: used to crash sorting bool vs str keys


@pytest.mark.parametrize(
    "text,expected",
    [
        ("a: yes", {"a": "yes"}),
        ("a: on", {"a": "on"}),
        ("a: off", {"a": "off"}),
        ("a: y", {"a": "y"}),
        ("on: 1", {"on": 1}),
        ("a: True", {"a": True}),
        ("a: tRue", {"a": "tRue"}),
        ("a: 1.0", {"a": 1}),
        ("a: 1e3", {"a": 1000}),
        ("a: 1.", {"a": 1}),
        ("a: .5", {"a": 0.5}),
        ("a: +5", {"a": 5}),
        ("a: 010", {"a": 10}),
        ("a: 0o10", {"a": 8}),
        ("a: 0x1F", {"a": 31}),
        ("a: 0b101", {"a": "0b101"}),
        ("a: 1_000", {"a": "1_000"}),
        ("a: 1:20", {"a": "1:20"}),
        ("a: 2001-12-14", {"a": "2001-12-14"}),
        ("a: =", {"a": "="}),
        ("a: ~", {"a": None}),
        ("a:", {"a": None}),
        ("a: Null", {"a": None}),
        ("a: +0x1F", {"a": "+0x1F"}),
        ("a: -0", {"a": 0}),
        ("1: a", {"1": "a"}),
        ("true: a", {"true": "a"}),
        ("~: a", {"": "a"}),
        ("1.5: a", {"1.5": "a"}),
        ("0x10: a", {"16": "a"}),
        ("1: a\n'1': b", {"1": "b"}),
        ("base: &b {x: 1}\nm:\n  <<: *b\n  y: 2", {"base": {"x": 1}, "m": {"<<": {"x": 1}, "y": 2}}),
        ("a: !!str 1", {"a": "1"}),
        ("a: !!int '7'", {"a": 7}),
        ("a: !!int 1.0", {"a": "1.0"}),
        ("a: !!float 1", {"a": "1"}),
        ("a: !!float 1e3", {"a": 1000}),
        ("a: !!bool yes", {"a": "yes"}),
        ("a: !foo 12", {"a": "12"}),
        ("a: ! 12", {"a": "12"}),
        ('a: "\\ud83d\\ude00"', {"a": "\U0001F600"}),
        ("", None),
        ("- a\n- b", ["a", "b"]),
    ],
)
def test_core_schema_scalars(text, expected):
    assert load_yaml_text(text) == expected


def test_integral_floats_load_as_ints():
    v = load_yaml_text("a: 1.0\nb: 1e3")
    assert type(v["a"]) is int and type(v["b"]) is int


def test_special_floats():
    v = load_yaml_text("a: .inf\nb: -.Inf\nc: .NaN")
    assert v["a"] == math.inf and v["b"] == -math.inf and math.isnan(v["c"])


@pytest.mark.parametrize("text", ["a: 1\na: 2", "1: a\n1.0: b", "true: a\nTrue: b", "~: a\nnull: b", "'a': 1\n\"a\": 2"])
def test_duplicate_keys_rejected(text):
    with pytest.raises(Exception, match="unique"):
        load_yaml_text(text)


@pytest.mark.parametrize("text", ["a: !!binary aGk=", "a: !!timestamp 2001-12-14", "a: !!set {x}"])
def test_non_core_tags_rejected_loudly(text):
    with pytest.raises(Exception):
        load_yaml_text(text)


def test_yaml_11_directive_rejected():
    with pytest.raises(YamlError):
        load_yaml_text("%YAML 1.1\n---\na: yes")
    assert load_yaml_text("%YAML 1.2\n---\na: yes") == {"a": "yes"}


def test_agent_yaml_to_ir_uses_js_truthiness():
    ir = agent_yaml_to_ir(load_yaml_text("name: x\nstate: {}\ntools: []\nsafe_state: {}\nlimits: {}\ngates: []\nspec: ''"))
    # {} and [] are truthy in JS; '' spec is kept (?? only replaces null/undefined)
    assert ir["safe_state"] == {} and ir["fallback_state"] == {} and ir["limits"] == {} and ir["gates"] == []
    assert ir["spec"] == ""
    ir2 = agent_yaml_to_ir(load_yaml_text("name: 5\nstate:\ntools:\ninstinct_text: 3"))
    assert ir2["name"] == "5" and ir2["state"] == {} and ir2["tools"] == [] and "instinct_text" not in ir2


def test_agent_yaml_state_must_be_canonical():
    with pytest.raises(ValueError):
        agent_yaml_to_ir(load_yaml_text("name: x\nstate: {t: 1.5}\ntools: []"))
