from hashlib import sha256
from pathlib import Path
import re

from .auth import authenticate_raw_conn
from .errors import RpcError

APK_PREFIX = "pocket-calendar-"
APK_SUFFIX = ".apk"
APK_MIME = "application/vnd.android.package-archive"
MAX_APK_BYTES = 80 * 1024 * 1024
ZIP_MAGIC = b"PK\x03\x04"
SAFE_VER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$")
SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$")

_HASH_CACHE: dict[tuple[str, int, int], str] = dict()


def compute_version_code(raw_ver: str) -> int:
    match = SEMVER_RE.match(raw_ver.strip())
    if not match:
        return 0
    major = int(match.group(1))
    minor = int(match.group(2))
    patch = int(match.group(3))
    rank = 10 if "-" in raw_ver else 99
    return major * 1_000_000 + minor * 10_000 + patch * 100 + rank


def validate_version(raw_ver: str) -> str:
    ver = (raw_ver or "").strip()
    if not SAFE_VER_RE.match(ver):
        raise RpcError(422, "INVALID_VERSION", "Invalid semver version")
    return ver


def file_sha256_cached(path: Path) -> tuple[str, int]:
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    cached = _HASH_CACHE.get(key)
    if cached is not None:
        return cached, stat.st_size
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    hex_hash = digest.hexdigest()
    _HASH_CACHE[key] = hex_hash
    return hex_hash, stat.st_size


def read_notes_text(apk_path: Path) -> str:
    notes_path = apk_path.with_suffix(".txt")
    if not notes_path.is_file():
        return ""
    try:
        return notes_path.read_text(encoding="utf-8").strip()[:2000]
    except OSError:
        return ""


def build_release_meta(apk_path: Path, version: str) -> dict:
    hex_hash, size_bytes = file_sha256_cached(apk_path)
    return dict(
        version_name=version,
        version_code=compute_version_code(version),
        sha256=hex_hash,
        size_bytes=size_bytes,
        notes=read_notes_text(apk_path),
        download_path=f"/v1/app/download/{version}",
    )


def parse_apk_version(name: str) -> str | None:
    if not (name.startswith(APK_PREFIX) and name.endswith(APK_SUFFIX)):
        return None
    ver = name[len(APK_PREFIX) : -len(APK_SUFFIX)]
    return ver if SAFE_VER_RE.match(ver) else None


def scan_local_latest(releases_dir: str) -> dict | None:
    if not releases_dir:
        return None
    root = Path(releases_dir)
    if not root.is_dir():
        return None
    best: tuple[int, Path, str] | None = None
    for entry in root.iterdir():
        if not entry.is_file():
            continue
        ver = parse_apk_version(entry.name)
        if ver is None:
            continue
        code = compute_version_code(ver)
        if best is None or code > best[0]:
            best = (code, entry, ver)
    if best is None:
        return None
    return build_release_meta(best[1], best[2])


def resolve_local_apk(releases_dir: str, raw_ver: str) -> tuple[Path, str]:
    ver = validate_version(raw_ver)
    if not releases_dir:
        raise RpcError(404, "RELEASE_NOT_FOUND", "Release not found")
    root = Path(releases_dir).resolve()
    target = (root / f"{APK_PREFIX}{ver}{APK_SUFFIX}").resolve()
    if target.parent != root or not target.is_file():
        raise RpcError(404, "RELEASE_NOT_FOUND", "Release not found")
    hex_hash, _ = file_sha256_cached(target)
    return target, hex_hash


def store_uploaded_apk(
    releases_dir: str, raw_ver: str, raw_bytes: bytes, notes: str = ""
) -> dict:
    if not releases_dir:
        raise RpcError(
            503,
            "RELEASES_DISABLED",
            "POCKET_RELEASES_DIR is not configured on server",
        )
    ver = validate_version(raw_ver)
    if not raw_bytes or len(raw_bytes) > MAX_APK_BYTES:
        raise RpcError(422, "INVALID_APK", "APK size out of bounds")
    if not raw_bytes.startswith(ZIP_MAGIC):
        raise RpcError(422, "INVALID_APK", "Payload is not a valid APK zip")
    root = Path(releases_dir)
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{APK_PREFIX}{ver}{APK_SUFFIX}"
    tmp_path = root / f".{APK_PREFIX}{ver}.tmp"
    tmp_path.write_bytes(raw_bytes)
    tmp_path.replace(target)
    clean_notes = (notes or "").strip()[:2000]
    notes_path = target.with_suffix(".txt")
    if clean_notes:
        notes_path.write_text(clean_notes, encoding="utf-8")
    elif notes_path.exists():
        notes_path.unlink()
    return build_release_meta(target, ver)


async def require_bearer_auth(
    ctx, authorization: str | None, require_admin: bool = False
):
    has_bearer = isinstance(authorization, str) and authorization.startswith(
        "Bearer "
    )
    if not has_bearer:
        raise RpcError(401, "UNAUTHORIZED", "Valid bearer token required")
    raw_token = authorization.removeprefix("Bearer ")
    async with ctx.pool.connection() as conn:
        identity = await authenticate_raw_conn(conn, raw_token)
    if identity is None:
        raise RpcError(401, "UNAUTHORIZED", "Valid bearer token required")
    if require_admin and "*" not in identity.scopes:
        raise RpcError(403, "FORBIDDEN", "Personal token required")
    return identity
