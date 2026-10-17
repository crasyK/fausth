"""The harness file (spec §2, §3, §5.1, §6): reading it and checking it."""
from __future__ import annotations

import json
import math
import re
from importlib.resources import files
from typing import Any

from yaml.composer import Composer
from yaml.constructor import ConstructorError, SafeConstructor
from yaml.error import YAMLError
from yaml.nodes import ScalarNode
from yaml.parser import Parser
from yaml.reader import Reader
from yaml.resolver import BaseResolver
from yaml.scanner import Scanner

from .schema import compile_schema, structure_validator
from .values import number

BUILT_INS = frozenset({"core_called_since", "core_last_result", "core_count", "core_deny", "core_context"})

# YAML 1.2 core schema (spec §2): the same resolution as the TypeScript `yaml` package.
_TAG = "tag:yaml.org,2002:"
_NULL = re.compile(r"(?:~|null|Null|NULL)?\Z")
_BOOL = re.compile(r"(?:true|True|TRUE|false|False|FALSE)\Z")
_INT = re.compile(r"(?:0o[0-7]+|[-+]?[0-9]+|0x[0-9a-fA-F]+)\Z")
# A float needs a "." or an exponent, as in the TypeScript `yaml` package: there `!!float 1` is an error.
_FLOAT = re.compile(r"[-+]?(?:(?:\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][-+]?[0-9]+)?|[0-9]+[eE][-+]?[0-9]+)\Z")
_NOT_FINITE = re.compile(r"(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)\Z")
_SURROGATE_PAIR = re.compile("[" + chr(0xD800) + "-" + chr(0xDBFF) + "][" + chr(0xDC00) + "-" + chr(0xDFFF) + "]")


class _Resolver(BaseResolver):
    yaml_implicit_resolvers: dict = {}


for _tag, _regexp, _first in (
    ("null", _NULL, ["~", "n", "N", ""]),
    ("bool", _BOOL, list("tTfF")),
    ("int", _INT, list("-+0123456789")),
    ("float", _NOT_FINITE, list("-+.")),
    ("float", _FLOAT, list("-+.0123456789")),
):
    _Resolver.add_implicit_resolver(_TAG + _tag, _regexp, _first)


class _Constructor(SafeConstructor):
    yaml_constructors: dict = {}
    yaml_multi_constructors: dict = {}

    def _scalar(self, node: Any, regexp: re.Pattern[str]) -> str:
        value = self.construct_scalar(node)
        if not regexp.match(value):
            raise ConstructorError(None, None, f"{value!r} is not a valid {node.tag}", node.start_mark)
        return value

    def construct_str(self, node: Any) -> str:
        # YAML escapes a non-BMP character as two \u escapes; join them as ECMAScript strings do.
        return _SURROGATE_PAIR.sub(lambda m: m.group().encode("utf-16-le", "surrogatepass").decode("utf-16-le"),
                                   self.construct_scalar(node))

    def construct_null(self, node: Any) -> None:
        self._scalar(node, _NULL)

    def construct_bool(self, node: Any) -> bool:
        return self._scalar(node, _BOOL)[0] in "tT"

    def construct_int(self, node: Any) -> int | float:
        v = self._scalar(node, _INT)
        base = 8 if v.startswith("0o") else 16 if v.startswith("0x") else 10
        return number(int(v[2:] if base != 10 else v, base))

    def construct_float(self, node: Any) -> float:
        if _NOT_FINITE.match(self.construct_scalar(node)):
            raise ConstructorError(None, None, "infinity and NaN are not JSON", node.start_mark)
        x = float(self._scalar(node, _FLOAT))
        if not math.isfinite(x):
            raise ConstructorError(None, None, f"{x} is not a finite number", node.start_mark)
        return x

    def construct_seq(self, node: Any) -> list:
        return [self.construct_object(child, deep=True) for child in node.value]

    def construct_map(self, node: Any) -> dict:
        out: dict = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=True)
            if not isinstance(key, str):
                raise ConstructorError(None, None, "mapping keys must be strings", key_node.start_mark)
            if key in out:
                raise ConstructorError(None, None, f"duplicate key {key!r}", key_node.start_mark)
            out[key] = self.construct_object(value_node, deep=True)
        return out

    def construct_unknown(self, node: Any) -> Any:
        raise ConstructorError(None, None, f"tag {node.tag} is not in the YAML 1.2 core schema", node.start_mark)


for _name in ("str", "null", "bool", "int", "float", "seq", "map"):
    _Constructor.add_constructor(_TAG + _name, getattr(_Constructor, "construct_" + _name))
_Constructor.add_constructor(None, _Constructor.construct_unknown)


class _Loader(Reader, Scanner, Parser, Composer, _Constructor, _Resolver):
    def __init__(self, text: str) -> None:
        Reader.__init__(self, text)
        Scanner.__init__(self)
        Parser.__init__(self)
        Composer.__init__(self)
        _Constructor.__init__(self)
        _Resolver.__init__(self)

    def compose_scalar_node(self, anchor: Any) -> ScalarNode:  # type: ignore[override]
        # As PyYAML's, except that the non-specific tag "!" makes a scalar a string (YAML 1.2).
        event = self.get_event()
        tag = event.tag
        if tag == "!":
            tag = self.DEFAULT_SCALAR_TAG
        elif tag is None:
            tag = self.resolve(ScalarNode, event.value, event.implicit)
        node = ScalarNode(tag, event.value, event.start_mark, event.end_mark, style=event.style)
        if anchor is not None:
            self.anchors[anchor] = node
        return node

    def process_directives(self):  # type: ignore[no-untyped-def]
        handles = super().process_directives()
        if self.yaml_version not in (None, (1, 2)):
            raise ConstructorError(None, None, "only YAML 1.2 is supported", None)
        return handles


# YAML 1.2 treats U+0085, U+2028 and U+2029 as ordinary characters; PyYAML (YAML 1.1) breaks lines
# at them. They pass through the parser as private-use stand-ins.
_HIDE = {0x85: 0xF0085, 0x2028: 0xF2028, 0x2029: 0xF2029}
_SHOW = {v: k for k, v in _HIDE.items()}


def _shown(v: Any) -> Any:
    if isinstance(v, str):
        return v.translate(_SHOW)
    if isinstance(v, list):
        return [_shown(x) for x in v]
    if isinstance(v, dict):
        return {_shown(k): _shown(x) for k, x in v.items()}
    return v


def read_harness(text: str) -> Any:
    """Harness text as a JSON value: YAML 1.2 core schema, JSON read as YAML (§2). Raises ValueError."""
    if any(chr(c) in text for c in _SHOW):
        raise ValueError("the characters U+F0085, U+F2028 and U+F2029 are not supported")
    loader = _Loader(text.translate(_HIDE))
    try:
        return _shown(loader.get_single_data())
    except (YAMLError, RecursionError) as e:
        raise ValueError(str(e)) from None
    finally:
        loader.dispose()


_STRUCTURE = structure_validator(json.loads((files("fausth") / "harness.v0.4.json").read_text("utf-8")))


def harness_errors(value: Any) -> list[str]:
    """What is wrong with a harness; empty if it is valid."""
    problems = [f"{e.json_path}: {e.message}" for e in _STRUCTURE.iter_errors(value)]
    if problems:
        return problems
    tools = value.get("tools", {})
    handlers = value.get("handlers", {})
    errors: list[str] = []

    for hid in handlers:
        if hid in tools:
            errors.append(f"{hid}: declared as a tool and as a handler")
    schemas = [(f"tools.{tid}.{k}", t.get(k)) for tid, t in tools.items() for k in ("input", "output")]
    schemas += [(f"handlers.{hid}.input", h.get("input")) for hid, h in handlers.items()]
    for where, schema in schemas:
        if schema is None:
            continue
        try:
            compile_schema(schema)
        except ValueError as e:
            errors.append(f"{where}: {e}")

    hook_ids: set[str] = set()
    for hook in value.get("hooks", []):
        hook_id, run = hook["id"], hook["run"]
        if hook_id in hook_ids:
            errors.append(f"hook {hook_id}: id is not unique")
        hook_ids.add(hook_id)
        if run not in BUILT_INS and run not in handlers:
            errors.append(f"hook {hook_id}: {run} is not a declared handler or a built-in")
        tool_refs: list[Any] = []
        match = hook.get("match", "*")
        if hook["on"] in ("pre_tool", "post_tool") and match != "*":
            tool_refs += match if isinstance(match, list) else [match]
        if run in BUILT_INS:
            tool_refs += [hook.get("with", {}).get("tool"), hook.get("with", {}).get("since")]
        for tid in tool_refs:
            if isinstance(tid, str) and tid not in tools:
                errors.append(f"hook {hook_id}: {tid} is not a declared tool")
    return errors
