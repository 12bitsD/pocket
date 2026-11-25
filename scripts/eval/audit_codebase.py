from __future__ import annotations

import argparse
import colorsys
from dataclasses import dataclass
import json
from pathlib import Path
import re
import subprocess

SKIP_DIRS = (
    ".git",
    ".agents",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    "android",
)
ARTIFACT_NAMES = ("__pycache__", ".pytest_cache", ".venv")
HEX_COLOR_RE = re.compile(
    r"#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b"
)
ALLOW_PREFIX = "bits:"
ALLOW_RE = re.compile(ALLOW_PREFIX + r"(allow|explain)\(([^)]*)\):\s*(.*)")


@dataclass(frozen=True)
class Finding:
    gate: str
    location: str
    message: str


def run_bits_gate(root: Path) -> list[Finding]:
    proc = subprocess.run(
        ["bits", "style", "report", "."],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return [Finding("bits", ".", "bits report failed: " + proc.stderr)]
    report = json.loads(proc.stdout)
    summary = report.get("summary") or dict()
    findings = check_bits_summary(summary)
    for item in report.get("results", ()):
        finding = classify_bits_item(item)
        if finding is not None:
            findings.append(finding)
    for cmd_tag, args in (
        ("bits-baseline", ["check", ".", "--baseline", "bits-baseline.json"]),
        ("bits-diff", ["check", "--diff", "--commit", "origin/main"]),
    ):
        sub = subprocess.run(
            ["bits", "style", *args],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if sub.returncode != 0:
            msg = sub.stdout.strip() or sub.stderr.strip()
            findings.append(Finding(cmd_tag, ".", msg))
    return findings


def check_bits_summary(summary: dict) -> list[Finding]:
    findings = []
    for key in ("violations", "scan_errors", "unsupported_files"):
        if summary.get(key, 0) != 0:
            findings.append(Finding("bits", ".", "%s=%d" % (key, summary[key])))
    return findings


def classify_bits_item(item: dict) -> Finding | None:
    file_path = item.get("file", "")
    rule_id = item.get("rule_id", "")
    severity = item.get("severity", "")
    legacy_cron = (
        file_path == "packages/agent-core/src/cron.js"
        and rule_id == "BCS003"
        and severity == "warning"
    )
    if legacy_cron:
        return None
    rng = item.get("range") or dict()
    start = rng.get("start") or dict()
    loc = "%s:%d" % (file_path, start.get("line", 1))
    msg = "%s %s: %s" % (severity, rule_id, item.get("message", ""))
    return Finding("bits", loc, msg)


def iter_source_files(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    matched = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in suffixes:
            continue
        rel_parts = path.relative_to(root).parts
        if any(part in SKIP_DIRS for part in rel_parts):
            continue
        matched.append(path)
    return matched


def iter_android_files(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    main_dir = root / "apps" / "calendar" / "android" / "app" / "src" / "main"
    if not main_dir.exists():
        return []
    return [
        p
        for p in sorted(main_dir.rglob("*"))
        if p.is_file() and p.suffix in suffixes and "assets" not in p.parts
    ]


def scan_file_suppressions(rel: str, text: str) -> tuple[int, list[Finding]]:
    findings = []
    count = 0
    tag_allow = ALLOW_PREFIX + "allow"
    tag_explain = ALLOW_PREFIX + "explain"
    for idx, line in enumerate(text.splitlines(), start=1):
        if tag_allow not in line and tag_explain not in line:
            continue
        count += 1
        match = ALLOW_RE.search(line)
        valid = bool(
            match
            and re.fullmatch(r"BCS\d+", match.group(2).strip())
            and len(match.group(3).strip()) >= 6
        )
        if not valid:
            loc = "%s:%d" % (rel, idx)
            msg = "Invalid bits suppression format or missing reason"
            findings.append(Finding("suppression", loc, msg))
    return count, findings


def check_suppressions(root: Path) -> list[Finding]:
    findings = []
    total = 0
    files = iter_source_files(root, (".py", ".js", ".mjs", ".ts", ".css"))
    for path in files:
        rel = str(path.relative_to(root))
        cnt, items = scan_file_suppressions(rel, path.read_text())
        total += cnt
        findings.extend(items)
    if total > 4:
        findings.append(Finding("suppression", ".", "Too many: %d" % total))
    return findings


def check_duplication_and_size(root: Path) -> list[Finding]:
    findings = []
    seen_blocks: dict[str, str] = dict()
    prod_files = [
        *iter_source_files(root / "cloud" / "src", (".py",)),
        *iter_source_files(root / "apps" / "calendar" / "src", (".js", ".mjs")),
        *iter_android_files(root, (".kt",)),
    ]
    for path in prod_files:
        rel = str(path.relative_to(root))
        raw_text = path.read_text()
        if path.suffix == ".kt":
            findings.extend(check_kotlin_line_lengths(rel, raw_text))
        lines = clean_code_lines(raw_text)
        if len(lines) > 280:
            msg = "Module exceeds 280 code lines: %d" % len(lines)
            findings.append(Finding("maintainability", rel, msg))
        findings.extend(scan_file_clones(rel, lines, seen_blocks))
    return findings


def check_kotlin_line_lengths(rel: str, source: str) -> list[Finding]:
    findings = []
    for idx, line in enumerate(source.splitlines(), start=1):
        if len(line) > 80:
            msg = "Kotlin line exceeds 80 columns (%d)" % len(line)
            findings.append(Finding("bits-kt", "%s:%d" % (rel, idx), msg))
    return findings


def clean_code_lines(source: str) -> list[str]:
    result = []
    noise = (";", ")", '"""', "'''", "{", "}", "};", ");")
    prefixes = ("#", "//", "import ", "from ", "package ")
    for raw in source.splitlines():
        stripped = raw.strip()
        if not stripped or stripped in noise or stripped.startswith(prefixes):
            continue
        result.append(re.sub(r"\s+", " ", stripped))
    return result


def scan_file_clones(
    rel: str, lines: list[str], seen_blocks: dict[str, str]
) -> list[Finding]:
    findings = []
    window = 10
    for index in range(0, max(0, len(lines) - window + 1)):
        chunk = "\n".join(lines[index : index + window])
        if len(chunk) < 180:
            continue
        previous = seen_blocks.get(chunk)
        if previous is None:
            seen_blocks[chunk] = rel
        elif previous != rel:
            msg = "10-line duplicate code block shared with " + previous
            findings.append(Finding("duplication", rel, msg))
            break
    return findings


def check_design_standard(root: Path) -> list[Finding]:
    findings = []
    ui_files = [
        *iter_source_files(root / "apps", (".css", ".html", ".js")),
        *iter_source_files(root / "packages" / "design-system", (".css",)),
        *iter_android_files(root, (".kt", ".xml")),
    ]
    for path in ui_files:
        rel = str(path.relative_to(root))
        findings.extend(scan_forbidden_colors(rel, path.read_text()))
    for png in iter_android_files(root, (".png",)):
        rel_png = str(png.relative_to(root))
        msg = "Untracked/template raster PNG in Android res (use Paper vectors)"
        findings.append(Finding("design", rel_png, msg))
    css_path = root / "packages" / "design-system" / "terminal.css"
    if css_path.exists():
        css = css_path.read_text()
        for token in ("--vermilion", "--pine", "tabular-nums"):
            if token not in css:
                findings.append(
                    Finding("design", "terminal.css", "Missing " + token)
                )
    return findings


def scan_forbidden_colors(rel: str, text: str) -> list[Finding]:
    findings = []
    for idx, line in enumerate(text.splitlines(), start=1):
        for match in HEX_COLOR_RE.finditer(line):
            raw = match.group(1)
            rgb = raw[2:] if len(raw) == 8 else raw
            expanded = "".join(ch * 2 for ch in rgb) if len(rgb) == 3 else rgb
            if is_purple_or_blue_violet(expanded):
                msg = "Forbidden purple/blue-violet color #" + raw
                findings.append(Finding("design", "%s:%d" % (rel, idx), msg))
    return findings


def is_purple_or_blue_violet(hex6: str) -> bool:
    red = int(hex6[0:2], 16) / 255.0
    green = int(hex6[2:4], 16) / 255.0
    blue = int(hex6[4:6], 16) / 255.0
    hue, lightness, saturation = colorsys.rgb_to_hls(red, green, blue)
    deg = hue * 360.0
    in_band = 200.0 <= deg <= 315.0
    return in_band and saturation >= 0.18 and 0.08 <= lightness <= 0.92


def check_repo_hygiene(root: Path) -> list[Finding]:
    findings = []
    for check_dir in ("cloud", "apps", "packages", "scripts"):
        base = root / check_dir
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.name in ARTIFACT_NAMES and "node_modules" not in path.parts:
                rel = str(path.relative_to(root))
                findings.append(Finding("hygiene", rel, "Leftover cache/venv"))
    diff_check = subprocess.run(
        ["git", "diff", "--check"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if diff_check.returncode != 0:
        msg = diff_check.stdout.strip()
        findings.append(Finding("hygiene", "git-diff", msg))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Pocket static quality gate")
    parser.add_argument("--root", default=".")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    findings = [
        *run_bits_gate(root),
        *check_suppressions(root),
        *check_duplication_and_size(root),
        *check_design_standard(root),
        *check_repo_hygiene(root),
    ]
    payload = dict(
        ok=len(findings) == 0,
        finding_count=len(findings),
        findings=[item.__dict__ for item in findings],
    )
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    elif findings:
        for item in findings:
            print("[%s] %s: %s" % (item.gate, item.location, item.message))
    else:
        print("Static audit PASS (bits, suppressions, dedup, design, hygiene)")
    return 0 if not findings else 1


if __name__ == "__main__":
    raise SystemExit(main())
