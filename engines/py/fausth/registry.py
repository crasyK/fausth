"""Harness loading (YAML 1.2 core schema, agent IR) and deployment.bindings →
tool handlers (mirrors TS ``load.ts`` and ``adapters/registry.ts``)."""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any, Callable

import yaml
from yaml.composer import Composer
from yaml.constructor import ConstructorError, SafeConstructor
from yaml.nodes import MappingNode, ScalarNode, SequenceNode
from yaml.parser import Parser
from yaml.reader import Reader
from yaml.resolver import BaseResolver
from yaml.scanner import Scanner

from .adapter_error import AdapterError
from .canonical import (
    UNDEFINED,
    canonical_json,
    combine_surrogates,
    js_number_to_string,
    js_string,
    js_truthy,
    json_loads,
    nn,
    normalize_number,
    read_text_utf8,
)
from .runtime import ToolHandler, simulation_tool_pool

__all__ = [
    "AdapterError",
    "NATIVE_TO_TOOL",
    "ToolSet",
    "YamlError",
    "agent_yaml_to_ir",
    "load_agent_dir",
    "load_agent_json",
    "load_yaml",
    "load_yaml_text",
    "resolve_tools_from_deployment",
]

# --------------------------------------------------------------------------
# YAML 1.2 core schema (D4) — byte-for-byte the TS `yaml` package's `parse()`
# defaults: core schema, unique keys, no merge keys, no timestamps, no
# sexagesimal / underscore / 0b numbers, yes/no/on/off stay strings.
# --------------------------------------------------------------------------

_NULL_RE = re.compile(r"(?:~|[Nn]ull|NULL)?\Z")
_BOOL_RE = re.compile(r"(?:[Tt]rue|TRUE|[Ff]alse|FALSE)\Z")
_INT_OCT_RE = re.compile(r"0o[0-7]+\Z")
_INT_RE = re.compile(r"[-+]?[0-9]+\Z")
_INT_HEX_RE = re.compile(r"0x[0-9a-fA-F]+\Z")
_FLOAT_NAN_RE = re.compile(r"(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)\Z")
_FLOAT_EXP_RE = re.compile(r"[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+\Z")
_FLOAT_RE = re.compile(r"[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)\Z")

_TAG = "tag:yaml.org,2002:"
#: Tags the TS `yaml` package knows outside the core schema; their explicit use
#: yields non-JSON values (Buffer, Date, Map, Set …) — rejected loudly here.
_UNSUPPORTED_EXPLICIT_TAGS = {
    _TAG + n for n in ("binary", "merge", "omap", "pairs", "set", "timestamp", "value", "yaml")
}


class YamlError(ValueError):
    """YAML input outside the portable core-schema subset."""


class _CoreResolver(BaseResolver):
    yaml_implicit_resolvers: dict[Any, list[tuple[str, re.Pattern[str]]]] = {}


# Registration order mirrors the TS core schema: null, bool, int(oct, dec, hex), float(nan, exp, plain).
_CoreResolver.add_implicit_resolver(_TAG + "null", _NULL_RE, ["~", "n", "N", ""])
_CoreResolver.add_implicit_resolver(_TAG + "bool", _BOOL_RE, list("tTfF"))
_CoreResolver.add_implicit_resolver(_TAG + "int", _INT_OCT_RE, ["0"])
_CoreResolver.add_implicit_resolver(_TAG + "int", _INT_RE, list("-+0123456789"))
_CoreResolver.add_implicit_resolver(_TAG + "int", _INT_HEX_RE, ["0"])
_CoreResolver.add_implicit_resolver(_TAG + "float", _FLOAT_NAN_RE, list("-+."))
_CoreResolver.add_implicit_resolver(_TAG + "float", _FLOAT_EXP_RE, list("-+.0123456789"))
_CoreResolver.add_implicit_resolver(_TAG + "float", _FLOAT_RE, list("-+.0123456789"))


def _key_identity(key: Any) -> tuple[str, Any] | None:
    """Identity used for duplicate-key detection (TS: scalar ``a.value === b.value``)."""
    if key is None:
        return ("null", None)
    if isinstance(key, bool):
        return ("bool", key)
    if isinstance(key, (int, float)):
        if isinstance(key, float) and math.isnan(key):
            return None  # NaN !== NaN
        return ("number", key)
    return ("str", key)


def _js_key(key: Any) -> str:
    """Property key for a scalar map key (yaml ``stringifyKey``)."""
    if key is None:
        return ""
    if isinstance(key, str):
        return key
    if isinstance(key, bool):
        return "true" if key else "false"
    if isinstance(key, (int, float)):
        return js_number_to_string(key)
    return js_string(key)


class _CoreConstructor(SafeConstructor):
    yaml_constructors: dict[Any, Callable[..., Any]] = {}
    yaml_multi_constructors: dict[Any, Callable[..., Any]] = {}

    def construct_str(self, node: ScalarNode) -> str:
        return combine_surrogates(self.construct_scalar(node))

    def construct_null(self, node: ScalarNode) -> Any:
        value = self.construct_scalar(node)
        return None if _NULL_RE.match(value) else combine_surrogates(value)

    def construct_bool(self, node: ScalarNode) -> Any:
        value = self.construct_scalar(node)
        if _BOOL_RE.match(value):
            return value[0] in "tT"
        return combine_surrogates(value)

    def construct_int(self, node: ScalarNode) -> Any:
        value = self.construct_scalar(node)
        if _INT_OCT_RE.match(value):
            return int(value[2:], 8)
        if _INT_RE.match(value):
            return int(value, 10)
        if _INT_HEX_RE.match(value):
            return int(value[2:], 16)
        return combine_surrogates(value)  # unresolvable explicit !!int → string (TS warns)

    def construct_float(self, node: ScalarNode) -> Any:
        value = self.construct_scalar(node)
        if _FLOAT_NAN_RE.match(value):
            if value[-3:].lower() == "nan":
                return math.nan
            return -math.inf if value[0] == "-" else math.inf
        if _FLOAT_EXP_RE.match(value) or _FLOAT_RE.match(value):
            return normalize_number(float(value))
        return combine_surrogates(value)

    def construct_seq(self, node: SequenceNode) -> list[Any]:
        if not isinstance(node, SequenceNode):
            raise ConstructorError(None, None, "expected a sequence", node.start_mark)
        return [self.construct_object(child, deep=True) for child in node.value]

    def construct_map(self, node: MappingNode) -> dict[str, Any]:
        if not isinstance(node, MappingNode):
            raise ConstructorError(None, None, "expected a mapping", node.start_mark)
        out: dict[str, Any] = {}
        seen: set[tuple[str, Any]] = set()
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=True)
            if isinstance(key, (list, dict)):
                raise ConstructorError(
                    None,
                    None,
                    "collection-valued mapping keys are not portable",
                    key_node.start_mark,
                )
            ident = _key_identity(key)
            if ident is not None:
                if ident in seen:
                    raise ConstructorError(
                        None, None, "Map keys must be unique", key_node.start_mark
                    )
                seen.add(ident)
            out[_js_key(key)] = self.construct_object(value_node, deep=True)
        return out

    def construct_unknown(self, node: Any) -> Any:
        if node.tag in _UNSUPPORTED_EXPLICIT_TAGS:
            raise ConstructorError(
                None, None, f"unsupported YAML tag {node.tag!r} (not in the 1.2 core schema)", node.start_mark
            )
        # Unknown local/global tags: the TS loader warns and keeps the node's plain value.
        if isinstance(node, ScalarNode):
            return self.construct_str(node)
        if isinstance(node, SequenceNode):
            return self.construct_seq(node)
        return self.construct_map(node)


_CoreConstructor.add_constructor(_TAG + "str", _CoreConstructor.construct_str)
_CoreConstructor.add_constructor(_TAG + "null", _CoreConstructor.construct_null)
_CoreConstructor.add_constructor(_TAG + "bool", _CoreConstructor.construct_bool)
_CoreConstructor.add_constructor(_TAG + "int", _CoreConstructor.construct_int)
_CoreConstructor.add_constructor(_TAG + "float", _CoreConstructor.construct_float)
_CoreConstructor.add_constructor(_TAG + "seq", _CoreConstructor.construct_seq)
_CoreConstructor.add_constructor(_TAG + "map", _CoreConstructor.construct_map)
_CoreConstructor.add_constructor(None, _CoreConstructor.construct_unknown)


class CoreSchemaLoader(Reader, Scanner, Parser, Composer, _CoreConstructor, _CoreResolver):
    """PyYAML loader with YAML 1.2 core-schema semantics matching TS ``yaml.parse``."""

    def __init__(self, stream: str) -> None:
        Reader.__init__(self, stream)
        Scanner.__init__(self)
        Parser.__init__(self)
        Composer.__init__(self)
        _CoreConstructor.__init__(self)
        _CoreResolver.__init__(self)

    def compose_scalar_node(self, anchor: Any) -> ScalarNode:  # type: ignore[override]
        # Same as PyYAML's Composer, except that the non-specific "!" tag makes a
        # scalar a string (YAML 1.2; PyYAML would resolve "! 12" to an int).
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

    def process_directives(self):  # type: ignore[override]
        handles = super().process_directives()
        if self.yaml_version is not None and self.yaml_version != (1, 2):
            raise YamlError(
                f"%YAML {self.yaml_version[0]}.{self.yaml_version[1]} directive is not supported "
                "(harness YAML is parsed with YAML 1.2 core-schema semantics)"
            )
        return handles


def load_yaml_text(text: str) -> Any:
    """Parse one YAML document like TS ``yaml.parse`` (YAML 1.2 core schema)."""
    loader = CoreSchemaLoader(text)
    try:
        return loader.get_single_data()
    finally:
        loader.dispose()


def load_yaml(path: str | Path) -> Any:
    return load_yaml_text(read_text_utf8(path))


# --------------------------------------------------------------------------
# Agent IR loading (TS load.ts)
# --------------------------------------------------------------------------

_IR_OPTIONAL_KEYS = (
    "gates",
    "limits",
    "fallback_state",
    "safe_state",
    "recovery",
    "permissions",
    "spawn",
    "counterbalance",
    "mutable",
)


def _js_spread(v: Any) -> dict[str, Any]:
    """``{ ...v }`` for JSON-like values."""
    if isinstance(v, dict):
        return dict(v)
    if isinstance(v, (str, list)):
        return {str(i): x for i, x in enumerate(v)}
    return {}


def agent_yaml_to_ir(raw: Any) -> dict[str, Any]:
    """Mirror TS ``agentYamlToIr`` — keep only known AgentIR fields (JS truthiness)."""
    if raw is None:
        raise ValueError("agent.yml is empty (expected a mapping)")
    a = raw if isinstance(raw, dict) else {}
    ir: dict[str, Any] = {
        "spec": js_string(nn(a.get("spec"), "counterbalance-contract/v0.1")),
        "name": js_string(nn(a.get("name"), "unnamed")),
        "state": _js_spread(nn(a.get("state"), {})),
        "tools": nn(a.get("tools"), []),
    }
    for key in _IR_OPTIONAL_KEYS:
        if js_truthy(a.get(key)):
            ir[key] = a[key]
            if key == "safe_state" and not js_truthy(ir.get("fallback_state")):
                ir["fallback_state"] = ir["safe_state"]
    if isinstance(a.get("instinct_text"), str):
        ir["instinct_text"] = a["instinct_text"]
    if js_truthy(a.get("overlays")):
        ir["overlays"] = a["overlays"]
    canonical_json(ir["state"])
    return ir


def load_agent_json(path: str | Path) -> dict[str, Any]:
    """``agent.json`` load path of TS ``loadAgentDir`` (state must be canonical)."""
    ir = json_loads(read_text_utf8(path))
    if not isinstance(ir, dict):
        raise ValueError(f"{path}: agent.json must contain a JSON object")
    if js_truthy(ir.get("safe_state")) and not js_truthy(ir.get("fallback_state")):
        ir["fallback_state"] = ir["safe_state"]
    canonical_json(ir.get("state", UNDEFINED))
    return ir


def load_agent_dir(dir_path: str | Path) -> dict[str, Any]:
    d = Path(dir_path)
    yml = d / "agent.yml"
    js = d / "agent.json"
    if yml.exists():
        return agent_yaml_to_ir(load_yaml(yml))
    if js.exists():
        return load_agent_json(js)
    raise FileNotFoundError(f"No agent.yml or agent.json in {dir_path}")


def load_deployment(path: str | Path) -> Any:
    return load_yaml(path)


# --------------------------------------------------------------------------
# Deployment bindings → handlers (TS adapters/registry.ts)
# --------------------------------------------------------------------------

#: Map deployment ``native:`` id → harness tool id (identical to TS NATIVE_TO_TOOL).
NATIVE_TO_TOOL: dict[str, str] = {
    "stub.fs_read": "fs.read",
    "sim.fs_read": "fs.read",
    "local.fs_read": "fs.read",
    "fs.read": "fs.read",
    "stub.fs_list": "fs.list",
    "sim.fs_list": "fs.list",
    "local.fs_list": "fs.list",
    "fs.list": "fs.list",
    "stub.fs_write": "fs.write_scoped",
    "sim.fs_write": "fs.write_scoped",
    "local.fs_write": "fs.write_scoped",
    "fs.write_scoped": "fs.write_scoped",
    "stub.shell": "shell.run_allowlisted",
    "sim.shell": "shell.run_allowlisted",
    "local.shell": "shell.run_allowlisted",
    "shell.run_allowlisted": "shell.run_allowlisted",
    "local.tau_invoke": "tau.invoke",
    "tau.invoke": "tau.invoke",
    "local.todo_complete": "todo.complete",
    "todo.complete": "todo.complete",
    "stub.approve": "user.approve",
    "sim.approve": "user.approve",
    "local.user_approve": "user.approve",
    "local.user_approve_auto": "user.approve",
    "user.approve": "user.approve",
    "stub.ask": "user.ask",
    "user.ask": "user.ask",
    "local.user_ask": "user.ask",
    "local.user_ask_auto": "user.ask",
    "stub.user_correct": "user.correct",
    "sim.user_correct": "user.correct",
    "local.user_correct": "user.correct",
    "local.user_correct_auto": "user.correct",
    "user.correct": "user.correct",
    "stub.task_complete": "task.complete",
    "sim.task_complete": "task.complete",
    "local.task_complete": "task.complete",
    "task.complete": "task.complete",
    "stub.phase_yield": "phase.yield",
    "sim.phase_yield": "phase.yield",
    "local.phase_yield": "phase.yield",
    "phase.yield": "phase.yield",
    "stub.kb_lookup": "kb.lookup",
    "sim.kb_lookup": "kb.lookup",
    "kb.lookup": "kb.lookup",
    "stub.answer_send": "answer.send",
    "sim.answer_send": "answer.send",
    "answer.send": "answer.send",
    "stub.human_handoff": "human.handoff",
    "sim.human_handoff": "human.handoff",
    "human.handoff": "human.handoff",
    "stub.refund_request": "refund.request",
    "refund.request": "refund.request",
    "stub.spawn": "agent.spawn",
    "agent.spawn": "agent.spawn",
    "stub.harness_patch": "harness.propose_skills_patch",
    "sim.harness_patch": "harness.propose_skills_patch",
    "harness.propose_skills_patch": "harness.propose_skills_patch",
    "stub.harness_decline": "harness.decline_skills_patch",
    "sim.harness_decline": "harness.decline_skills_patch",
    "local.harness_decline": "harness.decline_skills_patch",
    "harness.decline_skills_patch": "harness.decline_skills_patch",
    "stub.harness_reflect": "harness.reflect_skills",
    "sim.harness_reflect": "harness.reflect_skills",
    "local.harness_reflect": "harness.reflect_skills",
    "harness.reflect_skills": "harness.reflect_skills",
    "stub.temperature": "sensor.temperature.read",
    "sensor.temperature.read": "sensor.temperature.read",
    "stub.fan_read": "sensor.fan.read_percent",
    "sensor.fan.read_percent": "sensor.fan.read_percent",
    "stub.fan_set": "actuator.fan.set",
    "actuator.fan.set": "actuator.fan.set",
    "stub.wait": "system.wait",
    "system.wait": "system.wait",
}


class ToolSet(dict):
    """Resolved handlers plus host-side resources (MCP sessions) to release.

    Behaves like ``dict[str, ToolHandler]``; call :meth:`close` (or use as a
    context manager) when the run ends so stdio servers are terminated.
    """

    def __init__(self, handlers: dict[str, ToolHandler], cleanups: list[Callable[[], None]] | None = None):
        super().__init__(handlers)
        self._cleanups = list(cleanups or [])

    def close(self) -> None:
        cleanups, self._cleanups = self._cleanups, []
        for fn in cleanups:
            try:
                fn()
            except Exception:  # pragma: no cover - best effort teardown
                pass

    def __enter__(self) -> "ToolSet":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __del__(self) -> None:  # pragma: no cover - safety net
        try:
            self.close()
        except Exception:
            pass


def _binding_natives(deployment: dict[str, Any]) -> list[str]:
    bindings = deployment.get("bindings") if isinstance(deployment, dict) else None
    if not isinstance(bindings, dict):
        return []
    return [
        b["native"]
        for b in bindings.values()
        if isinstance(b, dict) and isinstance(b.get("native"), str)
    ]


def _uses_prefix(deployment: dict[str, Any], *prefixes: str) -> bool:
    return any(n.startswith(prefixes) for n in _binding_natives(deployment))


def resolve_tools_from_deployment(
    agent: dict[str, Any],
    deployment: dict[str, Any],
    *,
    test_exit: int | None = None,
    sensor_healthy: int | None = None,
    files: dict[str, str] | None = None,
    harness_dir: str | None = None,
    resolved: dict[str, Any] | None = None,
) -> ToolSet:
    """For each agent tool, require a deployment binding whose native resolves to it.

    The handler pool is TS ``buildHandlerPool`` (simulation world), not the
    replay world used by ``replay``.
    """
    from .mcp import create_mcp_handlers, deployment_uses_mcp, mcp_tool_map_from_resolved, parse_mcp_native

    uses_local = _uses_prefix(deployment, "local.")
    if uses_local and _uses_prefix(deployment, "stub.", "sim."):
        raise AdapterError(
            "adapter_unresolved",
            "deployment mixes local.* bindings with stub.*/sim.* — use a single binding family",
        )
    if uses_local and deployment_uses_mcp(deployment):
        raise AdapterError(
            "adapter_unresolved",
            "deployment mixes local.* bindings with mcp.* — use a single binding family",
        )
    if uses_local and _uses_prefix(deployment, "module."):
        raise AdapterError(
            "adapter_unresolved",
            "deployment mixes local.* bindings with module.* — use a single binding family",
        )
    if uses_local:
        raise AdapterError(
            "adapter_unresolved",
            "adapter failure: local.* bindings (real disposable-worktree I/O) are TS-only; "
            "use the TS CLI with --workspace",
        )

    pool: dict[str, ToolHandler] = simulation_tool_pool(
        agent, test_exit=test_exit, sensor_healthy=sensor_healthy, files=files
    )
    cleanups: list[Callable[[], None]] = []
    mcp_native_to_tool: dict[str, str] = {}
    if deployment_uses_mcp(deployment):
        if not harness_dir:
            raise AdapterError(
                "adapter_unresolved",
                "adapter failure: mcp.* bindings require harness directory context",
            )
        handlers, mcp_native_to_tool, cleanup = create_mcp_handlers(
            deployment,
            harness_dir=harness_dir,
            mcp_tool_map=mcp_tool_map_from_resolved(resolved),
        )
        cleanups.append(cleanup)
        pool = {**pool, **handlers}

    try:
        bindings = deployment.get("bindings") or {}
        out: dict[str, ToolHandler] = {}
        for tool in agent.get("tools") or []:
            tid = tool["id"]
            binding = bindings.get(tid) if isinstance(bindings, dict) else None
            native = binding.get("native") if isinstance(binding, dict) else None
            if not isinstance(native, str) or not native:
                raise AdapterError(
                    "binding_missing",
                    f"adapter failure: no deployment binding for tool '{tid}' (binding_missing)",
                )
            mapped = NATIVE_TO_TOOL.get(native) or mcp_native_to_tool.get(native)
            if mapped is None and native.startswith("mcp."):
                parsed = parse_mcp_native(native)
                if parsed and parsed[1] == tid:
                    mapped = tid
            if not mapped:
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: unknown native '{native}' for tool '{tid}' (adapter_unresolved)",
                )
            if mapped != tid:
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: native '{native}' maps to '{mapped}', not '{tid}' (adapter_unresolved)",
                )
            handler = pool.get(tid)
            if handler is None:
                raise AdapterError(
                    "adapter_unresolved",
                    f"adapter failure: no host handler for tool '{tid}' (adapter_unresolved)",
                )
            out[tid] = handler
    except BaseException:
        for fn in cleanups:
            fn()
        raise
    return ToolSet(out, cleanups)
