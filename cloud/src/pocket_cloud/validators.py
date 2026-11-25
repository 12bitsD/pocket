from datetime import date
import re

from .errors import RpcError

HHMM_PATTERN = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")


def require_text(raw, code: str, message: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise RpcError(422, code, message)
    return raw.strip()


def parse_iso_date(raw, field_name: str) -> date:
    msg = "%s must be YYYY-MM-DD" % field_name
    if not isinstance(raw, str):
        raise RpcError(422, "INVALID_DATE", msg)
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise RpcError(422, "INVALID_DATE", msg)


def parse_hhmm(raw, field_name: str) -> str:
    if not isinstance(raw, str) or not HHMM_PATTERN.fullmatch(raw):
        raise RpcError(422, "INVALID_TIME", "%s must be HH:MM" % field_name)
    return raw


def parse_optional_id(raw, field_name: str) -> str | None:
    if raw is None:
        return None
    msg = "%s must be a non-empty string" % field_name
    return require_text(raw, "INVALID_ID", msg)


def parse_required_id(raw, field_name: str) -> str:
    parsed = parse_optional_id(raw, field_name)
    if parsed is None:
        raise RpcError(422, "INVALID_ID", "%s is required" % field_name)
    return parsed


def parse_optional_revision(raw) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
        raise RpcError(
            422, "INVALID_REVISION", "base_revision must be positive integer"
        )
    return raw


def parse_int_bounds(
    raw, bounds: tuple[int, int], err: tuple[str, str]
) -> int:
    low, high = bounds
    if isinstance(raw, bool) or not isinstance(raw, int) or not (
        low <= raw <= high
    ):
        raise RpcError(422, err[0], err[1])
    return raw


def parse_bool_field(params: dict, key: str, defaults: dict) -> bool:
    val = params.get(key, defaults.get(key, False))
    if not isinstance(val, bool):
        raise RpcError(422, "INVALID_PARAMS", "%s must be a boolean" % key)
    return val


def verify_revision(
    actual_rev: int,
    deleted_at,
    base_rev: int | None,
    not_found: tuple[str, str],
) -> None:
    if deleted_at is not None:
        raise RpcError(404, not_found[0], not_found[1])
    if base_rev is not None and base_rev != actual_rev:
        raise RpcError(409, "REVISION_CONFLICT", "Revision mismatch")
