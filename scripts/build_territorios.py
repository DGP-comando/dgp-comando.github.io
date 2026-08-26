#!/usr/bin/env python3
"""Gera terras-indigenas-pr.geojson e quilombolas-pr.geojson.

Fontes:
  - TIs: seed restricted_areas do projeto valor-de-terras (FUNAI/CMR,
    kind='ti', WKT ja simplificado ~11 m, bbox PR).
  - Quilombolas: shapefile oficial do INCRA (acervo de certificacao,
    "Áreas de Quilombolas", Brasil inteiro) filtrado no PR. Baixado uma
    vez para data/cache/ e reutilizado.

Uso: py -3 scripts/build_territorios.py
"""

import json
import re
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'data'
CACHE = Path(__file__).resolve().parent.parent / 'data' / 'cache'
SEED = Path('E:/UPWORK/01-CONTRACTS/valor-de-terras/supabase/migrations/'
            '20260704090600_restricted_areas_seed.sql')
# INCRA passou a exigir login (2026); a fonte publica e a malha OFICIAL de
# Territorios Quilombolas do Censo 2022 (IBGE, 2a apuracao 2023-12-22,
# SIRGAS 2000, 1:250k) — Brasil inteiro, filtramos o PR.
IBGE_TQ = (
    'https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/'
    'Quilombolas_Primeiros_resultados_do_universo/'
    'Arquivos_geoespaciais_vetoriais_2a_apuracao_20231222/'
    'BR_TQ_2a_apuracao_20231222.zip'
)

TUPLE_RE = re.compile(
    r"\('(?P<kind>[a-z]+)','(?P<nome>(?:[^']|'')*)','(?P<categoria>(?:[^']|'')*)',"
    r"'(?P<detalhe>(?:[^']|'')*)',(?:'(?P<ref>(?:[^']|'')*)'|null),(?P<area>[0-9.]+|null),"
    r"extensions\.st_multi\(extensions\.st_geomfromtext\('(?P<wkt>[^']+)'"
)


def build_tis():
    from shapely import wkt as shapely_wkt
    from shapely.geometry import mapping

    feats = []
    text = SEED.read_text(encoding='utf-8')
    for m in TUPLE_RE.finditer(text):
        if m.group('kind') != 'ti':
            continue
        geom = shapely_wkt.loads(m.group('wkt'))
        gj = mapping(geom)
        area = m.group('area')
        feats.append({
            'type': 'Feature',
            'properties': {
                'nome': m.group('nome').replace("''", "'"),
                'etapa': m.group('categoria').replace("''", "'"),
                'area_ha': float(area) if area not in (None, 'null') else None,
            },
            'geometry': json.loads(json.dumps(gj)),
        })
    out = OUT / 'terras-indigenas-pr.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'TIs: {len(feats)} poligonos, {out.stat().st_size / 1024:.0f} KB')


def build_quilombolas():
    import geopandas as gpd

    CACHE.mkdir(parents=True, exist_ok=True)
    zip_path = CACHE / 'ibge_tq_2022.zip'
    if not zip_path.exists():
        req = urllib.request.Request(
            IBGE_TQ,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0'})
        with urllib.request.urlopen(req, timeout=600) as r:
            zip_path.write_bytes(r.read())
        print(f'  baixado {zip_path.stat().st_size / 1024:.0f} KB do IBGE')

    shp = ('zip://' + str(zip_path) + '!BR_TQ_2apuracao_181023/'
           'CD2022_Territorios_Quilombolas_oficialmente_delimitados_181023.shp')
    gdf = gpd.read_file(shp)
    gdf.columns = [c.lower() for c in gdf.columns]
    print(f'  {len(gdf)} areas BR, colunas: {list(gdf.columns)[:10]}')
    uf_col = next((c for c in ('sg_uf', 'uf', 'uf_sigla', 'sigla_uf', 'cd_uf') if c in gdf.columns), None)
    if uf_col:
        pr = gdf[gdf[uf_col].astype(str).str.upper() == 'PR'].copy()
    else:
        # recorte espacial pelo bbox do PR
        pr = gdf.cx[-54.65:-48.0, -26.75:-22.5].copy()
    if pr.crs and pr.crs.to_epsg() != 4326:
        pr = pr.to_crs(4326)
    pr['geometry'] = pr['geometry'].simplify(0.0001)  # ~11 m

    nome_col = next((c for c in ('nom_tq', 'nm_comunid', 'nome', 'nm_quilomb', 'denominacao') if c in pr.columns), None)
    mun_col = next((c for c in ('municipio', 'nm_municip', 'cd_mun') if c in pr.columns), None)
    fase_col = next((c for c in ('fase', 'nr_fase', 'esfera', 'status') if c in pr.columns), None)

    feats = []
    for _, row in pr.iterrows():
        gj = json.loads(gpd.GeoSeries([row.geometry]).to_json())['features'][0]['geometry']
        feats.append({
            'type': 'Feature',
            'properties': {
                'nome': str(row.get(nome_col, '') or ''),
                'municipio': str(row.get(mun_col, '') or ''),
                'fase': str(row.get(fase_col, '') or ''),
            },
            'geometry': gj,
        })
    out = OUT / 'quilombolas-pr.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'quilombolas PR: {len(feats)}, {out.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    build_tis()
    build_quilombolas()
