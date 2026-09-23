# Architecture Decision Records (ADR)

## Purpose

CLAUDE.md · DOCUMENTATION: "ADR only for a decision that CHANGES the architecture. Everything else → CHANGELOG.md."
An ADR is written only when a decision changes the architecture or a non-negotiable rule of CLAUDE.md
(ARCHITECTURE, BUILD METHOD, AGENT CONSTRAINTS). Everything else — task outcomes, fixes, carried-forward
items — goes to `docs/CHANGELOG.md`. Working notes go to `docs/notes/`. An ADR is never a numbered package document.

## Who writes it

An ADR is written and reviewed on **opus** (`docs/MODEL_ROUTING.md` routing table, row "ADR / architecture / security design →
Master on opus"; CLAUDE.md · MODEL ROUTING "Escalation … for ADR/security"). It takes effect only when the GM
approves it. The header records both.

## Naming

`ADR-NNNN-<slug>.md`

- `NNNN` — four digits, zero-padded (`0001`, `0002`, …), issued in order, never reused (a rejected or
  superseded ADR keeps its number).
- `<slug>` — lowercase kebab-case, English, short (e.g. `1.5-proof-slice`).

## Template

```markdown
# ADR-NNNN — <title>

**Status:** Proposed | Accepted | Superseded by ADR-NNNN | Rejected
**Date:** YYYY-MM-DD
**Approved by:** GM (<directive / decision reference and date>)
**Reviewed & accepted: opus**
**References:** <doc / section / file:line for every fact used>

## Context (السياق)
Facts only, each with its source. No invented table, column, number or rule.

## Decision (القرار)
The decision as approved, verbatim where the GM worded it.

## Alternatives rejected (البدائل المرفوضة)
| Alternative | Why rejected |
|---|---|

## Consequences (الأثر)
Positive, negative / risks, what stays unchanged, open items for the GM.

## Status (الحالة)
Proposed | Accepted | Superseded by ADR-NNNN | Rejected — with the date of each change.
```

A task-specific ADR may add a final section "Application / bookkeeping" (backlog status, commit shape).
A superseded ADR is not edited except for its Status line, which names the superseding ADR.
