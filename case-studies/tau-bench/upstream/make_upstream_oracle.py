#!/usr/bin/env python3
"""Generate differential-test fixtures for the tau-bench retail world port.

Runs the *upstream* sierra-research/tau-bench retail tools (pure Python, no
LLM, no network) on a checkout of the commit pinned in upstream.lock.json
(this directory) and records:

  - tools.json            upstream get_info() specs (names, descriptions, schemas)
                          -> copy to ../world/tools.json
  - tasks-test.json       tasks_test.py parsed with `ast` (no execution)
  - upstream-oracle.json  observations + data hashes for every gold action of
                          every test task, per-tool edge cases, calculate corpus

Usage (run with an isolated interpreter, outside the checkout):
  git clone https://github.com/sierra-research/tau-bench <dir> && git -C <dir> checkout <commit>
  python3 -I make_upstream_oracle.py <dir> <out dir>

The JS port (../world/tau.mjs) is tested against these fixtures by
../tests/tau-world.test.mjs; tasks are imported from tasks-test.json by
scripts/import-tau-retail.mjs.
"""
import ast
import copy
import hashlib
import json
import os
import sys
import types

UPSTREAM, OUT = sys.argv[1], sys.argv[2]
RETAIL = os.path.join(UPSTREAM, "tau_bench", "envs", "retail")
TOOLS_DIR = os.path.join(RETAIL, "tools")


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --- upstream hashing (tau_bench/envs/base.py, verbatim semantics) ---
def to_hashable(item):
    if isinstance(item, dict):
        return tuple((key, to_hashable(value)) for key, value in sorted(item.items()))
    elif isinstance(item, list):
        return tuple(to_hashable(element) for element in item)
    elif isinstance(item, set):
        return tuple(sorted(to_hashable(element) for element in item))
    else:
        return item


def consistent_hash(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


# --- load upstream tools without importing the tau_bench package ---
class Tool:  # stand-in for tau_bench.envs.tool.Tool
    pass


ORDER = []
init_src = open(os.path.join(TOOLS_DIR, "__init__.py")).read()
for node in ast.parse(init_src).body:
    if isinstance(node, ast.Assign) and node.targets[0].id == "ALL_TOOLS":
        ORDER = [elt.id for elt in node.value.elts]

TOOLS = {}
CLASSES = {}
for fname in sorted(os.listdir(TOOLS_DIR)):
    if not fname.endswith(".py") or fname == "__init__.py":
        continue
    src = open(os.path.join(TOOLS_DIR, fname)).read()
    src = src.replace("from tau_bench.envs.tool import Tool", "")
    ns = {"Tool": Tool}
    exec(compile(src, fname, "exec"), ns)
    for v in ns.values():
        if isinstance(v, type) and issubclass(v, Tool) and v is not Tool:
            CLASSES[v.__name__] = v
for cls_name in ORDER:
    cls = CLASSES[cls_name]
    TOOLS[cls.get_info()["function"]["name"]] = cls

TERMINATE = ["transfer_to_human_agents"]


def load_data():
    d = {}
    for k in ["orders", "products", "users"]:
        with open(os.path.join(RETAIL, "data", f"{k}.json")) as f:
            d[k] = json.load(f)
    return d


BASE = load_data()


def step(data, name, kwargs):
    """tau_bench Env.step for tool actions (observation only)."""
    if name in TOOLS:
        try:
            return TOOLS[name].invoke(data=data, **kwargs)
        except Exception as e:  # noqa: BLE001 - mirrors upstream
            return f"Error: {e}"
    return f"Unknown action {name}"


def obs_record(obs):
    rec = {"sha256": sha(obs), "len": len(obs)}
    if len(obs) <= 400:
        rec["text"] = obs
    else:
        rec["prefix"] = obs[:200]
    return rec


# --- tasks_test.py via ast (no execution) ---
def call_to_obj(node):
    if isinstance(node, ast.Call):
        return {kw.arg: call_to_obj(kw.value) for kw in node.keywords}
    if isinstance(node, ast.List):
        return [call_to_obj(e) for e in node.elts]
    return ast.literal_eval(node)


tasks_src = open(os.path.join(RETAIL, "tasks_test.py")).read()
TASKS = None
for node in ast.parse(tasks_src).body:
    if isinstance(node, ast.Assign) and node.targets[0].id == "TASKS_TEST":
        TASKS = [call_to_obj(e) for e in node.value.elts]

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "tools.json"), "w") as f:
    json.dump([TOOLS[n].get_info() for n in TOOLS], f, indent=2)
    f.write("\n")
with open(os.path.join(OUT, "tasks-test.json"), "w") as f:
    json.dump(TASKS, f, indent=2)
    f.write("\n")

oracle = {"seed_hash": consistent_hash(to_hashable(BASE)), "tasks": [], "cases": [], "calculate": []}

# --- every gold action of every test task ---
for i, t in enumerate(TASKS):
    data = copy.deepcopy(BASE)
    steps = []
    for a in t["actions"]:
        if a["name"] in TERMINATE:
            steps.append({"name": a["name"], "skipped_terminate": True})
            continue
        obs = step(data, a["name"], a["kwargs"])
        steps.append({"name": a["name"], "error": obs.startswith("Error") or obs.startswith("Unknown action"), **obs_record(obs)})
    oracle["tasks"].append({"index": i, "steps": steps, "final_hash": consistent_hash(to_hashable(data))})

# --- per-tool edge cases (fresh data each) ---
U = "yusuf_rossi_9620"
CASES = [
    ("find_user_id_by_email", {"email": "yusuf.rossi7301@example.com"}),
    ("find_user_id_by_email", {"email": "YUSUF.ROSSI7301@EXAMPLE.COM"}),
    ("find_user_id_by_email", {"email": "nobody@example.com"}),
    ("find_user_id_by_email", {"email": 42}),
    ("find_user_id_by_email", {}),
    ("find_user_id_by_email", {"email": "a@b.c", "extra": 1}),
    ("find_user_id_by_name_zip", {"first_name": "yusuf", "last_name": "ROSSI", "zip": "19122"}),
    ("find_user_id_by_name_zip", {"first_name": "Yusuf", "last_name": "Rossi", "zip": 19122}),
    ("find_user_id_by_name_zip", {"first_name": "Yusuf", "last_name": "Rossi"}),
    ("get_user_details", {"user_id": U}),
    ("get_user_details", {"user_id": "nope"}),
    ("get_order_details", {"order_id": "#W2378156"}),
    ("get_order_details", {"order_id": "W2378156"}),
    ("get_product_details", {"product_id": "1656367028"}),
    ("get_product_details", {"product_id": "1151293680"}),
    ("list_all_product_types", {}),
    ("list_all_product_types", {"x": 1}),
    ("think", {"thought": "hmm"}),
    ("transfer_to_human_agents", {"summary": "s"}),
    ("no_such_tool", {}),
    # cancel
    ("cancel_pending_order", {"order_id": "#W2378156", "reason": "no longer needed"}),
    ("cancel_pending_order", {"order_id": "#XXXX", "reason": "no longer needed"}),
    ("cancel_pending_order", {"order_id": "#W4817420", "reason": "too expensive"}),
    ("cancel_pending_order", {"order_id": "#W4817420", "reason": "ordered by mistake"}),
    ("cancel_pending_order", {"order_id": "#W4817420"}),
    # return
    ("return_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["4983901480"], "payment_method_id": "credit_card_9513926"}),
    ("return_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["4983901480"], "payment_method_id": "paypal_0000000"}),
    ("return_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["0000000000"], "payment_method_id": "credit_card_9513926"}),
    ("return_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["4983901480", "4983901480"], "payment_method_id": "credit_card_9513926"}),
    ("return_delivered_order_items", {"order_id": "#W2378156", "item_ids": [], "payment_method_id": "credit_card_9513926"}),
    ("return_delivered_order_items", {"order_id": "#W2378156", "item_ids": "4983901480", "payment_method_id": "credit_card_9513926"}),
    ("return_delivered_order_items", {"order_id": "#W4817420", "item_ids": ["6777246137"], "payment_method_id": "credit_card_9513926"}),
    # exchange
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["1151293680", "4983901480"], "new_item_ids": ["7706410293", "7747408585"], "payment_method_id": "credit_card_9513926"}),
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": [], "new_item_ids": [], "payment_method_id": "credit_card_9513926"}),
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["1151293680"], "new_item_ids": [], "payment_method_id": "credit_card_9513926"}),
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["1151293680"], "new_item_ids": ["7747408585"], "payment_method_id": "credit_card_9513926"}),
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["1151293680"], "new_item_ids": ["7706410293"], "payment_method_id": "gift_card_0000000"}),
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["1151293680"], "new_item_ids": ["7706410293"], "payment_method_id": 7}),
    ("exchange_delivered_order_items", {"order_id": "#W4817420", "item_ids": ["6777246137"], "new_item_ids": ["6777246137"], "payment_method_id": "credit_card_9513926"}),
    # modify items / address / payment / user address
    ("modify_pending_order_items", {"order_id": "#W4817420", "item_ids": ["6777246137"], "new_item_ids": ["4615543240"], "payment_method_id": "credit_card_9513926"}),
    ("modify_pending_order_items", {"order_id": "#W4817420", "item_ids": [], "new_item_ids": [], "payment_method_id": "credit_card_9513926"}),
    ("modify_pending_order_address", {"order_id": "#W4817420", "address1": "1 A St", "address2": "", "city": "X", "state": "PA", "country": "USA", "zip": "19122"}),
    ("modify_pending_order_address", {"order_id": "#W4817420", "address1": "1 A St", "city": "X", "state": "PA", "country": "USA", "zip": "19122"}),
    ("modify_pending_order_payment", {"order_id": "#W4817420", "payment_method_id": "credit_card_9513926"}),
    ("modify_user_address", {"user_id": U, "address1": "1 A St", "address2": "Apt 2", "city": "X", "state": "PA", "country": "USA", "zip": 19122}),
    ("modify_user_address", {"user_id": "nope", "address1": "1", "address2": "", "city": "X", "state": "PA", "country": "USA", "zip": "1"}),
    ("get_order_details", {"order_id": ["#W2378156"]}),
    ("get_order_details", {"order_id": 2378156}),
    ("get_order_details", {"order_id": None}),
    ("get_user_details", {"user_id": U, "data": {}}),
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": {"1151293680": 1}, "new_item_ids": ["7706410293"], "payment_method_id": "credit_card_9513926"}),
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": ["1151293680"], "new_item_ids": "7706410293", "payment_method_id": "credit_card_9513926"}),
    ("exchange_delivered_order_items", {"order_id": "#W2378156", "item_ids": 5, "new_item_ids": [], "payment_method_id": "credit_card_9513926"}),
    ("return_delivered_order_items", {"order_id": "#W2378156", "item_ids": None, "payment_method_id": "credit_card_9513926"}),
    ("find_user_id_by_name_zip", {"first_name": None, "last_name": "Rossi", "zip": "19122"}),
    ("find_user_id_by_name_zip", {"first_name": "Yusuf", "last_name": 3, "zip": "19122"}),
    ("cancel_pending_order", {"order_id": "#W2378156", "reason": "no longer needed", "foo": 1, "bar": 2}),
    ("modify_pending_order_address", {"order_id": "#W2378156"}),
    ("calculate", {"expression": 5}),
    ("calculate", {"expression": None}),
    ("calculate", {"expression": ["1", "+", "2"]}),
    ("calculate", {"expression": ["a"]}),
    ("think", {}),
    ("transfer_to_human_agents", {"summary": 1}),
]


# pick real pending / gift-card fixtures from the data so cases exercise success paths
def first(pred, items):
    for k, v in items:
        if pred(k, v):
            return k, v
    return None, None


pending_gc_oid, pending_gc = first(
    lambda k, o: o["status"] == "pending"
    and len(o["payment_history"]) == 1
    and "gift_card" in o["payment_history"][0]["payment_method_id"],
    BASE["orders"].items(),
)
pending_cc_oid, pending_cc = first(
    lambda k, o: o["status"] == "pending"
    and len(o["payment_history"]) == 1
    and "credit_card" in o["payment_history"][0]["payment_method_id"]
    and any(pm.startswith("gift_card") for pm in BASE["users"][o["user_id"]]["payment_methods"]),
    BASE["orders"].items(),
)
delivered_oid, delivered = first(lambda k, o: o["status"] == "delivered", BASE["orders"].items())
EXTRA = []
if pending_gc_oid:
    u = BASE["users"][pending_gc["user_id"]]
    other = next((pm for pm in u["payment_methods"] if pm != pending_gc["payment_history"][0]["payment_method_id"]), None)
    EXTRA += [
        ("cancel_pending_order", {"order_id": pending_gc_oid, "reason": "ordered by mistake"}),
        ("modify_pending_order_payment", {"order_id": pending_gc_oid, "payment_method_id": pending_gc["payment_history"][0]["payment_method_id"]}),
    ]
    if other:
        EXTRA.append(("modify_pending_order_payment", {"order_id": pending_gc_oid, "payment_method_id": other}))
if pending_cc_oid:
    u = BASE["users"][pending_cc["user_id"]]
    gcs = [pm for pm in u["payment_methods"] if pm.startswith("gift_card")]
    for gc in gcs:
        EXTRA.append(("modify_pending_order_payment", {"order_id": pending_cc_oid, "payment_method_id": gc}))
    item = pending_cc["items"][0]
    variants = BASE["products"][item["product_id"]]["variants"]
    alt = next((vid for vid, v in variants.items() if vid != item["item_id"] and v["available"]), None)
    unavailable = next((vid for vid, v in variants.items() if not v["available"]), None)
    if alt:
        EXTRA.append(("modify_pending_order_items", {"order_id": pending_cc_oid, "item_ids": [item["item_id"]], "new_item_ids": [alt], "payment_method_id": pending_cc["payment_history"][0]["payment_method_id"]}))
        for gc in gcs:
            EXTRA.append(("modify_pending_order_items", {"order_id": pending_cc_oid, "item_ids": [item["item_id"]], "new_item_ids": [alt], "payment_method_id": gc}))
    if unavailable:
        EXTRA.append(("modify_pending_order_items", {"order_id": pending_cc_oid, "item_ids": [item["item_id"]], "new_item_ids": [unavailable], "payment_method_id": pending_cc["payment_history"][0]["payment_method_id"]}))
    EXTRA.append(("exchange_delivered_order_items", {"order_id": pending_cc_oid, "item_ids": [item["item_id"]], "new_item_ids": [item["item_id"]], "payment_method_id": pending_cc["payment_history"][0]["payment_method_id"]}))
if delivered_oid:
    u = BASE["users"][delivered["user_id"]]
    gcs = [pm for pm in u["payment_methods"] if pm.startswith("gift_card")]
    for gc in gcs:
        EXTRA.append(("return_delivered_order_items", {"order_id": delivered_oid, "item_ids": [delivered["items"][0]["item_id"]], "payment_method_id": gc}))

for name, kwargs in CASES + EXTRA:
    data = copy.deepcopy(BASE)
    obs = step(data, name, kwargs)
    oracle["cases"].append({"name": name, "kwargs": kwargs, **obs_record(obs), "post_hash": consistent_hash(to_hashable(data))})

CALC = [
    "2 + 2", "1093.34 - 999.99", "(1 + 2) * 3", "10 / 4", "7 // 2", "-7 // 2", "7.5 // 2", "2 ** 10", "2 ** -1",
    "2 ** 0.5", "-2 ** 2", "(-2) ** 2", "1 / 3", "2 / 3", "100", "100.0", "0.1 + 0.2", "1e5", "1/0", "1.0/0", "1//0",
    "1.0//0", "0 ** -1", "", "   ", "2 +", "(1", "1)", "()", "1.5.2", "007", "0", "00", "0.0", ".5", "5.", "--5", "+-5",
    "- 3", "3 - - 3", "2*-3", "10**400", "10.0**400", "(-8) ** (1/3)", "2 ** 3 ** 2", "8 / 2 / 2", "8 - 2 - 2",
    "1.005 * 100", "2.675", "0.125", "0.375", "1.115", "123456789 * 987654321", "10 ** 20", "10 ** 15 + 0.5",
    "1e-5", "0.00001", "0.004", "0.005", "0.015", "-0.005", "-1.115", "54.04 + 41.64", "3 * 1093.34",
    "__import__('os')", "process.exit(1)", "1; 2", "[1]", "1,2", "abs(-1)", "1 % 2", "2 ^ 3", "1 < 2", "a",
    "require('child_process')", "1+1)\n", "1 2", "(((((1)))))", "((2)) * ((3))", "1_000", "0x10", "1e", "9" * 400,
    "1/7", "22/7*1000", "1 - 0.9", "100 * 1.1", "2 // 0.3", "-2 // 0.3", "0.3 // 0.1", "1e16", "12345678901234567890",
    "100 ** 10", "-0.0", "- 0", "0 * -1", "1 / -3",
    "10**30 / 3", "10**30 / 10**29", "2**60 / 3", "(2**53 + 1) / 1", "10**400 / 10**399", "0 / -5", "-0 / 5",
    "7 // -2", "-7 // -2", "7.0 // -2", "2 ** 0", "0 ** 0", "0.0 ** 0", "(-2) ** 0.5", "(-8) ** 3", "(-8.0) ** 3",
    "4 ** 0.5", "2 ** 1024", "2.0 ** 1024", "2 ** 1023 * 2.0", "1" + "0" * 308 + ".0 * 10", "() + ()", "() * 3",
    "1 + ()", "-()", "() ** 2", "2 * ()", "() * 2.0", "( )", "1 + (2 * (3 - 4)) / 5", "100 - 33.33 * 3", "0.1 * 3",
    "1.1 + 2.2", "3.3 / 1.1", "(1 2)", "2 ** ** 2", "*2", "/2", "2 * * 3", "2 / / 3", "2 // / 3", "1.", "1..2", "..",
    ".", "-", "+", "( 1 + 2", "1 + 2 )", "007.5", "00.5", "01", "000", "0.000", "1000000000000000000000.0",
    "123456789012345678901234567890.0", "0.1 + 0.7", "4.35 * 100", "1.15 * 100", "8.345", "1.255", "2.5", "3.5",
    "-2.5", "0.5", "1.5 + 0.005", "0.625", "0.875", "1.125", "-0.125", "-0.375", "5e-324", "1/3*3", "2**-1074",
    "2.0**-1075", "(1)(2)", "2(3)", "(2)3", "1 + + 1", "1 - - - 1", "--", "3 ** 2 ** -1", "-3 ** 2", "(-3) ** 2",
    "2 ** 3 ** 4", "1 / 3 + 1 / 3 + 1 / 3", "999999999999999.99", "0.0001", "0.00049", "0.0049", "12345.678",
    "(1 + 2 3)", "(1 2 +)", "((1) 2)", "(1 (2))", "()()", "(1)()", "(1)(1/0)", "1 (2) (3)", "((1)(2))", "(2) ** (3)(4)",
]
for expr in CALC:
    obs = step({}, "calculate", {"expression": expr})
    oracle["calculate"].append({"expression": expr, "result": obs})

with open(os.path.join(OUT, "upstream-oracle.json"), "w") as f:
    json.dump(oracle, f, indent=1)
    f.write("\n")
print(json.dumps({"tools": len(TOOLS), "tasks": len(TASKS), "cases": len(oracle["cases"]), "calculate": len(oracle["calculate"])}))
