const fs = require('node:fs');
const path = require('node:path');

const apps = ['calendar'];
const scriptPattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

for (const app of apps) {
  const filePath = path.join(__dirname, `../apps/${app}/index.html`);
  const html = fs.readFileSync(filePath, 'utf8');
  const scripts = [...html.matchAll(scriptPattern)];
  if (scripts.length === 0) {
    throw new Error(`No inline script found in ${app}`);
  }
  for (const [index, match] of scripts.entries()) {
    try {
      new Function(match[1]);
    } catch (error) {
      throw new Error(`${app} script ${index + 1}: ${error.message}`);
    }
  }
  console.log(`${app} syntax OK (${scripts.length} inline script)`);
}
