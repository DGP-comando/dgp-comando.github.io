// scripts/check-maplibre-no-cesium.mjs
//
// O protótipo MapLibre (maplibre.html) não carrega o Cesium: um import de
// 'cesium' em qualquer ponto do grafo viraria o global `Cesium` indefinido e
// derrubaria a página. Percorre os imports relativos a partir da entrada e
// falha mostrando a cadeia que chega ao Cesium.
//
//   node scripts/check-maplibre-no-cesium.mjs [entrada]

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const entry = path.resolve(root, process.argv[2] ?? 'src/maplibre/prototype.js');
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

const seen = new Map(); // arquivo -> cadeia até ele
const queue = [[entry, [path.relative(root, entry)]]];
const failures = [];

while (queue.length) {
  const [file, chain] = queue.shift();
  if (seen.has(file)) continue;
  seen.set(file, chain);
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec === 'cesium' || spec.startsWith('cesium/') || spec.startsWith('cesium-')) {
      failures.push([...chain, spec].join('\n   -> '));
      continue;
    }
    if (!spec.startsWith('.')) continue;
    let target = path.resolve(path.dirname(file), spec);
    if (!existsSync(target) && existsSync(`${target}.js`)) target = `${target}.js`;
    if (/\.(js|mjs)$/.test(target)) queue.push([target, [...chain, path.relative(root, target)]]);
  }
}

if (failures.length) {
  console.error(`check-maplibre-no-cesium: ${failures.length} caminho(s) chegam ao Cesium:\n`);
  for (const f of failures) console.error(`   ${f}\n`);
  process.exit(1);
}
console.log(`check-maplibre-no-cesium: ok (${seen.size} módulos, nenhum importa o Cesium)`);
