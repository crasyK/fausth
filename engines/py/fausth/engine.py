"""The run loop (spec §8), hooks (§5, §6) and child runs (§10)."""
from __future__ import annotations

import re
from typing import Any, Callable, Protocol

from .harness import SPAWN_INPUT, TEXTS, TURN, fill, harness_errors, harness_hash
from .log import TOP, Log, Scope, call_id, in_scope, view
from .render import args_text, hook_wrapper, render
from .schema import argument_reasons, compile_schema
from .values import argument_text, canonical, excerpt, parse_json, sorted_ascii_text


class InfraFailure(Exception):
    pass


class HostEnd(Exception):
    """Raised by a host to end the run (its user left, `timeout_ms` passed): `host_end` (§12.2)."""


class Host(Protocol):
    """What the engine needs from a host (§13). Methods raise InfraFailure when they can't answer, and
    HostEnd when the host ends the run (§8, §12.2)."""

    def user(self) -> str | None:
        """The next user message, or None when the conversation is over."""

    def model(self, request: dict[str, Any]) -> Any: ...

    def call(self, id: str, input: Any) -> Any:
        """Call the binding of a tool or handler; the answer is checked by the engine (§3.3)."""

    def interrupts(self, step: int) -> list[dict[str, str]]:
        """Interrupts queued for delivery at this step boundary, in arrival order (§11)."""

    # Optional: harness(step) -> a replacement harness to take at this step boundary, or None (§12.3).
    # Optional: reasons(tool, args) -> the reasons text for arguments that failed a tool's input schema, from the
    # host's own validator, or None for the engine's (§8.1). After a pre_check `modify`, `args` are the modified ones.


LIMITS = ("max_steps", "max_tool_calls", "max_depth", "max_continues", "max_hook_text")
DEFAULTS = {"max_steps": 1000, "max_tool_calls": 1000, "max_depth": 1, "max_continues": 3, "max_hook_text": 4000}

# Decisions each event allows besides `allow` (§4), and what a failed built-in check becomes (§6).
ALLOWED = {
    "session_start": ("add_context",),
    "user_prompt": ("deny", "replace", "add_context"),
    "pre_request": ("replace_context", "add_context"),
    "post_response": ("modify", "retry", "end"),
    "pre_check": ("modify",),
    "pre_tool": ("deny", "modify", "add_context"),
    "post_tool": ("replace", "add_context", "end"),
    "stop": ("continue", "add_context"),
    "interrupt": ("deny", "add_context"),
}
PUSH_BACK = {"pre_tool": "deny", "user_prompt": "deny", "interrupt": "deny", "stop": "continue", "post_tool": "add_context"}
ENDS_CHAIN = ("deny", "continue", "replace_context", "retry", "end")
# The members a `hook` entry logs when its decision has them (§7).
LOGGED = ("text", "args", "shown", "args_text", "calls", "keep", "wrap", "keep_reply", "replace_context")
# What the response says beyond its text and calls, logged in the `assistant` entry as given (§7, §14).
RESPONSE_EXTRAS = ("reasoning", "reasoning_opaque", "usage", "finish", "failure")
_INDEX = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_SOURCE = re.compile(r"[a-zA-Z0-9_-]{1,64}\Z")
_ENGINE_ID = re.compile(r"c[0-9]+-[0-9]+\Z")  # the form of the engine's own call ids (§7)
_NOWHERE = object()


class _Ended(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def run(harness: dict[str, Any], host: Host) -> Log:
    """Run a validated harness to its end and return the log."""
    log = Log()
    _Run(harness, host, log, TOP, _top_limits(harness), {"step": 0}, None, []).run(None)
    return log


def _top_limits(harness: dict[str, Any]) -> dict[str, int]:
    return {n: harness.get("limits", {}).get(n, DEFAULTS[n]) for n in LIMITS}


class _Run:
    def __init__(self, harness: dict[str, Any], host: Host, log: Log, scope: Scope, limits: dict[str, int],
                 counter: dict[str, int], parent: _Run | None, inherited: list[tuple[dict[str, Any], _Run]]) -> None:
        self.harness, self.host, self.log, self.scope, self.limits = harness, host, log, scope, limits
        self.counter = counter  # the current step (§8), shared by every run in the log
        self.parent, self.inherited = parent, inherited
        self.steps_used = 0  # requests and tool calls of this run and its children (§8, §10)
        self.tool_calls_used = 0
        self.last_text = ""
        self.turn = 0  # the step at which this run's latest user message was admitted (§5.3)
        self._compile()

    def _compile(self) -> None:
        self.schemas: dict[str, Callable[[Any], bool]] = {}
        for tid, t in self.harness.get("tools", {}).items():
            if tid == "core_spawn":
                self.schemas["tools.core_spawn.input"] = compile_schema(SPAWN_INPUT)
            for k in ("input", "output"):
                if k in t:
                    self.schemas[f"tools.{tid}.{k}"] = compile_schema(t[k])
        for hid, h in self.harness.get("handlers", {}).items():
            if "input" in h:
                self.schemas[f"handlers.{hid}.input"] = compile_schema(h["input"])

    @property
    def step(self) -> int:
        return self.counter["step"]

    def argument_text(self, call: dict[str, Any], indented: bool = False) -> str:
        """A call's argument text in this run's harness's form (§9.4), compact or indented."""
        form = self.harness.get("argument_text", "model_order")
        if form == "sorted_ascii":
            return sorted_ascii_text(call["raw"] if "raw" in call else argument_text(call["args"]), indented)
        if form == "as_sent" and not indented and "raw" in call:
            return call["raw"]
        return argument_text(call["args"], indented)

    def modified_text(self, args: Any, given: str | None, indented: bool = False) -> str:
        """The argument text of arguments a `pre_check` hook modified (§5.4, §9.4): the hook's `args_text`, else the
        arguments written as for a call without `raw`."""
        if given is None:
            return self.argument_text({"args": args}, indented)
        return given if not indented else self.argument_text({"args": args, "raw": given}, True)

    def text(self, name: str, values: dict[str, str]) -> str:
        """One of the engine's texts (§8.2): the harness's wording, else the default."""
        return fill(self.harness.get("texts", {}).get(name, TEXTS[name][1]), values)

    @property
    def hooks(self) -> list[tuple[dict[str, Any], _Run]]:
        """Each hook with the run whose harness declared it (inherited hooks keep their harness, §10)."""
        return self.inherited + [(hook, self) for hook in self.harness.get("hooks", [])]

    def _ancestry(self) -> list[_Run]:
        runs, r = [], self
        while r is not None:
            runs.append(r)
            r = r.parent
        return runs

    def append(self, type: str, members: dict[str, Any]) -> dict[str, Any]:
        return self.log.append(self.scope, type, members)

    def run(self, task: str | None) -> str:
        """Run to the end. A child's only user message is its task; the top level asks the host."""
        self.append("run_start", {"harness_hash": harness_hash(self.harness), "depth": self.scope.depth})
        try:
            self._start()
            pending = task
            while True:
                text = pending if self.parent is not None else self.host.user()
                pending = None
                if text is None:
                    raise _Ended("stop")
                if not isinstance(text, str) or not _is_json(text):
                    raise InfraFailure("malformed user message")
                decisions = self._chain("user_prompt", {"message": text})
                if any(d["decision"] == "deny" for d in decisions):
                    continue
                replaced = [d["text"] for d in decisions if d["decision"] == "replace"]
                self.append("user", {"text": replaced[-1] if replaced else text})
                self.turn = self.step
                self._turn()
        except _Ended as e:
            reason = e.reason
        except InfraFailure:
            reason = "infra_failure"
        except HostEnd:
            reason = "host_end"
        self.append("run_end", {"reason": reason})
        return reason

    def _start(self) -> None:
        """Run the `session_start` hooks and log the assembled system prompt (§9.1)."""
        contexts = self._chain("session_start", {})
        system = self.harness["prompt"] + "".join(
            "\n\n" + hook_wrapper("session_start", d["hook"]["id"], d["decision"], d["text"]) for d in contexts)
        self.append("system", {"text": system})

    def _boundary(self) -> None:
        """The top-level step boundary (§8 step 3.1): a replacement harness, then queued interrupts."""
        take = getattr(self.host, "harness", None)
        new = take(self.step) if take is not None else None
        if new is not None:
            if harness_errors(new):
                raise InfraFailure("the host's replacement harness is not valid")
            self.harness = new
            self.limits = _top_limits(new)
            self._compile()
            self.append("harness_changed", {"harness_hash": harness_hash(new)})
            self._start()
            if self.steps_used >= self.limits["max_steps"]:
                raise _Ended("limit")
        for interrupt in self.host.interrupts(self.step):
            if not (isinstance(interrupt, dict) and isinstance(interrupt.get("source"), str)
                    and _SOURCE.match(interrupt["source"]) and isinstance(interrupt.get("text"), str)
                    and _is_json(interrupt["text"])):
                raise InfraFailure("malformed interrupt")
            source, text = interrupt["source"], interrupt["text"]
            if any(d["decision"] == "deny" for d in self._chain("interrupt", {"interrupt": {"source": source, "text": text}})):
                continue
            self.append("interrupt", {"source": source, "text": text, "step": self.step})

    def _turn(self) -> None:
        continued = 0
        while True:
            if self.steps_used >= self.limits["max_steps"]:
                raise _Ended("limit")
            if self.parent is None:
                self._boundary()
            self._chain("pre_request", {})
            request = render(self.harness, self.log.entries, self.scope)
            response = _check_response(self.host.model(request))
            self.counter["step"] += 1
            for r in self._ancestry():
                r.steps_used += 1
            given = response.get("tool_calls", [])
            calls = self._logged_calls(given)
            self.last_text = response.get("text", "")
            members = {"step": self.step, "text": self.last_text, "tool_calls": calls}
            members.update((k, response[k]) for k in RESPONSE_EXTRAS if k in response)
            self.append("assistant", members)
            # The reply as logged, each call with the model's `raw` text (§5.3); the request it answers.
            reply = {"text": self.last_text,
                     "tool_calls": [{**call, **({"raw": c["raw"]} if "raw" in c else {})} for call, c in zip(calls, given)]}
            reply.update((k, response[k]) for k in RESPONSE_EXTRAS if k in response and k != "usage")
            decisions = self._chain("post_response", {"reply": reply, "context": request["messages"]})
            if any(d["decision"] == "end" for d in decisions):
                raise _Ended("harness_end")
            if any(d["decision"] == "retry" for d in decisions):
                continue
            if "failure" in response:
                raise InfraFailure("the model response failed and no post_response hook answered it")
            pairs = list(zip(calls, given))
            modified = [d["calls"] for d in decisions if d["decision"] == "modify"]
            if modified:
                # Only the listed calls run, in that order, under their names (§5.4).
                by_id = {call["call_id"]: (call, c) for call, c in pairs}
                pairs = [({**by_id[m["call_id"]][0], "tool": m["tool"]}, by_id[m["call_id"]][1]) for m in modified[-1]]
            for call, c in pairs:
                self._tool_call(call, c)
            if pairs:
                continue
            if continued < self.limits["max_continues"]:
                stop = self._chain("stop", {"message": self.last_text, "continued": continued})
                if any(d["decision"] == "continue" for d in stop):
                    continued += 1
                    continue
            return

    def _logged_calls(self, calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The response's calls as the log holds them (§7): ids, argument texts, malformed texts."""
        seq = len(self.log.entries) + 1
        used = {c["call_id"] for e in self.log.entries if e["type"] == "assistant" for c in e["tool_calls"]}
        out = []
        for i, c in enumerate(calls):
            # The provider's id, unless it is empty, taken, or of the engine's form (§7).
            given = c.get("call_id")
            cid = given if given and given not in used and not _ENGINE_ID.match(given) else call_id(seq, i)
            used.add(cid)
            if "malformed" in c:
                # Its arguments go back as {} (§9.4).
                out.append({"call_id": cid, "tool": c["tool"], "args": {}, "malformed": c["malformed"]})
                continue
            call = {"call_id": cid, "tool": c["tool"], "args": c["args"]}
            text = self.argument_text(c)  # written now, in the form of the harness that runs the call (§9.4)
            if text != canonical(c["args"]):
                call["args_text"] = text
            out.append(call)
        return out

    def _tool_call(self, call: dict[str, Any], response_call: dict[str, Any]) -> None:
        if self.tool_calls_used >= self.limits["max_tool_calls"]:
            raise _Ended("limit")
        for r in self._ancestry():
            r.tool_calls_used += 1
        tool = call["tool"]  # as the model named it, or as a post_response `modify` renamed it

        def shown() -> dict[str, str]:
            given = {"args": call["args"]} if "malformed" in response_call else response_call
            return {"tool": tool, "args": args_text(call), "args_indented": self.argument_text(given, True)}

        if tool not in self.harness.get("tools", {}):
            self._result(call, {"ok": False, "error": self.text("unknown_tool", shown())})
            return
        # Repair before the check (§5.4): the hooks see the model's text; the last `modify` gives the arguments.
        before: dict[str, Any] = {"tool": tool, "args": call["args"]}
        if "raw" in response_call:
            before["raw"] = response_call["raw"]
        if "malformed" in call:
            before["malformed"] = call["malformed"]
        repairs = [d for d in self._chain("pre_check", {"call": before}, call) if d["decision"] == "modify"]
        args = repairs[-1]["args"] if repairs else call["args"]
        if repairs:
            # The texts show the checked arguments, as `shown: modified` would (§8.2).
            given_text = repairs[-1].get("given")
            values = {"tool": tool, "args": self.modified_text(args, given_text),
                      "args_indented": self.modified_text(args, given_text, True)}
            shown = lambda: values  # noqa: E731
        elif "malformed" in call:
            values = {"tool": tool, "text": call["malformed"], "parse_error": response_call.get("parse_error", "")}
            self._result(call, {"ok": False, "error": self.text("malformed_arguments", values)})
            return
        if not self.schemas[f"tools.{tool}.input"](args):
            schema = SPAWN_INPUT if tool == "core_spawn" else self.harness["tools"][tool].get("input")
            own_reasons = getattr(self.host, "reasons", None)
            own = own_reasons(tool, args) if own_reasons is not None else None
            if own is not None and (not isinstance(own, str) or not _is_json(own)):
                raise InfraFailure("malformed reasons from the host")
            reasons = own if own is not None else argument_reasons(schema, args)
            self._result(call, {"ok": False, "error": self.text("invalid_arguments", {**shown(), "reasons": reasons})})
            return
        pre = self._chain("pre_tool", {"call": {"tool": tool, "args": args}}, call)
        if any(d["decision"] == "deny" for d in pre):
            return
        modified = [d["args"] for d in pre if d["decision"] == "modify"]
        args = modified[-1] if modified else args
        if tool == "core_spawn":
            answer = self._spawn(call, args)
        else:
            answer = _check_answer(self.host.call(tool, args), self.schemas.get(f"tools.{tool}.output"))
        if answer is None:
            return
        self._result(call, answer)
        post = self._chain("post_tool", {"call": {"tool": tool, "args": args}, "result": answer}, call)
        if any(d["decision"] == "end" for d in post):
            raise _Ended("harness_end")  # the reply's later calls don't run (§5.4)

    def _result(self, call: dict[str, Any], answer: dict[str, Any]) -> None:
        self.append("tool_result", {"call_id": call["call_id"], "tool": call["tool"], **answer})

    def _spawn(self, call: dict[str, Any], args: dict[str, Any]) -> dict[str, Any] | None:
        """`core_spawn` (§10): the narrowing check, then the child run. None if the check denied it."""
        child = args["harness"]
        denial = self._narrowing(child)
        if denial is not None:
            text = excerpt(denial, self.limits["max_hook_text"])
            self.append("hook", {"hook": "core_spawn", "event": "pre_tool", "decision": "deny", "text": text,
                                 "call_id": call["call_id"]})
            return None
        limits = {n: child.get("limits", {}).get(n, self._allowance(n)) for n in LIMITS}
        scope = Scope(self.scope.depth + 1, call["call_id"])
        child_run = _Run(child, self.host, self.log, scope, limits, self.counter, self, self.hooks)
        reason = child_run.run(args["task"])
        if reason == "infra_failure":
            raise InfraFailure("the child run failed")
        if reason == "host_end":
            raise HostEnd("the host ended the run in a child")
        return {"ok": True, "result": {"text": child_run.last_text, "steps": child_run.steps_used,
                                       "tool_calls": child_run.tool_calls_used}}

    def _allowance(self, name: str) -> int:
        """How much of a limit a child may have: what is left of a budget, else the limit itself."""
        if name == "max_steps":
            return self.limits["max_steps"] - self.steps_used
        if name == "max_tool_calls":
            return self.limits["max_tool_calls"] - self.tool_calls_used
        return self.limits[name]

    def _narrowing(self, child: dict[str, Any]) -> str | None:
        """The first failed narrowing check's text (§10), or None if the child may run."""
        if harness_errors(child):
            return "child harness is not valid"
        tools, child_tools = self.harness.get("tools", {}), child.get("tools", {})
        for tid in sorted(child_tools):
            if tid not in tools:
                return f"child tool {tid} is not a parent tool"
            if canonical(child_tools[tid].get("input")) != canonical(tools[tid].get("input")):
                return f"child tool {tid} has a different input schema"
        for hid in sorted(child.get("handlers", {})):
            if hid not in self.harness.get("handlers", {}):
                return f"child handler {hid} is not a parent handler"
        for name in LIMITS:
            declared = child.get("limits", {}).get(name)
            if declared is not None and declared > self._allowance(name):
                return f"child limit {name} exceeds the parent's {canonical(self._allowance(name))}"
        if "core_spawn" in child_tools and not self.scope.depth + 1 < self.limits["max_depth"]:
            return f"child at depth {self.scope.depth + 1} may not spawn"
        return None

    def _chain(self, event: str, members: dict[str, Any], call: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Run the hooks of an event in order (§5.2), log each decision, and return the ones that act."""
        acting: list[dict[str, Any]] = []
        current = members.get("call")
        replaced = None
        message = members.get("message")
        reply = members.get("reply")
        key = call["tool"] if call else members.get("interrupt", {}).get("source")
        for hook, owner in self.hooks:
            if hook["on"] != event or not _matches(hook.get("match", "*"), key):
                continue
            inp: dict[str, Any] = {"event": event, "hook": hook["id"], "with": hook.get("with", {}), "step": self.step,
                                   "turn": self.turn, "view": view(self.log.entries, self.scope)}
            if current is not None:
                inp["call"] = current
            if "result" in members:
                inp["result"] = members["result"]
            if replaced is not None:
                inp["replaced"] = replaced
            if message is not None:
                inp["message"] = message
            if "continued" in members:
                inp["continued"] = members["continued"]
            if "interrupt" in members:
                inp["interrupt"] = dict(members["interrupt"])
            if reply is not None:
                inp["reply"] = reply
            if event in ("pre_request", "stop"):
                # The request's messages as they would be rendered now (§5.3).
                inp["context"] = render(self.harness, self.log.entries, self.scope)["messages"]
            if event == "post_response":
                inp["context"] = members["context"]  # the request this response answers
            if event in ("pre_request", "stop", "post_response"):
                # The usage the run's last response reported (§5.3).
                last = next((e for e in reversed(self.log.entries)
                             if e["type"] == "assistant" and in_scope(e, self.scope)), None)
                if last is not None and "usage" in last:
                    inp["usage"] = last["usage"]

            ids = [c["call_id"] for c in members["reply"]["tool_calls"]] if event == "post_response" else None
            d = self._decide(hook, owner, event, inp, current["tool"] if current else None, ids)
            where = {"call_id": call["call_id"]} if call else {}
            if d is None:
                self.append("hook", {"hook": hook["id"], "event": event, "decision": "failed", **where})
                if hook.get("on_failure", "end") == "end":
                    raise InfraFailure(f"hook {hook['id']} failed")
                continue
            entry = {"hook": hook["id"], "event": event, "decision": d["decision"]}
            entry.update((k, d[k]) for k in LOGGED if k in d)
            self.append("hook", {**entry, **where})
            if d["decision"] == "allow":
                continue
            acting.append(d)
            if d["decision"] == "modify" and event == "post_response":
                originals = {c["call_id"]: c for c in members["reply"]["tool_calls"]}
                reply = {**reply, "tool_calls": [{**originals[c["call_id"]], "tool": c["tool"]} for c in d["calls"]]}
            elif d["decision"] == "modify" and event == "pre_check":
                current = {"tool": current["tool"], "args": d["args"], **({"raw": current["raw"]} if "raw" in current else {})}
            elif d["decision"] == "modify":
                current = {"tool": current["tool"], "args": d["args"]}
            if d["decision"] == "replace" and event == "user_prompt":
                message = d["text"]
            elif d["decision"] == "replace":
                replaced = d["text"]
            if d["decision"] in ENDS_CHAIN:
                break
        return acting

    def _decide(self, hook: dict[str, Any], owner: _Run, event: str, inp: dict[str, Any],
                tool: str | None, ids: list[str] | None = None) -> dict[str, Any] | None:
        """One hook's decision (§5.4), or None if the hook failed."""
        def cap(text: str) -> str:
            return excerpt(text, self.limits["max_hook_text"])

        if hook["run"].startswith("core_"):
            w = hook.get("with", {})
            if hook["run"] == "core_context":
                return {"hook": hook, "decision": "add_context", "text": cap(w["text"])}
            failure = _check(hook["run"], w, self.step, self.turn, inp["view"])
            if failure is None:
                return {"hook": hook, "decision": "allow"}
            return {"hook": hook, "decision": PUSH_BACK[event], "text": cap(failure)}
        schema = owner.schemas.get(f"handlers.{hook['run']}.input")
        if schema is not None and not schema(inp):
            return None
        try:
            answer = self.host.call(hook["run"], inp)
        except InfraFailure:
            return None
        if not (isinstance(answer, dict) and answer.get("ok") is True and len(answer) == 2
                and isinstance(answer.get("result"), dict)):
            return None
        out = answer["result"]
        decision = out.get("decision")
        if not isinstance(decision, str) or (decision != "allow" and decision not in ALLOWED[event]):
            return None
        members = sorted(k for k in out if k != "decision")
        if decision == "allow":
            return {"hook": hook, "decision": decision} if not members else None
        if decision == "modify" and event == "pre_check":
            return self._repair(hook, out, members)
        if decision == "modify" and event == "post_response":
            return _calls(hook, out, members, ids or [])
        if decision == "retry":
            return _retry(hook, out, members, len(inp["context"]), cap)
        if decision == "end":
            if members not in ([], ["text"]) or ("text" in out and not (isinstance(out["text"], str) and _is_json(out["text"]))):
                return None
            return {"hook": hook, "decision": decision, **({"text": cap(out["text"])} if "text" in out else {})}
        if decision == "replace" and event == "user_prompt":
            # The admitted message, whole (§5.4).
            if members != ["text"] or not isinstance(out["text"], str) or not _is_json(out["text"]):
                return None
            return {"hook": hook, "decision": decision, "text": out["text"]}
        if decision == "modify":
            if members not in (["args"], ["args", "text"]):
                return None
            if "text" in out and not isinstance(out["text"], str):
                return None
            if not _is_json(out["args"]) or not self.schemas[f"tools.{tool}.input"](out["args"]):
                return None
            d = {"hook": hook, "decision": decision, "args": out["args"]}
            if "text" in out:
                d["text"] = cap(out["text"])
            return d
        if decision == "replace_context" and members != ["text"]:
            # Optional `keep` (at most the context's messages) and `wrap` (§5.4); unwrapped text is not excerpted.
            if "text" not in members or not set(members) <= {"text", "keep", "wrap"}:
                return None
            if not isinstance(out["text"], str) or not _is_json(out["text"]):
                return None
            keep = out.get("keep")
            if keep is not None and not (_is_count(keep) and keep <= len(inp["context"])):
                return None
            if "keep" in out and keep is None:
                return None
            if "wrap" in out and not isinstance(out["wrap"], bool):
                return None
            d = {"hook": hook, "decision": decision, "text": out["text"] if out.get("wrap") is False else cap(out["text"])}
            if "keep" in out:
                d["keep"] = int(keep)
            if "wrap" in out:
                d["wrap"] = out["wrap"]
            return d
        if members != ["text"] or not isinstance(out["text"], str) or not _is_json(out["text"]):
            return None
        return {"hook": hook, "decision": decision, "text": cap(out["text"])}

    def _repair(self, hook: dict[str, Any], out: dict[str, Any], members: list[str]) -> dict[str, Any] | None:
        """A `pre_check` `modify` (§5.4): `args`, `shown` and, with `shown: modified`, an optional `args_text` that reads
        as `args`. The arguments are checked against the schema afterwards, as any call's."""
        if members not in (["args", "shown"], ["args", "args_text", "shown"]) or out["shown"] not in ("model", "modified"):
            return None
        if not _is_json(out["args"]):
            return None
        given = out.get("args_text")
        if given is not None and (out["shown"] != "modified" or not isinstance(given, str) or not _is_json(given)
                                  or not _reads(given, out["args"])):
            return None
        d = {"hook": hook, "decision": "modify", "args": out["args"], "shown": out["shown"], "given": given}
        if out["shown"] == "modified":
            text = self.modified_text(out["args"], given)
            if text != canonical(out["args"]):
                d["args_text"] = text
        return d


def _calls(hook: dict[str, Any], out: dict[str, Any], members: list[str], ids: list[str]) -> dict[str, Any] | None:
    """A `post_response` `modify` (§5.4): `calls`, a list of `{call_id, tool}` naming the reply's calls, none twice."""
    calls = out.get("calls")
    if members != ["calls"] or not isinstance(calls, list) or not _is_json(calls):
        return None
    seen: set[str] = set()
    for c in calls:
        if not (isinstance(c, dict) and set(c) == {"call_id", "tool"} and isinstance(c["tool"], str)
                and c["call_id"] in ids and c["call_id"] not in seen):
            return None
        seen.add(c["call_id"])
    return {"hook": hook, "decision": "modify", "calls": [{"call_id": c["call_id"], "tool": c["tool"]} for c in calls]}


def _retry(hook: dict[str, Any], out: dict[str, Any], members: list[str], context: int,
           cap: Callable[[str], str]) -> dict[str, Any] | None:
    """A `retry` (§5.4): optional `text`, `wrap`, `keep_reply` and a `replace_context` in that decision's shape."""
    if not set(members) <= {"text", "wrap", "keep_reply", "replace_context"}:
        return None
    if any(k in out and not isinstance(out[k], bool) for k in ("wrap", "keep_reply")):
        return None
    if "text" in out and not (isinstance(out["text"], str) and _is_json(out["text"])):
        return None
    d: dict[str, Any] = {"hook": hook, "decision": "retry"}
    if "text" in out:
        d["text"] = out["text"] if out.get("wrap") is False else cap(out["text"])
    d.update((k, out[k]) for k in ("wrap", "keep_reply") if k in out)
    if "replace_context" in out:
        rc = out["replace_context"]
        if not (isinstance(rc, dict) and "text" in rc and set(rc) <= {"text", "keep", "wrap"}):
            return None
        if not (isinstance(rc["text"], str) and _is_json(rc["text"])):
            return None
        if "keep" in rc and not (_is_count(rc["keep"]) and rc["keep"] <= context):
            return None
        if "wrap" in rc and not isinstance(rc["wrap"], bool):
            return None
        d["replace_context"] = {"text": rc["text"] if rc.get("wrap") is False else cap(rc["text"]),
                                **({"keep": int(rc["keep"])} if "keep" in rc else {}),
                                **({"wrap": rc["wrap"]} if "wrap" in rc else {})}
    return d


def _matches(match: Any, key: str | None) -> bool:
    if match == "*":
        return True
    return key is not None and (key in match if isinstance(match, list) else match == key)


def _check(run: str, w: dict[str, Any], step: int, turn: int, entries: list[dict[str, Any]]) -> str | None:
    """A built-in check (§6): None if it passes, else the failure text."""
    calls = [e for e in entries if "tool" in e]

    def successful(tool: Any) -> Callable[[dict[str, Any]], bool]:
        return lambda e: e["tool"] == tool and e["ok"]

    def seen(e: dict[str, Any]) -> bool:
        return e["step"] < step

    if run == "core_called_since":
        tools = w["tool"] if isinstance(w["tool"], list) else [w["tool"]]
        named = " or ".join(tools)
        if w.get("since") == TURN:
            if any(successful(t)(e) and seen(e) and e["step"] > turn for e in calls for t in tools):
                return None
            return f"{named} not called this turn"
        since = -1
        if "since" in w:
            since = max((i for i, e in enumerate(calls) if successful(w["since"])(e)), default=-1)
        if any(successful(t)(e) and seen(e) for e in calls[since + 1:] for t in tools):
            return None
        return f"{named} not called since the last {w['since']}" if since >= 0 else f"{named} not called yet"
    if run == "core_last_result":
        last = [e for e in calls if successful(w["tool"])(e) and seen(e)]
        if not last:
            return f"{w['tool']} has no successful call yet"
        value = _at(last[-1]["result"], w["path"])
        if value is not _NOWHERE and canonical(value) == canonical(w["eq"]):
            return None
        return f"last {w['tool']} result {w['path']} is not {canonical(w['eq'])}"
    if run == "core_count":
        if sum(1 for e in calls if successful(w["tool"])(e)) < w["max"]:
            return None
        return f"{w['tool']} limit reached ({canonical(w['max'])})"
    return w["text"]  # core_deny


def _at(value: Any, path: str) -> Any:
    """The value at a `.`-separated path of member names and array indexes (§6); _NOWHERE if none."""
    if path == "":
        return value
    v = value
    for segment in path.split("."):
        if isinstance(v, list) and _INDEX.match(segment) and int(segment) < len(v):
            v = v[int(segment)]
        elif isinstance(v, dict) and segment in v:
            v = v[segment]
        else:
            return _NOWHERE
    return v


def _is_count(v: Any) -> bool:
    """A non-negative integer (a JSON number without a fractional part)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 and float(v).is_integer()


def _is_response_call(c: Any) -> bool:
    """A tool call of a model response (§14): `args` with an optional `raw`, or `malformed` text with an optional
    `parse_error`; an optional id."""
    if not isinstance(c, dict) or not isinstance(c.get("tool"), str) or ("args" in c) == ("malformed" in c):
        return False
    if not isinstance(c.get("call_id", ""), str):
        return False
    if "malformed" in c:
        return isinstance(c["malformed"], str) and isinstance(c.get("parse_error", ""), str) and "raw" not in c
    return "parse_error" not in c and ("raw" not in c or (isinstance(c["raw"], str) and _reads(c["raw"], c["args"])))


def _reads(raw: str, args: Any) -> bool:
    """`raw` is JSON text whose value (read as §1 reads numbers) is `args`."""
    try:
        return canonical(parse_json(raw)) == canonical(args)
    except (ValueError, RecursionError):
        return False


def _check_response(v: Any) -> dict[str, Any]:
    """A model response as the transport delivered it; anything else breaks the interface."""
    ok = (isinstance(v, dict)
          and isinstance(v.get("text", ""), str)
          and isinstance(v.get("reasoning", ""), str)
          and ("reasoning_opaque" not in v or (isinstance(v["reasoning_opaque"], dict) and len(v["reasoning_opaque"]) == 2
                                               and isinstance(v["reasoning_opaque"].get("provider"), str)
                                               and "data" in v["reasoning_opaque"]))
          and isinstance(v.get("usage", {}), dict)
          and isinstance(v.get("finish", ""), str)
          and isinstance(v.get("failure", ""), str)
          and isinstance(v.get("tool_calls", []), list)
          and all(_is_response_call(c) for c in v.get("tool_calls", [])))
    if not ok or not _is_json(v):
        raise InfraFailure("malformed model response")
    return v


def _check_answer(v: Any, output: Callable[[Any], bool] | None) -> dict[str, Any]:
    """A binding's answer (§3.3): `{ok: true, result}` or `{ok: false, error}`, nothing else."""
    if isinstance(v, dict) and v.get("ok") is True and set(v) == {"ok", "result"} and _is_json(v["result"]):
        if output is not None and not output(v["result"]):
            raise InfraFailure("result fails the output schema")
        return {"ok": True, "result": v["result"]}
    if isinstance(v, dict) and v.get("ok") is False and set(v) == {"ok", "error"} and isinstance(v["error"], str) \
            and _is_json(v["error"]):
        return {"ok": False, "error": v["error"]}
    raise InfraFailure("malformed binding answer")


def _is_json(v: Any) -> bool:
    try:
        canonical(v)
        return True
    except ValueError:
        return False
