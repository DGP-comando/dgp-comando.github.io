// src/processing/geolibreWorker.js
//
// Roda as ferramentas do GeoLibre (whitebox em Rust → WASM/WASI) fora da
// thread principal. O binário tem 23 MB, então só é compilado na primeira
// mensagem. Protocolo: {id, cmd:'list'} → {id, tools:[...]};
// {id, cmd:'run', tool, args, input} → {id, exitCode, stdout, files}.

// O `exports` do pacote não expõe o .wasm, então o caminho é relativo ao node_modules.
import wasmUrl from '../../node_modules/geolibre-wasm/geolibre-cli.wasm?url';
import { initTools, listTools, runTool } from 'geolibre-wasm/tools';

let ready = null;
const init = () => (ready ??= initTools(wasmUrl));

self.onmessage = async ({ data }) => {
  const { id, cmd } = data;
  try {
    await init();
    if (cmd === 'list') {
      self.postMessage({ id, tools: await listTools() });
      return;
    }
    const { exitCode, stdout, files } = await runTool(data.tool, { args: data.args, input: data.input });
    self.postMessage({ id, exitCode, stdout, files }, Object.values(files).map((u) => u.buffer));
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
