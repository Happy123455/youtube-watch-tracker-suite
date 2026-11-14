// Copies chrome-extension/utils/yt-core.js into the Obsidian plugin (it ships as one file).
// Run after changing yt-core.js: `npm run sync-core`. tests/core.test.mjs fails when they differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const core = readFileSync(`${root}chrome-extension/utils/yt-core.js`, 'utf8');
const path = `${root}obsidian-plugin/main.js`;
const main = readFileSync(path, 'utf8');
const BEGIN = '// ---- BEGIN yt-core.js (an exact copy of chrome-extension/utils/yt-core.js; tests check it) ----\n';
const END = '// ---- END yt-core.js ----';
const a = main.indexOf(BEGIN);
const b = main.indexOf(END);
if (a < 0 || b < a) throw new Error('No yt-core.js block in obsidian-plugin/main.js');
writeFileSync(path, main.slice(0, a + BEGIN.length) + core + main.slice(b));
console.log('obsidian-plugin/main.js now carries the current yt-core.js');
