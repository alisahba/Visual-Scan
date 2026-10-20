// Fold the artifact build (dist-artifact/) into one self-contained HTML page
// for publishing as a claude.ai Artifact: inline CSS and JS, keep the body
// markup, drop the document wrapper (the host adds its own).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist-artifact';
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const assets = readdirSync(join(dir, 'assets'));
const css = assets.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n');
const js = assets.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n');
if (assets.some((f) => !/\.(css|js)$/.test(f))) throw new Error('Unexpected non-inlined asset: ' + assets.join(', '));

const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '').trim();
const safeJs = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const out = `${title}\n<style>\n${css}\n</style>\n${body}\n<script type="module">\n${safeJs}\n</script>\n`;
writeFileSync(join(dir, 'visual-scan.html'), out);
console.log(`dist-artifact/visual-scan.html · ${(out.length / 1024).toFixed(0)} KB`);
