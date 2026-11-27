"""Feishu Open Platform HTTP client helpers for Calendar OAuth & sync."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import httpx

from .errors import RpcError

FEISHU_API_BASE = "https://open.feishu.cn/open-apis"
FEISHU_AUTH_URL = "https://open.feishu.cn/open-apis/authen/v1/authorize"
FEISHU_SCOPE = "calendar:calendar"


@dataclass(frozen=True)
class FeishuCalTarget:
    user_token: str
    calendar_id: str


def build_authorize_url(app_id: str, redirect_uri: str, state: str) -> str:
    params = urlencode(
        dict(
            app_id=app_id,
            redirect_uri=redirect_uri,
            scope=FEISHU_SCOPE,
            state=state,
        )
    )
    return f"{FEISHU_AUTH_URL}?{params}"


def parse_feishu_json(resp: httpx.Response, err_code: str) -> dict:
    try:
        body = resp.json()
    except ValueError as exc:
        raise RpcError(502, err_code, "Feishu returned non-JSON body") from exc
    if resp.status_code >= 400 or body.get("code", 0) != 0:
        msg = str(body.get("msg") or f"Feishu HTTP {resp.status_code}")
        raise RpcError(502, err_code, msg)
    return body


async def fetch_app_access_token(
    http_client: httpx.AsyncClient, app_id: str, app_secret: str
) -> str:
    resp = await http_client.post(
        f"{FEISHU_API_BASE}/auth/v3/app_access_token/internal",
        json=dict(app_id=app_id, app_secret=app_secret),
    )
    body = parse_feishu_json(resp, "FEISHU_APP_AUTH_FAILED")
    token = str(body.get("app_access_token") or "")
    if not token:
        raise RpcError(502, "FEISHU_APP_AUTH_FAILED", "Empty app_access_token")
    return token


async def exchange_oidc_code(
    http_client: httpx.AsyncClient, app_token: str, code: str
) -> dict:
    resp = await http_client.post(
        f"{FEISHU_API_BASE}/authen/v1/oidc/access_token",
        headers={"Authorization": f"Bearer {app_token}"},
        json=dict(grant_type="authorization_code", code=code),
    )
    data = parse_feishu_json(resp, "FEISHU_OAUTH_FAILED").get("data") or {}
    if not data.get("access_token"):
        raise RpcError(502, "FEISHU_OAUTH_FAILED", "Missing user access_token")
    return data


async def refresh_oidc_token(
    http_client: httpx.AsyncClient, app_token: str, refresh_token: str
) -> dict:
    resp = await http_client.post(
        f"{FEISHU_API_BASE}/authen/v1/oidc/refresh_access_token",
        headers={"Authorization": f"Bearer {app_token}"},
        json=dict(grant_type="refresh_token", refresh_token=refresh_token),
    )
    body = parse_feishu_json(resp, "FEISHU_REFRESH_FAILED")
    data = body.get("data") or {}
    if not data.get("access_token"):
        raise RpcError(502, "FEISHU_REFRESH_FAILED", "Token refresh empty")
    return data


async def fetch_primary_calendar_id(
    http_client: httpx.AsyncClient, user_token: str
) -> str:
    resp = await http_client.post(
        f"{FEISHU_API_BASE}/calendar/v4/calendars/primary",
        headers={"Authorization": f"Bearer {user_token}"},
        json=dict(),
    )
    data = parse_feishu_json(resp, "FEISHU_CALENDAR_FAILED").get("data") or {}
    cals = data.get("calendars") or []
    if cals and isinstance(cals[0], dict):
        cal = cals[0].get("calendar") or cals[0]
        cal_id = str(cal.get("calendar_id") or "")
        if cal_id:
            return cal_id
    return "primary"


async def list_calendar_events(
    http_client: httpx.AsyncClient,
    target: FeishuCalTarget,
    window: tuple[int, int],
) -> list[dict]:
    items: list[dict] = []
    page_token = ""
    headers = {"Authorization": f"Bearer {target.user_token}"}
    url = f"{FEISHU_API_BASE}/calendar/v4/calendars/{target.calendar_id}/events"
    for _ in range(10):
        params = dict(
            start_time=str(window[0]), end_time=str(window[1]), page_size="100"
        )
        if page_token:
            params["page_token"] = page_token
        resp = await http_client.get(url, headers=headers, params=params)
        data = parse_feishu_json(resp, "FEISHU_SYNC_FAILED").get("data") or {}
        items.extend(data.get("items") or [])
        if not data.get("has_more") or not data.get("page_token"):
            break
        page_token = str(data["page_token"])
    return items


def pocket_event_to_feishu_body(
    ev: dict, tz_name: str = "Asia/Shanghai"
) -> dict:
    zone = ZoneInfo(tz_name)
    day = date.fromisoformat(str(ev["event_date"]))
    sh, sm = (int(p) for p in str(ev["start_hhmm"]).split(":"))
    eh, em = (int(p) for p in str(ev["end_hhmm"]).split(":"))
    start_dt = datetime(day.year, day.month, day.day, sh, sm, tzinfo=zone)
    end_dt = datetime(day.year, day.month, day.day, eh, em, tzinfo=zone)
    body = dict(
        summary=str(ev["title"]),
        start_time=dict(
            timestamp=str(int(start_dt.timestamp())), timezone=tz_name
        ),
        end_time=dict(
            timestamp=str(int(end_dt.timestamp())), timezone=tz_name
        ),
    )
    if ev.get("location"):
        body["location"] = dict(name=str(ev["location"]))
    return body


async def push_feishu_event(
    http_client: httpx.AsyncClient,
    target: FeishuCalTarget,
    ev: dict,
    external_id: str | None,
) -> str:
    headers = {"Authorization": f"Bearer {target.user_token}"}
    body = pocket_event_to_feishu_body(ev)
    base = f"{FEISHU_API_BASE}/calendar/v4/calendars/{target.calendar_id}/events"
    if external_id:
        resp = await http_client.patch(
            f"{base}/{external_id}", headers=headers, json=body
        )
    else:
        resp = await http_client.post(base, headers=headers, json=body)
    data = parse_feishu_json(resp, "FEISHU_PUSH_FAILED").get("data") or {}
    created = data.get("event") or data
    return str(created.get("event_id") or external_id or "")


async def remove_feishu_event(
    http_client: httpx.AsyncClient,
    target: FeishuCalTarget,
    external_id: str,
) -> None:
    base = f"{FEISHU_API_BASE}/calendar/v4/calendars/{target.calendar_id}/events"
    resp = await http_client.delete(
        f"{base}/{external_id}",
        headers={"Authorization": f"Bearer {target.user_token}"},
    )
    if resp.status_code not in (200, 404):
        parse_feishu_json(resp, "FEISHU_DELETE_FAILED")


def parse_feishu_bound(raw: dict, zone: ZoneInfo) -> tuple[date, str] | None:
    if not isinstance(raw, dict):
        return None
    ts = raw.get("timestamp")
    if ts is not None and str(ts).strip():
        dt = datetime.fromtimestamp(int(str(ts)), tz=timezone.utc).astimezone(
            zone
        )
        return dt.date(), dt.strftime("%H:%M")
    iso_day = raw.get("date")
    if isinstance(iso_day, str) and len(iso_day) == 10:
        return date.fromisoformat(iso_day), "09:00"
    return None


def resolve_feishu_end(
    start: tuple[date, str], end: tuple[date, str] | None
) -> str:
    end_hhmm = end[1] if (end is not None and end[0] == start[0]) else "23:59"
    if end_hhmm <= start[1]:
        return "23:59" if start[1] < "23:59" else ""
    return end_hhmm


def extract_feishu_location(item: dict) -> str:
    loc = item.get("location")
    return str(loc.get("name") or "").strip() if isinstance(loc, dict) else ""


def extract_feishu_identity(item: dict) -> tuple[str, str] | None:
    if not isinstance(item, dict) or item.get("status") == "cancelled":
        return None
    ext_id = str(item.get("event_id") or "").strip()
    title = str(item.get("summary") or "").strip()
    return (ext_id, title) if (ext_id and title) else None


def feishu_item_to_pocket(
    item: dict, tz_name: str = "Asia/Shanghai"
) -> dict | None:
    ident = extract_feishu_identity(item)
    if ident is None:
        return None
    zone = ZoneInfo(tz_name)
    start = parse_feishu_bound(item.get("start_time") or {}, zone)
    if start is None:
        return None
    end_hhmm = resolve_feishu_end(
        start, parse_feishu_bound(item.get("end_time") or {}, zone)
    )
    if not end_hhmm:
        return None
    return dict(
        external_event_id=ident[0],
        event_date=start[0],
        start_hhmm=start[1],
        end_hhmm=end_hhmm,
        title=ident[1],
        location=extract_feishu_location(item),
        etag=str(item.get("etag") or ""),
    )
