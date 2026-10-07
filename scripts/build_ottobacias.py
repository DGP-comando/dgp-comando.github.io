#!/usr/bin/env python3
"""Gera as ottobacias (microbacias) do IDR para a aba Aspectos físicos.

Fonte: GEOPROCESSAMENTO/PROtto/PROtto.gpkg (IDR-Paraná): 6.210 ottobacias de
Otto Pfafstetter (mediana ~3.000 ha) com a grande bacia hidrográfica, o código
Otto e, em 98 delas, o manancial de abastecimento (Sanepar ou IDR-Paraná).
Não existe no GeoPR; as áreas de contribuição por trecho (IAT 2020) vêm ao vivo
de lá numa camada separada.

Saídas:
  public/data/ottobacias-idr-pr.geojson     polígonos simplificados (EPSG:4326)
  public/data/ottobacias-municipios.json    por município: quantas ottobacias
                                            tocam o município e os mananciais

Uso:  py -3 scripts/build_ottobacias.py
Requer: geopandas, shapely 2.
"""

import json
from pathlib import Path

import geopandas as gpd
import shapely

ROOT = Path(__file__).resolve().parent.parent
FONTE = Path('H:/IDR-PARANA/GEOPROCESSAMENTO/PROtto/PROtto.gpkg')
MUNI = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT_GEO = ROOT / 'public' / 'data' / 'ottobacias-idr-pr.geojson'
OUT_MUN = ROOT / 'public' / 'data' / 'ottobacias-municipios.json'

UTM = 31982
TOL_M = 50          # simplificação do desenho (polígonos de ~3.000 ha, ~5 km de lado)
MIN_TOQUE_HA = 1    # interseção menor que isso é ruído de divisa, não conta
# Classe do manancial -> chave da legenda (src/maplibre/layers/ottobacias.js).
CLASSE = {'Sanepar': 'sanepar', 'IDR-Paraná': 'idr'}


def carrega():
    g = gpd.read_file(FONTE).to_crs(UTM)
    g['geometry'] = shapely.make_valid(g.geometry.values, method='structure', keep_collapsed=False)
    classe = g['Classe'].fillna('').str.strip()
    g = g.assign(
        cod=g['Cod_otto'].astype(str).str.strip(),
        bacia=g['Nome_bacia'].fillna('').str.strip(),
        ha=g.geometry.area / 1e4,
        man=classe.map(CLASSE).fillna('demais'),
        manancial=g['Manancial'].where(classe.isin(CLASSE.keys()), None),
    )
    return g[['cod', 'bacia', 'ha', 'man', 'manancial', 'geometry']]


def geojson(g):
    d = g.copy()
    d['geometry'] = shapely.simplify(d.geometry.values, TOL_M, preserve_topology=True)
    d['ha'] = d['ha'].round(0).astype(int)
    d = d.to_crs(4326)
    fc = json.loads(d.to_json(drop_id=True))
    for f in fc['features']:
        f['properties'] = {k: v for k, v in f['properties'].items() if v is not None}
        f['geometry']['coordinates'] = _arredonda(f['geometry']['coordinates'])
    OUT_GEO.write_text(json.dumps(fc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{OUT_GEO.name}: {len(fc["features"])} ottobacias, {OUT_GEO.stat().st_size / 1e6:.1f} MB')


def _arredonda(c, casas=4):  # ~10 m, abaixo da simplificação
    return [round(c[0], casas), round(c[1], casas)] if isinstance(c[0], float) else [_arredonda(x, casas) for x in c]


def por_municipio(g):
    munis = gpd.read_file(MUNI)[['CD_MUN', 'geometry']].to_crs(UTM)
    pares = gpd.sjoin(g, munis, predicate='intersects')
    toque = shapely.area(shapely.intersection(
        pares.geometry.values, munis.geometry.values[pares['index_right'].to_numpy()], grid_size=0.01)) / 1e4
    pares = pares[toque >= MIN_TOQUE_HA]
    out = {}
    for cod, grupo in pares.groupby('CD_MUN'):
        mans = (grupo[grupo['manancial'].notna()]
                .groupby(['manancial', 'man']).size().reset_index(name='n')
                .sort_values('manancial'))
        out[cod] = {
            'n': int(len(grupo)),
            'mananciais': [{'nome': r.manancial, 'classe': r.man, 'ottobacias': int(r.n)} for r in mans.itertuples()],
        }
    saida = {
        'fonte': 'IDR-Paraná · ottobacias de Otto Pfafstetter (PROtto), mananciais Sanepar e IDR-Paraná',
        'municipios': out,
    }
    OUT_MUN.write_text(json.dumps(saida, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    com = sum(1 for v in out.values() if v['mananciais'])
    print(f'{OUT_MUN.name}: {len(out)} municípios, {com} com manancial')


def main():
    g = carrega()
    print(f'{len(g)} ottobacias, {g["ha"].sum() / 1e6:.2f} milhões de ha, {g["manancial"].notna().sum()} em manancial')
    geojson(g)
    por_municipio(g)


if __name__ == '__main__':
    main()
