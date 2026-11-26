import json
from pathlib import Path

import pytest

from fausth.harness import fill, fill_host_values, harness_errors, harness_hash, read_harness, tool_ids
from fausth.values import canonical, hash

ROOT = Path(__file__).resolve().parents[3]
DIR = ROOT / "conformance" / "harnesses"


def files(sub):
    return sorted(p.name for p in (DIR / sub).iterdir() if not p.name.endswith(".expected"))


def load(text):
    """Read and check a harness the way an engine loads it; raises with the reasons if it is invalid."""
    value = read_harness(text)
    canonical(value)
    errors = harness_errors(value)
    if errors:
        raise ValueError("; ".join(errors))
    return value


@pytest.mark.parametrize("name", files("valid"))
def test_valid(name):
    value = load((DIR / "valid" / name).read_text("utf-8"))
    assert canonical(value) == (DIR / "valid" / f"{name}.expected").read_text("utf-8").rstrip()


@pytest.mark.parametrize("name", files("invalid"))
def test_invalid(name):
    with pytest.raises(ValueError):
        load((DIR / "invalid" / name).read_text("utf-8"))


def test_packaged_schema_is_the_repo_schema():
    packaged = Path(__file__).resolve().parents[1] / "fausth" / "harness.v0.7.json"
    assert packaged.read_bytes() == (ROOT / "schema" / "harness.v0.7.json").read_bytes()


# 0.6 (§2, §8.2, §9): the tool order, the hash that sees it, and the texts' placeholders.
def ordered(spec="harness/0.7"):
    return read_harness(f"""spec: {spec}
name: n
prompt: p
tools:
  zeta: {{ description: z, input: {{ type: object }} }}
  "10": {{ description: ten, input: {{ type: object }} }}
  Alpha: {{ description: a, input: {{ type: object }} }}
  "2": {{ description: two, input: {{ type: object }} }}
  "007": {{ description: seven, input: {{ type: object }} }}
""")


def test_tools_come_in_member_order():
    assert tool_ids(ordered()) == ["2", "10", "zeta", "Alpha", "007"]


def test_a_0_7_engine_runs_only_harness_0_7_files():
    assert harness_errors(ordered()) == []
    assert harness_errors(ordered("harness/0.6"))


def test_harness_hash_sees_the_tool_order():
    h = ordered()
    assert harness_hash(h) == hash([h, ["2", "10", "zeta", "Alpha", "007"]])
    swapped = {**h, "tools": {"Alpha": h["tools"]["Alpha"], "zeta": h["tools"]["zeta"]}}
    same = {**h, "tools": {"zeta": h["tools"]["zeta"], "Alpha": h["tools"]["Alpha"]}}
    assert canonical(swapped) == canonical(same)
    assert harness_hash(swapped) != harness_hash(same)


def test_fill_replaces_each_placeholder_once_and_leaves_other_braces():
    assert fill('{tool}: {x} {"a": 1} {y z} {tool}', {"tool": "{x}", "x": "y"}) == '{x}: y {"a": 1} {y z} {x}'


# 0.7 (§2.1): host values, filled at load.
HOST_VALUES = json.loads((ROOT / "conformance" / "host-values.json").read_text("utf-8"))["cases"]


@pytest.mark.parametrize("case", HOST_VALUES, ids=lambda c: c["name"])
def test_host_values(case):
    if case.get("error"):
        with pytest.raises(ValueError):
            fill_host_values(case["harness"], case["values"])
    else:
        assert canonical(fill_host_values(case["harness"], case["values"])) == canonical(case["filled"])
