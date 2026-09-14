#!/usr/bin/env python3
"""Gera a rede de distribuicao de media tensao (Copel) em public/data/distribuicao/.

Fonte: BDGD COPEL-DIS 2022-12-31 V11 (ANEEL), ja extraida e simplificada
(tolerancia 50 m) pelo projeto energy em data/processed/bdgd_copel.gpkg,
camada `ssdmt_simpl` (segmentos de MT, 13,8 e 34,5 kV). Sao ~777 mil trechos
e ~205 mil km: um GeoJSON unico passaria de 50 MB, entao a rede sai FATIADA
numa grade de 0,25 grau que o front carrega por zoom (so perto do chao):

  - index.json: {cell_deg, escala, tensoes, fonte, cells: {"<i>_<j>": n}}
    onde i = floor(lat / cell_deg) e j = floor(lon / cell_deg).
  - <i>_<j>.json: {"t": [[trecho, ...] por indice de `tensoes`]}
    trecho = [dx0, dy0, dx1, dy1, ...] em inteiros de graus * escala (1e5,
    ~1 m), delta ENCADEADO: o 1o vertice e relativo ao ultimo do trecho
    anterior (o primeiro de cada tensao, a origem SW da celula).

Cada trecho vai para a celula do seu vertice central; trechos que cruzam a
borda sao desenhados inteiros pela celula dona. Re-simplifica a 20 m em
EPSG:31982 (metrico) antes de voltar a EPSG:4674.

LGPD: so a geometria da rede e a tensao nominal; nenhuma unidade consumidora.

Uso: py -3 scripts/build_distribuicao.py   (ENERGY_ROOT sobrescreve a origem)
"""

import json
import math
import os
import shutil
from pathlib import Path

import geopandas as gpd

ENERGY = Path(os.environ.get('ENERGY_ROOT', 'G:/UPWORK/01-CONTRACTS/energy'))
GPKG = ENERGY / 'data' / 'processed' / 'bdgd_copel.gpkg'
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'distribuicao'

CELL_DEG = 0.25
ESCALA = 100_000
SIMPLIFY_M = 20.0
TENSOES = [13.8, 34.5]
FONTE = 'ANEEL · BDGD COPEL-DIS 2022-12-31 V11 (SSDMT, média tensão)'


def quantize(coords: list[tuple[float, float]]) -> list[tuple[int, int]] | None:
    pts = [(round(x * ESCALA), round(y * ESCALA)) for x, y in coords]
    dedup = [pts[0]] + [p for a, p in zip(pts, pts[1:]) if p != a]
    return dedup if len(dedup) >= 2 else None


def encode_cell(lines: list[list[tuple[int, int]]], origin: tuple[int, int]) -> list[list[int]]:
    """Delta encadeado: o 1o vertice de cada trecho e relativo ao ultimo do
    trecho anterior (o primeiro, a origem SW da celula)."""
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


def main() -> None:
    g = gpd.read_file(GPKG, layer='ssdmt_simpl')
    if g.crs is None or g.crs.to_epsg() != 4674:
        raise SystemExit(f'CRS inesperado em ssdmt_simpl: {g.crs}')
    kv_fora = set(g['ten_nom_kv'].unique()) - set(TENSOES)
    if kv_fora:
        raise SystemExit(f'tensoes nao mapeadas: {kv_fora}')
    print(f'lidos {len(g)} trechos ({g.crs})')

    geoms = g.to_crs(31982).simplify(SIMPLIFY_M).to_crs(4674)
    print('simplificado a', SIMPLIFY_M, 'm em EPSG:31982')

    # cells[key][k] = trechos quantizados da tensao TENSOES[k]
    cells: dict[str, list[list[list[tuple[int, int]]]]] = {}
    descartados = 0
    for geom, kv in zip(geoms.values, g['ten_nom_kv'].values):
        if geom is None or geom.is_empty or geom.geom_type != 'LineString':
            descartados += 1
            continue
        coords = list(geom.coords)
        pts = quantize(coords)
        if pts is None:
            descartados += 1
            continue
        lon, lat = coords[len(coords) // 2]
        key = f'{math.floor(lat / CELL_DEG)}_{math.floor(lon / CELL_DEG)}'
        cells.setdefault(key, [[] for _ in TENSOES])[TENSOES.index(float(kv))].append(pts)

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    total_bytes = 0
    for key, por_kv in cells.items():
        i, j = (int(v) for v in key.split('_'))
        origin = (round(j * CELL_DEG * ESCALA), round(i * CELL_DEG * ESCALA))
        payload = {'t': [encode_cell(lines, origin) for lines in por_kv]}
        path = OUT / f'{key}.json'
        path.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
        total_bytes += path.stat().st_size
    index = {
        'cell_deg': CELL_DEG,
        'escala': ESCALA,
        'tensoes': TENSOES,
        'fonte': FONTE,
        'trechos': sum(len(x) for v in cells.values() for x in v),
        'cells': {k: sum(len(x) for x in v) for k, v in sorted(cells.items())},
    }
    (OUT / 'index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')),
                                    encoding='utf-8')
    maior = max(cells, key=lambda k: (OUT / f'{k}.json').stat().st_size)
    print(f'{index["trechos"]} trechos em {len(cells)} celulas, {descartados} descartados, '
          f'{total_bytes / 1e6:.1f} MB; maior celula {maior} '
          f'{(OUT / f"{maior}.json").stat().st_size / 1e3:.0f} KB')


if __name__ == '__main__':
    main()
