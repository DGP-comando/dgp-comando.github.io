#!/usr/bin/env python3
"""Gera assentamentos-incra-pr.geojson, ucs-federais-pr.geojson e ucs-estaduais-pr.geojson.

Fontes oficiais (download direto, sem login, conferido em 2026-09-13):
  - Assentamentos: INCRA, acervo de certificação, "Assentamento Brasil_PR"
    (SIPRA; 311 projetos no PR; SIRGAS 2000).
  - Unidades de conservação: MMA, Cadastro Nacional de UCs (CNUC), polígonos
    de 2025-08 (último shapefile com download direto no portal de dados
    abertos; o de 2026-07 está num SharePoint). Filtro: UCs cuja UF inclui o
    Paraná, esferas Federal e Estadual (municipais ficam de fora).

Os zips ficam em .gev-cache/limites/ (gitignored) e são reaproveitados.
Saída: GeoJSON UTF-8 compacto, geometria simplificada e coordenadas com 5
casas (~1 m), no padrão de scripts/optimize_geojson.py.

Uso: py -3 scripts/build_limites_ambientais.py
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import geopandas as gpd
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data'
CACHE = ROOT / '.gev-cache' / 'limites'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0'

INCRA_URL = 'https://certificacao.incra.gov.br/csv_shp/zip/Assentamento%20Brasil_PR.zip'
CNUC_URL = (
    'https://dados.mma.gov.br/dataset/44b6dc8a-dc82-4a84-8d95-1b0da7c85dac/resource/'
    '6ba9a557-87e8-4882-acb7-b3e0f0ea192d/download/shp_cnuc_2025_08.zip'
)

# Fases do SIPRA/INCRA (código numérico do campo `fase`).
FASES_INCRA = {
    1: 'Pré-projeto',
    2: 'Em criação',
    3: 'Criado',
    4: 'Em instalação',
    5: 'Em estruturação',
    6: 'Em consolidação',
    7: 'Consolidado',
}


def download(url: str, dest: Path) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=900) as resp:
            dest.write_bytes(resp.read())
        print(f'  baixado {dest.name}: {dest.stat().st_size / 1024:.0f} KB')
    return dest


def _round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], 5), round(obj[1], 5)]
        return [_round_coords(o) for o in obj]
    return obj


def _polygonal(geom):
    """Só a parte poligonal (make_valid pode devolver linhas/pontos junto); None se não houver."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ('Polygon', 'MultiPolygon'):
        return geom
    if geom.geom_type == 'GeometryCollection':
        polys = []
        for part in geom.geoms:
            if part.geom_type == 'Polygon':
                polys.append(part)
            elif part.geom_type == 'MultiPolygon':
                polys.extend(part.geoms)
        return MultiPolygon(polys) if polys else None
    return None


def _repair(geom):
    """buffer(0) desfaz autointerseções de polígono; make_valid como segunda tentativa."""
    if geom.is_valid:
        return geom
    fixed = _polygonal(geom.buffer(0))
    if fixed is not None and fixed.is_valid:
        return fixed
    fixed = _polygonal(make_valid(geom))
    return fixed if fixed is not None and fixed.is_valid else None


def to_geometry(geom, tolerance: float) -> dict | None:
    """Válida, simplificada (preservando topologia) e quantizada; None se degenerar."""
    geom = _polygonal(geom)
    if geom is None:
        return None
    geom = _repair(geom)
    if geom is None:
        return None
    simple = _polygonal(geom.simplify(tolerance, preserve_topology=True))
    if simple is None or not simple.is_valid:
        simple = geom
    gj = mapping(simple)
    rounded = shape({'type': gj['type'], 'coordinates': _round_coords(gj['coordinates'])})
    # Quantizar em 5 casas pode criar autointerseção em vértices muito
    # próximos: valida de novo e corrige (o Cesium falha ao triangular inválido).
    fixed = _repair(rounded)
    if fixed is None:
        return None
    gj = mapping(fixed)
    return {'type': gj['type'], 'coordinates': _round_coords(gj['coordinates'])}


def _num(value) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return None if n != n else n  # NaN -> None


def _text(value) -> str:
    return '' if value is None or (isinstance(value, float) and value != value) else str(value).strip()


def write_collection(name: str, features: list[dict], meta: dict) -> None:
    out = OUT / name
    payload = {'type': 'FeatureCollection', **meta, 'features': features}
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{name}: {len(features)} feições, {out.stat().st_size / 1024:.0f} KB')


def build_assentamentos() -> None:
    zip_path = download(INCRA_URL, CACHE / 'incra_assentamentos_pr.zip')
    gdf = gpd.read_file(f'zip://{zip_path}!Assentamento Brasil_PR.shp')
    if gdf.crs and gdf.crs.to_epsg() not in (4674, 4326):
        gdf = gdf.to_crs(4674)
    features = []
    for _, row in gdf.iterrows():
        geometry = to_geometry(row.geometry, 0.00005)
        if geometry is None:
            continue
        fase = int(row['fase']) if _num(row['fase']) is not None else None
        features.append({
            'type': 'Feature',
            'properties': {
                'codigo': _text(row['cd_sipra']),
                'nome': _text(row['nome_proje']),
                'municipio': _text(row['municipio']),
                'area_ha': _num(row['area_hecta']),
                'capacidade': _num(row['capacidade']),
                'familias': _num(row['num_famili']),
                'fase': FASES_INCRA.get(fase, _text(row['fase'])),
                'criacao': _text(row['data_de_cr']),
                'obtencao': _text(row['forma_obte']),
            },
            'geometry': geometry,
        })
    write_collection('assentamentos-incra-pr.geojson', features, {
        'fonte': 'INCRA · Acervo Fundiário (SIPRA), Assentamento Brasil_PR',
        'geradoEm': '2026-09-13',
    })


def read_cnuc(zip_path: Path) -> gpd.GeoDataFrame:
    # O DBF traz UTF-8 com textos truncados no meio de caracteres acentuados:
    # lê como latin-1 e recodifica, descartando só o byte cortado.
    gdf = gpd.read_file(f'zip://{zip_path}!cnuc_2025_08.shp', encoding='latin1')
    # Sem filtrar por dtype: no pandas 3 as colunas de texto são StringDtype, não object.
    for col in gdf.columns:
        if col != 'geometry':
            gdf[col] = gdf[col].map(
                lambda s: s.encode('latin1').decode('utf-8', errors='ignore') if isinstance(s, str) else s
            )
    return gdf


def build_ucs() -> None:
    zip_path = download(CNUC_URL, CACHE / 'cnuc_2025_08.zip')
    gdf = read_cnuc(zip_path)
    if gdf.crs and gdf.crs.to_epsg() not in (4674, 4326):
        gdf = gdf.to_crs(4674)
    no_pr = gdf[gdf['uf'].astype(str).str.upper().str.contains('PARANÁ')]
    for esfera, arquivo in (('Federal', 'ucs-federais-pr.geojson'), ('Estadual', 'ucs-estaduais-pr.geojson')):
        sub = no_pr[no_pr['esfera'] == esfera]
        features = []
        for _, row in sub.iterrows():
            geometry = to_geometry(row.geometry, 0.0001)
            if geometry is None:
                continue
            features.append({
                'type': 'Feature',
                'properties': {
                    'cnuc': _text(row['cd_cnuc']),
                    'nome': _text(row['nome_uc']),
                    'categoria': _text(row['categoria']),
                    'grupo': _text(row['grupo']),
                    'esfera': esfera,
                    'area_ha': _num(row['ha_total']),
                    'criacao': _text(row['cria_ano']),
                    'gestor': _text(row['org_gestor']),
                    'uf': _text(row['uf']),
                    'plano_manejo': _text(row['pl_manejo']),
                },
                'geometry': geometry,
            })
        write_collection(arquivo, features, {
            'fonte': 'MMA · Cadastro Nacional de Unidades de Conservação (CNUC), polígonos 2025-08',
            'geradoEm': '2026-09-13',
        })


if __name__ == '__main__':
    build_assentamentos()
    build_ucs()
