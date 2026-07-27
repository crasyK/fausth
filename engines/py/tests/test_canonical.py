from fausth.canonical import canonical_json, deep_eq, state_hash, INT53_MAX
from fausth.predicates import eval_predicate, get_path, is_missing, MISSING


def test_canonical_sorts_keys():
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_int53_reject():
    try:
        canonical_json({"x": INT53_MAX + 1})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_deep_eq_key_order():
    assert deep_eq({"a": 1, "b": 2}, {"b": 2, "a": 1})


def test_state_hash_stable():
    assert state_hash({"fan_percent": 0, "sensor_healthy": 1}) == state_hash(
        {"sensor_healthy": 1, "fan_percent": 0}
    )


def test_missing_sentinel():
    snap = {"action": {"name": "t", "args": {"percent": 40}}, "state": {}}
    assert get_path(snap, "action.args.missing") is MISSING
    assert is_missing(get_path(snap, "action.args.missing"))
    assert eval_predicate({"path": "action.args.missing", "eq": 1}, snap) is False
    assert eval_predicate({"path": "action.args.missing", "neq": 1}, snap) is False
    assert eval_predicate({"path": "action.args.a", "eq_path": "action.args.b"}, snap) is True
