import argparse
import asyncio
import importlib
import json

from eval_step1 import EvalContext, run_step1


def parse_args():
    parser = argparse.ArgumentParser(description="Pocket black-box E2E evals")
    parser.add_argument(
        "--step",
        choices=("1", "2", "3", "4", "5", "all"),
        default="all",
    )
    parser.add_argument("--only", action="store_true")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--bootstrap-key", required=True)
    parser.add_argument("--secret-key", required=True)
    return parser.parse_args()


def selected_steps(step_arg: str, only_arg: str) -> tuple[int, ...]:
    if step_arg == "all":
        return (1, 2, 3, 4, 5)
    if only_arg == "only":
        return (int(step_arg),)
    return tuple(range(1, int(step_arg) + 1))


async def run_one_step(ctx: EvalContext, num: int) -> list[str]:
    if num == 1:
        return await run_step1(ctx)
    module_name = "eval_step" + str(num)
    try:
        mod = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        msg = "Missing E2E eval module scripts/eval/" + module_name + ".py"
        raise RuntimeError(msg) from exc
    runner = getattr(mod, "run_step" + str(num))
    return await runner(ctx)


async def run_selected(ctx: EvalContext, steps: tuple[int, ...]) -> list[str]:
    checks: list[str] = []
    for num in steps:
        checks.extend(await run_one_step(ctx, num))
    return checks


async def async_main() -> int:
    args = parse_args()
    ctx = EvalContext(
        base_url=args.base_url.rstrip("/"),
        database_url=args.database_url,
        bootstrap_key=args.bootstrap_key,
        secret_key=args.secret_key,
    )
    mode = "only" if args.only else "cumulative"
    steps = selected_steps(args.step, mode)
    checks = await run_selected(ctx, steps)
    summary = {"ok": True, "steps": list(steps), "passed_checks": checks}
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(async_main()))
