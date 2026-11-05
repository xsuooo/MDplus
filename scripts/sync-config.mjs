import fs from 'node:fs';

const source = JSON.parse(
  fs.readFileSync(new URL('../config/application.json', import.meta.url), 'utf8'),
);
const target = new URL('../src-tauri/tauri.conf.json', import.meta.url);
const tauri = JSON.parse(fs.readFileSync(target, 'utf8'));
const expected = `http://${source.development.host}:${source.development.port}`;
if (process.argv.includes('--write')) {
  tauri.build.devUrl = expected;
  fs.writeFileSync(target, `${JSON.stringify(tauri, null, 2)}\n`);
} else if (tauri.build.devUrl !== expected) {
  throw new Error('Tauri devUrl differs from config/application.json; run npm run config:sync');
}
