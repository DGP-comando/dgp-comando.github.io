#!/usr/bin/env python3
"""Gera a rede de distribuicao de media tensao (Copel) em public/data/distribuicao/.

Fonte: BDGD COPEL-DIS 2022-12-31 V11 (ANEEL), ja extraida e simplificada
(tolerancia 50 m) pelo projeto energy em data/processed/bdgd_copel.gpkg,
camada `ssdmt_simpl` (segmentos de MT, 13,8 e 34,5 kV). Sao ~777 mil trechos
e ~205 mil km: um GeoJSON unico passaria de 50 MB, entao a rede sai FATIADA
numa grade de 0,25 grau que o front carrega por zoom (so perto do chao).
O formato das celulas e o delta encadeado de slice_grid.py, compartilhado
com as estradas municipais do OSM (build_estradas.py).

Cada trecho vai para a celula do seu vertice central; trechos que cruzam a
borda sao desenhados inteiros pela celula dona. Re-simplifica a 20 m em
EPSG:31982 (metrico) antes de voltar a EPSG:4674.

LGPD: so a geometria da rede e a tensao nominal; nenhuma unidade consumidora.

Uso: py -3 scripts/build_distribuicao.py   (ENERGY_ROOT sobrescreve a origem)
"""

import os
from pathlib import Path

import geopandas as gpd

from slice_grid import cell_key, quantize, write_grid

ENERGY = Path(os.environ.get('ENERGY_ROOT', 'G:/UPWORK/01-CONTRACTS/energy'))
GPKG = ENERGY / 'data' / 'processed' / 'bdgd_copel.gpkg'
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'distribuicao'

CELL_DEG = 0.25
SIMPLIFY_M = 20.0
TENSOES = [13.8, 34.5]
FONTE = 'ANEEL · BDGD COPEL-DIS 2022-12-31 V11 (SSDMT, média tensão)'


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
    cells: dict[str, list[list]] = {}
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
        key = cell_key(lat, lon, CELL_DEG)
        cells.setdefault(key, [[] for _ in TENSOES])[TENSOES.index(float(kv))].append(pts)

    write_grid(OUT, cells, 'tensoes', TENSOES, FONTE, CELL_DEG)
    print(f'{descartados} descartados')


if __name__ == '__main__':
    main()
