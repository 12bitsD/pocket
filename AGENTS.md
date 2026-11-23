# Pocket Agent Instructions

## Required coding style

All code in this repository uses **Bits’s Coding Style v0.3.5**, including tests and every supported language.

Before creating, editing, reviewing, or refactoring code, invoke the project `bits-style` skill at `.agents/skills/bits-style/SKILL.md` and follow its workflow. Canonical references are `STYLE.md` and `PROTOCOL.md` in https://github.com/12bitsD/bits-style.

## Completion checks

1. Classify scanner results with `npm run style:report`; address high-confidence semantic issues before warnings.
2. Make the smallest behavior-preserving fix, then run `npm test` and `npm run check`.
3. Run `npm run style:diff` for every change. `npm run style:fix` is limited to deterministic whitespace fixes and must be followed by a second scan.
4. Finish with no new high-confidence violations and all project checks passing. Report remaining warnings and unsupported files separately.

## Guardrails

- Preserve external JSON, FFI, ABI, and framework callback contracts.
- Split functions only when that reduces cognitive load; `bits:explain(BCS003)` is a last resort.
- Use `bits:allow(rule): reason` only for a concrete contract or low-confidence case. Do not add blanket suppressions or update `bits-baseline.json` merely to make a change pass.
- Keep compiler, formatter, and real test failures as hard failures. `unsupported` is not passed; `warning` is not a hard failure.

## Design standard

All UI, prototype, and styling work across Clock, Calendar, Notes, and `packages/design-system` must follow [docs/design-standard.md](docs/design-standard.md). When a user review introduces new visual or interaction rules or refines existing ones, update `docs/design-standard.md` and its changelog in the same change.
