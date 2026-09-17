#!/usr/bin/env python3
"""Fatia malhas de linhas numa grade de celulas que o front carrega por zoom.

Formato compartilhado por build_distribuicao.py (rede de media tensao da
Copel) e build_estradas.py (estradas municipais do OSM); do lado do browser,
src/data/slicedLineLayer.js decodifica exatamente isto:

  - index.json: {cell_deg, escala, <grupos>: [...], fonte, trechos, cells}
    onde i = floor(lat / cell_deg) e j = floor(lon / cell_deg).
  - <i>_<j>.json: {"t": [[trecho, ...] por indice de grupo]}
    trecho = [dx0, dy0, dx1, dy1, ...] em inteiros de graus * escala,
    delta ENCADEADO: o 1o vertice e relativo ao ultimo do trecho anterior
    (o primeiro de cada grupo, a origem SW da celula).

Cada trecho vai para a celula do seu vertice central; trechos que cruzam a
borda sao desenhados inteiros pela celula dona.
"""

import json
import math
import shutil
from pathlib import Path

ESCALA = 100_000  # graus * 1e5 ~ 1 m


def quantize(coords, escala=ESCALA):
    """Coordenadas [(lon, lat), ...] -> inteiros deduplicados, ou None se degenerado."""
    pts = [(round(x * escala), round(y * escala)) for x, y in coords]
    dedup = [pts[0]] + [p for a, p in zip(pts, pts[1:]) if p != a]
    return dedup if len(dedup) >= 2 else None


def encode_cell(lines, origin):
    """Delta encadeado: o 1o vertice de cada trecho e relativo ao ultimo do
    trecho anterior (o primeiro, a origem SW da celula). A ordenacao por faixa
    de latitude aproxima trechos vizinhos e encolhe os deltas."""
    lines = sorted(lines, key=lambda pts: (pts[0][1] // 500, pts[0][0]))
    out = []
    px, py = origin
    for pts in lines:
        enc = []
        for x, y in pts:
            enc += [x - px, y - py]
            px, py = x, y
        out.append(enc)
    return out


def cell_key(lat, lon, cell_deg):
    return f'{math.floor(lat / cell_deg)}_{math.floor(lon / cell_deg)}'


def write_grid(out_dir, cells, grupos_key, grupos, fonte, cell_deg, escala=ESCALA):
    """Escreve index.json + uma celula por arquivo. `cells` e
    {key: [ [trecho_quantizado, ...] por indice de grupo ]}.

    Retorna o dict do index escrito.
    """
    out_dir = Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    total_bytes = 0
    for key, por_grupo in cells.items():
        i, j = (int(v) for v in key.split('_'))
        origin = (round(j * cell_deg * escala), round(i * cell_deg * escala))
        payload = {'t': [encode_cell(lines, origin) for lines in por_grupo]}
        path = out_dir / f'{key}.json'
        path.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
        total_bytes += path.stat().st_size

    index = {
        'cell_deg': cell_deg,
        'escala': escala,
        grupos_key: grupos,
        'fonte': fonte,
        'trechos': sum(len(x) for v in cells.values() for x in v),
        'cells': {k: sum(len(x) for x in v) for k, v in sorted(cells.items())},
    }
    (out_dir / 'index.json').write_text(
        json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

    maior = max(cells, key=lambda k: (out_dir / f'{k}.json').stat().st_size)
    print(f'{index["trechos"]} trechos em {len(cells)} celulas, '
          f'{total_bytes / 1e6:.1f} MB; maior celula {maior} '
          f'{(out_dir / f"{maior}.json").stat().st_size / 1e3:.0f} KB')
    return index
