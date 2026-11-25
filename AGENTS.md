# Pocket Agent Instructions

## Required coding style

All code in this repository uses **Bits’s Coding Style V0.4 (`bits v0.5.0`)**, including tests and every supported language.

Before creating, editing, reviewing, or refactoring code, invoke the project `bits-style` skill at `.agents/skills/bits-style/SKILL.md` and follow its workflow. Canonical references are `STYLE.md` and `PROTOCOL.md` in https://github.com/12bitsD/bits-style.

## Completion checks

1. Classify scanner results with `npm run style:report`; address high-confidence semantic issues before warnings.
2. Make the smallest behavior-preserving fix, then run `npm test` and `npm run check`.
3. Run `npm run style:diff` for every change. `npm run style:fix` is limited to deterministic whitespace fixes and must be followed by a second scan.
4. For L2 taste review, inspect changed/branchy diff functions and L1 warning sites using the four V0.4 dimensions (level purity, control-flow flatness & single-source dispatch, information gain & contract airlock, interface tax & symmetry). Stay silent when no concrete issue exists.
5. Finish with no new high-confidence violations and all project checks passing. Report remaining warnings and unsupported files (`.kt`, `.sh`) separately.

## Guardrails

- Preserve external JSON, FFI, ABI, and framework callback contracts.
- Do not split cohesive logic merely to satisfy line or variable counts. Resolve smells in order: delete redundant layers → bind data/schema/handlers (e.g. `argparse` `set_defaults`) → split by responsibility → scarce `bits:prove`.
- Apply the interface-tax test before splitting: if inlining a single-call helper adds no new caller knowledge or invariant, keep it inline.
- Warnings do not require comments. `bits:allow(rule): reason` is strictly for external hard contracts; `bits:prove(rule[, test=name]): minimal reason; concrete risk` is for warnings only (max 1 new per diff, requires independent Critic/human review, `test=name` must resolve to a unique test). Unused `allow`/`prove` annotations and newly added legacy `bits:explain` in diff mode are `BCS015` hard errors.
- Keep `bits:spec(pure)` functions free of direct or transitive IO (`BCS017`); register project IO entrypoints in `bits.toml` `io_sources` when needed.
- Do not update `bits-baseline.json` merely to make a change pass.
- Keep compiler, formatter, and real test failures as hard failures. `unsupported` is not passed; `warning` is not a hard failure.

## Design standard

All UI, prototype, and styling work across Clock, Calendar, Notes, and `packages/design-system` must follow [docs/design-standard.md](docs/design-standard.md). When a user review introduces new visual or interaction rules or refines existing ones, update `docs/design-standard.md` and its changelog in the same change.
