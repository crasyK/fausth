# Deny log as sensor

> Notion draft for Concepts & models (publish when Notion MCP is available).
> Source: agent-challenge crosscheck, 2026-07-30.

**Type:** Framework · **Status:** Validated · **Talk relevance:** 25-min / article

## What it is

The harness is not only a constraint system — it is a **measurement instrument**. Security hides disposition; gates and deny events reveal it.

## Core claims

1. **Deny telemetry is first-class evidence.** Closed reason codes (`capability_missing`, structured `failure` objects, `sequence_requirement_failed`, …) form a detection grammar.
2. **Permissive ablation is a sensor.** The case-study “permissive control” (all tools open) is not merely a baseline — it measures whether capability provisioning carries weight and what the model’s raw tendencies are.
3. **Security without measurement is opaque.** A well-behaved agent and a well-fenced agent look the same from the outside. Deny logs and ablations make the difference observable.

## Self-learning loop

Mutation + selection needs a fitness function:

- Track A goldens = selection / regression gate
- Deny-rate and structured failure aggregates = live disposition sensors
- `fausth audit` (M14) = operator tool that reads the sensor

## Anti-pattern

Building honeypots that *advertise* forbidden tools so you can catch attempts. Prefer honest provisioning + reading `capability_missing` from the log.

## Relation

- Counterbalance Architecture · Control timing (cannot / may not / did not)
- Fausth: M14 `fausth audit` · coding case-study permissive control
