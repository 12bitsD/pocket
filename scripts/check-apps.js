const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APPS = Object.freeze(['calendar']);
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const MODULE_TAG = '<script type="module" src="./src/main.js"></script>';

function collectJsFiles(dirPath) {
  const found = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(fullPath);
    }
  }
  return found.sort();
}

function checkInlineScripts(appName, html) {
  const matches = [...html.matchAll(INLINE_SCRIPT_RE)];
  for (const [index, match] of matches.entries()) {
    try {
      new Function(match[1]);
    } catch (error) {
      const idx = index + 1;
      throw new Error(`${appName} inline script ${idx}: ${error.message}`);
    }
  }
  return matches.length;
}

function checkApp(rootDir, appName) {
  const appDir = path.join(rootDir, 'apps', appName);
  const htmlPath = path.join(appDir, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (!html.includes(MODULE_TAG)) {
    throw new Error(`${appName}/index.html missing ${MODULE_TAG}`);
  }
  const inlineCount = checkInlineScripts(appName, html);
  const srcDir = path.join(appDir, 'src');
  if (!fs.existsSync(srcDir)) {
    throw new Error(`${appName}/src directory not found`);
  }
  const modules = collectJsFiles(srcDir);
  if (modules.length === 0) {
    throw new Error(`No ES modules found under ${appName}/src`);
  }
  for (const modPath of modules) {
    execFileSync(process.execPath, ['--check', modPath], { stdio: 'pipe' });
  }
  console.log(
    `${appName} syntax OK (${modules.length} modules, ${inlineCount} inline)`
  );
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  for (const appName of APPS) {
    checkApp(rootDir, appName);
  }
}

main();
