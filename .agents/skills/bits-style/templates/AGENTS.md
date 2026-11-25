# Bits’s Coding Style

Version: v0.5.0.

Canonical documents: `STYLE.md` and `PROTOCOL.md` from https://github.com/12bitsD/bits-style.

## Workflow

1. Run `bits style report .` and classify violations, warnings, unsupported files and external contracts.
2. Fix high-confidence semantic issues first: dependency cycles, unreachable code, empty catch, real parameter reassignment, nested ternaries, real nesting and cyclomatic complexity.
3. Run the project’s formatter, type checks and real tests after every fix.
4. Use `bits style fix --diff --commit origin/main` for incremental formatting changes. It is restricted to deterministic whitespace changes.
5. Re-run the same scan and tests. Report remaining warnings and unsupported files explicitly.

## Guardrails

- Do not perform whole-repository mechanical rewrites to reach zero violations.
- Do not change external JSON, Pydantic, FFI, ABI or framework callback contracts to satisfy a rule.
- Do not split cohesive logic just to satisfy a line or variable threshold. Resolve smells in order: delete redundant layers → bind data/schema/handlers → split by responsibility → scarce proof.
- Warnings do not require comments. `bits:allow(rule): reason` is only for external hard contracts; `bits:prove(rule[, test=name]): minimal reason; concrete risk` is for warnings only, max 1 new per diff, requires independent Critic/human approval, and `test=name` must resolve to a unique real test definition. Unused `allow`/`prove` annotations and newly added legacy `bits:explain` in diff mode are hard errors.
- Apply the interface-tax test before splitting: if inlining a single-call helper adds no new caller knowledge or invariant, keep it inline. Do not split cohesive logic or encode conditions into opaque lookup keys to satisfy metrics.
- Do not mirror downstream SDK/model parameter validation in pass-through layers; validate only module-owned invariants and wrap/forward downstream errors. Bind handlers directly to parsed structures (e.g. argparse `set_defaults`) instead of re-branching on command strings.
- Keep `bits:spec(pure)` functions free of direct or transitive IO (`BCS017`); pass external data in and register project IO entrypoints in `bits.toml` `io_sources`.
- In diff mode, never increase nesting or cyclomatic complexity in an already-over-threshold function, and never add new over-threshold functions; reduce them so the `improving` ratchet applies.
- For L2 taste review, inspect only changed/branchy diff functions and L1 warning sites using level purity, control-flow flatness, information gain, and symmetry. Stay silent when there is no concrete issue.
- `unsupported` is not passed. `warning` is not a hard failure. Compile errors, formatter errors and real test failures remain hard failures.
- A task is complete only when the same scanner reports no new high-confidence violation, all project checks pass, and remaining warnings/unsupported items are reported honestly.
