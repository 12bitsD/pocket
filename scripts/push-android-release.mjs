#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cloudUrl, token, rawVersion, rawNotes] = process.argv.slice(2);

if (!cloudUrl || !token) {
  console.error(
    'Usage: node scripts/push-android-release.mjs ' +
      '<cloud_url> <admin_token> [version] [notes]'
  );
  process.exit(2);
}

const pkgPath = path.join(ROOT, 'apps', 'calendar', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = rawVersion || pkg.version;
const apkPath = path.join(ROOT, 'dist', `pocket-calendar-${version}.apk`);

if (!fs.existsSync(apkPath)) {
  console.error(`APK not found: ${apkPath}`);
  process.exit(1);
}

const qs = new URLSearchParams({ version, notes: rawNotes || '' });
const url = `${cloudUrl.replace(/\/+$/, '')}/v1/app/releases?${qs}`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/vnd.android.package-archive'
  },
  body: fs.readFileSync(apkPath)
});

const text = await res.text();
if (!res.ok) {
  console.error(`Upload failed (${res.status}): ${text}`);
  process.exit(1);
}
console.log(text);
