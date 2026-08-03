#!/usr/bin/env node
/**
 * τ-bench retail tool CLI against a worktree JSON DB (orders/products/users).
 * Usage:
 *   node scripts/tau-retail-cli.mjs --cwd <worktree> <tool> --args '<json>'
 *   node scripts/tau-retail-cli.mjs --cwd <worktree> hash
 *   node scripts/tau-retail-cli.mjs --cwd <worktree> apply-gold --actions '<json array>'
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SEED = join(root, "case-studies/tau-bench/world/data");

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = { cwd: process.cwd() };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--args") out.args = argv[++i];
    else if (a === "--actions") out.actions = argv[++i];
    else if (a === "--seed") out.seed = argv[++i];
    else rest.push(a);
  }
  out._ = rest;
  return out;
}

function loadData(cwd) {
  const dataDir = join(cwd, "data");
  return {
    orders: JSON.parse(readFileSync(join(dataDir, "orders.json"), "utf8")),
    products: JSON.parse(readFileSync(join(dataDir, "products.json"), "utf8")),
    users: JSON.parse(readFileSync(join(dataDir, "users.json"), "utf8")),
  };
}

function saveData(cwd, data) {
  const dataDir = join(cwd, "data");
  writeFileSync(join(dataDir, "orders.json"), JSON.stringify(data.orders, null, 2) + "\n");
  writeFileSync(join(dataDir, "products.json"), JSON.stringify(data.products, null, 2) + "\n");
  writeFileSync(join(dataDir, "users.json"), JSON.stringify(data.users, null, 2) + "\n");
}

/** Match tau_bench.envs.base consistent_hash / to_hashable for dicts/lists. */
function toHashable(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return Object.keys(item)
      .sort()
      .map((k) => [k, toHashable(item[k])]);
  }
  if (Array.isArray(item)) return item.map(toHashable);
  return item;
}

function dataHash(data) {
  return createHash("sha256").update(JSON.stringify(toHashable(data))).digest("hex");
}

/**
 * @param {Record<string, any>} data
 * @param {string} name
 * @param {Record<string, any>} kwargs
 */
function invoke(data, name, kwargs) {
  switch (name) {
    case "find_user_id_by_name_zip": {
      const { first_name, last_name, zip } = kwargs;
      for (const [uid, u] of Object.entries(data.users)) {
        if (
          u.name?.first_name === first_name &&
          u.name?.last_name === last_name &&
          u.address?.zip === zip
        ) {
          return uid;
        }
      }
      return "Error: user not found";
    }
    case "find_user_id_by_email": {
      const email = kwargs.email;
      for (const [uid, u] of Object.entries(data.users)) {
        if (u.email === email) return uid;
      }
      return "Error: user not found";
    }
    case "get_user_details": {
      const u = data.users[kwargs.user_id];
      return u ? JSON.stringify(u) : "Error: user not found";
    }
    case "get_order_details": {
      const o = data.orders[kwargs.order_id];
      return o ? JSON.stringify(o) : "Error: order not found";
    }
    case "get_product_details": {
      const p = data.products[kwargs.product_id];
      return p ? JSON.stringify(p) : "Error: product not found";
    }
    case "list_all_product_types": {
      const types = [...new Set(Object.values(data.products).map((p) => p.name))].sort();
      return JSON.stringify(types);
    }
    case "cancel_pending_order": {
      const order = data.orders[kwargs.order_id];
      if (!order) return "Error: order not found";
      if (order.status !== "pending") return "Error: non-pending order cannot be cancelled";
      if (!["no longer needed", "ordered by mistake"].includes(kwargs.reason)) {
        return "Error: invalid reason";
      }
      const refunds = [];
      for (const payment of order.payment_history || []) {
        const payment_id = payment.payment_method_id;
        refunds.push({
          transaction_type: "refund",
          amount: payment.amount,
          payment_method_id: payment_id,
        });
        if (String(payment_id).includes("gift_card")) {
          const pm = data.users[order.user_id].payment_methods[payment_id];
          pm.balance = Math.round((pm.balance + payment.amount) * 100) / 100;
        }
      }
      order.status = "cancelled";
      order.cancel_reason = kwargs.reason;
      order.payment_history = [...(order.payment_history || []), ...refunds];
      return JSON.stringify(order);
    }
    case "return_delivered_order_items": {
      const order = data.orders[kwargs.order_id];
      if (!order) return "Error: order not found";
      if (order.status !== "delivered") return "Error: non-delivered order cannot be returned";
      const item_ids = kwargs.item_ids || [];
      const all = (order.items || []).map((i) => i.item_id);
      for (const id of item_ids) {
        if (item_ids.filter((x) => x === id).length > all.filter((x) => x === id).length) {
          return "Error: some item not found";
        }
      }
      order.status = "return requested";
      order.return_items = [...item_ids].sort();
      order.return_payment_method_id = kwargs.payment_method_id;
      return JSON.stringify(order);
    }
    case "exchange_delivered_order_items": {
      const order = data.orders[kwargs.order_id];
      if (!order) return "Error: order not found";
      if (order.status !== "delivered") return "Error: non-delivered order cannot be exchanged";
      order.status = "exchange requested";
      order.exchange_items = [...(kwargs.item_ids || [])].sort();
      order.exchange_new_items = [...(kwargs.new_item_ids || [])].sort();
      order.exchange_payment_method_id = kwargs.payment_method_id;
      return JSON.stringify(order);
    }
    case "modify_pending_order_address": {
      const order = data.orders[kwargs.order_id];
      if (!order) return "Error: order not found";
      if (order.status !== "pending") return "Error: non-pending order cannot be modified";
      order.address = {
        address1: kwargs.address1,
        address2: kwargs.address2 ?? "",
        city: kwargs.city,
        country: kwargs.country,
        state: kwargs.state,
        zip: kwargs.zip,
      };
      return JSON.stringify(order);
    }
    case "modify_pending_order_items": {
      const order = data.orders[kwargs.order_id];
      if (!order) return "Error: order not found";
      if (order.status !== "pending") return "Error: non-pending order cannot be modified";

      const item_ids = kwargs.item_ids || [];
      const new_item_ids = kwargs.new_item_ids || [];
      const payment_method_id = kwargs.payment_method_id;
      const all_item_ids = (order.items || []).map((i) => i.item_id);

      for (const id of item_ids) {
        if (item_ids.filter((x) => x === id).length > all_item_ids.filter((x) => x === id).length) {
          return `Error: ${id} not found`;
        }
      }
      if (item_ids.length !== new_item_ids.length) {
        return "Error: the number of items to be exchanged should match";
      }

      let diff_price = 0;
      for (let i = 0; i < item_ids.length; i++) {
        const item_id = item_ids[i];
        const new_item_id = new_item_ids[i];
        const item = (order.items || []).find((it) => it.item_id === item_id);
        const product_id = item.product_id;
        const variant = data.products[product_id]?.variants?.[new_item_id];
        if (!variant?.available) {
          return `Error: new item ${new_item_id} not found or available`;
        }
        diff_price += variant.price - item.price;
      }

      const user = data.users[order.user_id];
      const payment_method = user?.payment_methods?.[payment_method_id];
      if (!payment_method) return "Error: payment method not found";
      if (payment_method.source === "gift_card" && payment_method.balance < diff_price) {
        return "Error: insufficient gift card balance to pay for the new item";
      }

      order.payment_history = order.payment_history || [];
      order.payment_history.push({
        transaction_type: diff_price > 0 ? "payment" : "refund",
        amount: Math.abs(diff_price),
        payment_method_id,
      });
      if (payment_method.source === "gift_card") {
        payment_method.balance = Math.round((payment_method.balance - diff_price) * 100) / 100;
      }

      for (let i = 0; i < item_ids.length; i++) {
        const item_id = item_ids[i];
        const new_item_id = new_item_ids[i];
        const item = (order.items || []).find((it) => it.item_id === item_id);
        const variant = data.products[item.product_id].variants[new_item_id];
        item.item_id = new_item_id;
        item.price = variant.price;
        item.options = variant.options;
      }
      order.status = "pending (item modified)";
      return JSON.stringify(order);
    }
    case "modify_user_address": {
      const user = data.users[kwargs.user_id];
      if (!user) return "Error: user not found";
      user.address = {
        address1: kwargs.address1,
        address2: kwargs.address2 ?? "",
        city: kwargs.city,
        country: kwargs.country,
        state: kwargs.state,
        zip: kwargs.zip,
      };
      return JSON.stringify(user);
    }
    case "transfer_to_human_agents":
      return JSON.stringify({ ok: true, reason: kwargs.summary ?? "" });
    case "think":
      return "ok";
    case "calculate":
      try {
        // eslint-disable-next-line no-new-func
        return String(Function(`"use strict"; return (${kwargs.expression})`)());
      } catch {
        return "Error: invalid expression";
      }
    default:
      return `Error: unknown tool ${name}`;
  }
}

function ensureSeed(cwd, seedDir) {
  const dataDir = join(cwd, "data");
  if (!existsSync(join(dataDir, "orders.json"))) {
    mkdirSync(dataDir, { recursive: true });
    cpSync(seedDir, dataDir, { recursive: true });
  }
  const wikiSrc = join(root, "case-studies/tau-bench/world/wiki.md");
  if (existsSync(wikiSrc) && !existsSync(join(cwd, "wiki.md"))) {
    writeFileSync(join(cwd, "wiki.md"), readFileSync(wikiSrc));
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd;
  const seed = args.seed ?? DEFAULT_SEED;
  ensureSeed(cwd, seed);
  const cmd = args._[0];
  if (!cmd) {
    console.error("Usage: tau-retail-cli.mjs --cwd <dir> <tool|hash|apply-gold|seed> ...");
    process.exit(2);
  }

  if (cmd === "from-request") {
    const reqPath = join(cwd, "tau", "request.json");
    if (!existsSync(reqPath)) {
      console.log("Error: missing tau/request.json");
      process.exit(1);
    }
    const req = JSON.parse(readFileSync(reqPath, "utf8"));
    const data = loadData(cwd);
    const result = invoke(data, req.tool || req.name, req.kwargs || req.args || {});
    const mutating = [
      "cancel_pending_order",
      "return_delivered_order_items",
      "exchange_delivered_order_items",
      "modify_pending_order_address",
      "modify_pending_order_items",
      "modify_pending_order_payment",
      "modify_user_address",
    ];
    const tool = req.tool || req.name;
    if (mutating.includes(tool) && !String(result).startsWith("Error:")) {
      saveData(cwd, data);
    }
    mkdirSync(join(cwd, "tau"), { recursive: true });
    const resultStr = String(result);
    writeFileSync(join(cwd, "tau", "response.txt"), resultStr);
    // Include result so graders can find required outputs after later overwrites of response.txt.
    writeFileSync(
      join(cwd, "tau", "actions.jsonl"),
      JSON.stringify({ name: tool, kwargs: req.kwargs || req.args || {}, result: resultStr }) + "\n",
      { flag: "a" },
    );
    writeFileSync(join(cwd, "tau", "outputs.log"), resultStr + "\n", { flag: "a" });
    console.log(result);
    return;
  }

  if (cmd === "seed") {
    mkdirSync(join(cwd, "data"), { recursive: true });
    cpSync(seed, join(cwd, "data"), { recursive: true });
    const wikiSrc = join(root, "case-studies/tau-bench/world/wiki.md");
    if (existsSync(wikiSrc)) writeFileSync(join(cwd, "wiki.md"), readFileSync(wikiSrc));
    console.log(JSON.stringify({ ok: true, cwd }));
    return;
  }

  if (cmd === "hash") {
    const data = loadData(cwd);
    console.log(dataHash(data));
    return;
  }

  if (cmd === "apply-gold") {
    const actions = JSON.parse(args.actions || "[]");
    const data = loadData(cwd);
    for (const a of actions) {
      invoke(data, a.name, a.kwargs || {});
    }
    saveData(cwd, data);
    console.log(JSON.stringify({ ok: true, hash: dataHash(data) }));
    return;
  }

  const kwargs = JSON.parse(args.args || "{}");
  const data = loadData(cwd);
  const result = invoke(data, cmd, kwargs);
  // Persist after mutating tools
  const mutating = [
    "cancel_pending_order",
    "return_delivered_order_items",
    "exchange_delivered_order_items",
    "modify_pending_order_address",
    "modify_pending_order_items",
    "modify_pending_order_payment",
    "modify_user_address",
  ];
  if (mutating.includes(cmd) && !String(result).startsWith("Error:")) {
    saveData(cwd, data);
  }
  console.log(result);
}

main();
