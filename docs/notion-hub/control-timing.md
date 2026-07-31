# Control timing — cannot / may not / did not

> Notion draft for Concepts & models (publish when Notion MCP is available).
> Source: agent-challenge crosscheck, 2026-07-30.

**Type:** Framework · **Status:** Validated · **Talk relevance:** 25-min talk

## What it is

The temporal axis of the Counterbalance grid. Each Ability counterweight can bite at three different times — with different epistemology:

| Timing | Name | When | Epistemics |
|--------|------|------|------------|
| Design-time | **Cannot** | Vessel property (YAML tool list) | Auditable offline; a priori |
| Pre-execution | **May not** | Authorize / sequences / gates | Per-attempt; deny before side effects |
| Post-execution | **Did not** | Absence / evidence / output verifies | Per-trace; a posteriori |

## Decision matrix

Choose the control from **irreversibility × enumerability**:

| | Needs enumerable | Harms enumerable |
|--|------------------|------------------|
| **Reversible** | Prefer **cannot** (provision) | Prefer **did not** (absence / output verify) |
| **Irreversible, never legitimate** | **Cannot** — remove the option | N/A (option gone) |
| **Irreversible, sometimes legitimate** | **May not** — keep capability in a role harness + authorize gate | **Did not** as backup telemetry only (autopsy, not prevention) |

## Honeypot post-mortem

Advertise-then-deny (fake affordances) recreates the mode thrash removed in v0.2.

Honest alternative: **provision without the tool**. When an injection or model attempts the missing capability, the engine emits `capability_missing`. That deny event **is** the honeypot signal — without fake tools, without FP cannons pointed at real users.

## Field-guide line

> Mature designs are marked by their *absence* verifies. Ask “what must never happen?” before “what must happen?”

## Relation

- Scientific origin: Agent ⇌ World equilibrium (equal *rates*, not amounts)
- Industry: Thoughtworks guides/sensors (feedforward / feedback)
- Fausth: M12 output verifies · M14 deny audit · capability provisioning
