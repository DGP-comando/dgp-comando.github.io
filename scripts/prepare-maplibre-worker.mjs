// scripts/prepare-maplibre-worker.mjs
//
// O worker do MapLibre 6 e um module worker que importa um modulo irmao
// (maplibre-gl-shared.mjs) por caminho relativo. O Vite nao sabe empacotar
// esse par, entao os dois arquivos sao copiados da versao instalada para
// public/vendor/maplibre/<versao>/ e servidos como estaticos. Os arquivos ficam
// commitados (um build que pule os scripts do npm continuaria funcionando) e
// versoes antigas sao removidas, para o diretorio so conter o que o bundle pede.
// Mesma receita do tools/prepare-map-worker.mjs do Osiris (MIT).

import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = new URL('node_modules/maplibre-gl/', root);
const { version } = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
const vendor = new URL('public/vendor/maplibre/', root);
const target = new URL(`${version}/`, vendor);
await mkdir(target, { recursive: true });
for (const file of ['dist/maplibre-gl-worker.mjs', 'dist/maplibre-gl-shared.mjs', 'LICENSE.txt']) {
  await copyFile(new URL(file, source), new URL(file.split('/').at(-1), target));
}

for (const entry of await readdir(vendor, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== version) {
    await rm(new URL(`${entry.name}/`, vendor), { recursive: true, force: true });
    console.log(`prepare-maplibre-worker: removida versao antiga ${entry.name}`);
  }
}
