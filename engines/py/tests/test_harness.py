from pathlib import Path

import pytest

from fausth.harness import fill, harness_errors, harness_hash, read_harness, tool_ids
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


@pytest.mark.parametrize("version", ["0.5", "0.6"])
def test_packaged_schema_is_the_repo_schema(version):
    packaged = Path(__file__).resolve().parents[1] / "fausth" / f"harness.v{version}.json"
    assert packaged.read_bytes() == (ROOT / "schema" / f"harness.v{version}.json").read_bytes()


# 0.6 (§2, §8.2, §9, §15): the tool order, the hash that sees it, and the texts' placeholders.
def ordered(spec):
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
    assert tool_ids(ordered("harness/0.6")) == ["2", "10", "zeta", "Alpha", "007"]


def test_a_0_5_file_keeps_the_sorted_order_and_hash():
    h = ordered("harness/0.5")
    assert tool_ids(h) == ["007", "10", "2", "Alpha", "zeta"]
    assert harness_hash(h) == hash(h)


def test_harness_hash_sees_the_tool_order():
    h = ordered("harness/0.6")
    assert harness_hash(h) == hash([h, ["2", "10", "zeta", "Alpha", "007"]])
    swapped = {**h, "tools": {"Alpha": h["tools"]["Alpha"], "zeta": h["tools"]["zeta"]}}
    same = {**h, "tools": {"zeta": h["tools"]["zeta"], "Alpha": h["tools"]["Alpha"]}}
    assert canonical(swapped) == canonical(same)
    assert harness_hash(swapped) != harness_hash(same)


def test_fill_replaces_each_placeholder_once_and_leaves_other_braces():
    assert fill('{tool}: {x} {"a": 1} {y z} {tool}', {"tool": "{x}", "x": "y"}) == '{x}: y {"a": 1} {y z} {x}'
