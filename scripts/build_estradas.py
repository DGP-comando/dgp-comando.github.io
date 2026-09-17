#!/usr/bin/env python3
"""Gera as estradas municipais do PR (OSM) em public/data/estradas/.

Fonte: extrato Geofabrik da regiao Sul (sul-latest.osm.pbf), lido pelo driver
OSM do GDAL. Sao as vias que NAO estao nas camadas de rodovias federais
(BR-xxx) e estaduais (PR/PRC-xxx), separadas em dois grupos:

  - urbanas: residential, living_street, pedestrian  (ruas de cidade e vila)
  - rurais:  unclassified, track, road               (estradas vicinais e de terra)

Ficam de fora footway/path/cycleway/steps (nao sao estradas) e service
(acessos internos, corredores de estacionamento), que triplicariam o volume
sem acrescentar malha viaria municipal.

Sao centenas de milhares de trechos: um GeoJSON unico passaria de 50 MB, entao
a malha sai FATIADA numa grade de 0,25 grau que o front carrega por zoom (so
perto do chao) — mesmo formato da rede de distribuicao, ver slice_grid.py.

Simplifica a SIMPLIFY_M em EPSG:31982 (metrico, SIRGAS 2000 / UTM 22S) e
descarta trechos mais curtos que MIN_LEN_M antes de voltar a EPSG:4674.

LGPD: so a geometria da via publica; nenhum endereco, nome de morador ou
qualquer dado pessoal e lido do OSM.

Uso:
  py -3 scripts/build_estradas.py --pbf caminho/sul-latest.osm.pbf

O extrato (~425 MB) vem de
https://download.geofabrik.de/south-america/brazil/sul-latest.osm.pbf
e NAO e versionado. A leitura do .pbf leva minutos; o subconjunto do PR fica
cacheado num GeoPackage ao lado dele (--no-cache desliga), para reajustar
simplificacao/tolerancia sem reler o extrato inteiro.
"""

import argparse
import os
from pathlib import Path

import geopandas as gpd

from slice_grid import cell_key, quantize, write_grid

OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'estradas'

CELL_DEG = 0.25
SIMPLIFY_M = 8.0
MIN_LEN_M = 25.0
# Bbox do Parana. O extrato cobre PR+SC+RS; o resto e cortado na leitura.
PR_BBOX = (-54.65, -26.75, -48.0, -22.5)  # (oeste, sul, leste, norte)

GRUPOS = ['urbanas', 'rurais']
HIGHWAY_GRUPO = {
    'residential': 0, 'living_street': 0, 'pedestrian': 0,
    'unclassified': 1, 'track': 1, 'road': 1,
}
FONTE = '© colaboradores do OpenStreetMap (ODbL), extrato Geofabrik Sul'


def carregar(pbf: Path, cache: Path | None) -> gpd.GeoDataFrame:
    """Vias municipais do PR, do cache se houver, senao do .pbf."""
    if cache and cache.exists():
        print(f'lendo cache {cache}')
        return gpd.read_file(cache, layer='estradas')

    if not pbf.exists():
        raise SystemExit(
            f'extrato OSM nao encontrado: {pbf}\n'
            'baixe de https://download.geofabrik.de/south-america/brazil/sul-latest.osm.pbf'
        )
    # O driver OSM do GDAL nao aceita os limites default de cache para um
    # extrato deste tamanho; o indexador proprio resolve o `lines` sozinho.
    os.environ.setdefault('OSM_USE_CUSTOM_INDEXING', 'YES')
    classes = "','".join(HIGHWAY_GRUPO)
    print(f'lendo {pbf} (leva minutos)...')
    g = gpd.read_file(
        pbf,
        layer='lines',
        columns=['osm_id', 'highway'],
        where=f"highway IN ('{classes}')",
        bbox=PR_BBOX,
    )
    print(f'{len(g)} vias no bbox do PR')
    if cache:
        g.to_file(cache, layer='estradas', driver='GPKG')
        print(f'cache gravado em {cache}')
    return g


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--pbf', default=os.environ.get('OSM_PBF', 'sul-latest.osm.pbf'),
                    help='extrato Geofabrik da regiao Sul (.osm.pbf)')
    ap.add_argument('--no-cache', action='store_true',
                    help='nao usar/gravar o GeoPackage do subconjunto do PR')
    args = ap.parse_args()

    pbf = Path(args.pbf)
    cache = None if args.no_cache else pbf.with_name(pbf.stem + '-pr-estradas.gpkg')
    g = carregar(pbf, cache)
    if g.empty:
        raise SystemExit('nenhuma via municipal encontrada no bbox do PR')

    metrico = g.to_crs(31982)
    geoms = metrico.geometry.simplify(SIMPLIFY_M)
    longas = geoms.length >= MIN_LEN_M
    print(f'{(~longas).sum()} trechos abaixo de {MIN_LEN_M:.0f} m descartados')
    geoms = geoms[longas].to_crs(4674)
    highways = g['highway'].values[longas.values]
    print(f'simplificado a {SIMPLIFY_M:.0f} m em EPSG:31982')

    # cells[key][k] = trechos quantizados do grupo GRUPOS[k]
    cells: dict[str, list[list]] = {}
    descartados = 0
    for geom, highway in zip(geoms.values, highways):
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
        grupo = HIGHWAY_GRUPO[highway]
        cells.setdefault(key, [[] for _ in GRUPOS])[grupo].append(pts)

    index = write_grid(OUT, cells, 'classes', GRUPOS, FONTE, CELL_DEG)
    por_grupo = [sum(len(v[k]) for v in cells.values()) for k in range(len(GRUPOS))]
    print(f'{descartados} descartados; ' + ', '.join(
        f'{n} {nome}' for nome, n in zip(GRUPOS, por_grupo)))
    assert sum(por_grupo) == index['trechos']


if __name__ == '__main__':
    main()
