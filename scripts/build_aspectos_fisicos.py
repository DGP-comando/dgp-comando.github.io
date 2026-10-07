#!/usr/bin/env python3
"""Gera os resumos da aba Aspectos fisicos, por municipio, e o uso do solo recortado.

Saidas:
  public/data/aspectos-fisicos-pr.json   altitude, declividade, drenagem,
                                         nascentes e uso do solo de cada municipio
  public/data/uso-solo/{ibge}.png        uso do solo recortado pela malha do
                                         municipio (PNG paleta, 30 m, mercator)

O mapa mostra as camadas do GeoPR ao vivo; os numeros saem das MESMAS bases,
recortadas pela malha municipal do app (public/data/municipios-pr.geojson):
  altitude     MDE ALOS PALSAR 12,5 m (GEOPROCESSAMENTO/MDE_PR_12_5m.tif),
               lido a 25 m; nao ha MDE estadual no GeoPR
  declividade  IAT/GeoPR zee_declividade (ZEE-PR), baixada do FeatureServer
  drenagem     rede ottocodificada IAT 2020 (PRHidro2.gpkg = rede_otto_trech_drena_2020_iat)
  nascentes    FBDS (Nascentes_PR/nascentes_PR.shp = fbds_nascentes, 347.967 pontos)
  uso do solo  IAT, Mapeamento de Uso e Cobertura da Terra 2012-2016
               (o gpkg local = map_uso_cobertura_terra_2012 do GeoPR), NIVEL_II

Areas e comprimentos em SIRGAS 2000 / UTM 22S (EPSG:31982).

Uso:  py -3 scripts/build_aspectos_fisicos.py
Requer: geopandas, shapely 2, rasterio, numpy. Leva ~20-30 min (uso do solo e MDE).
Rodar de novo quando: o IAT publicar novo mapeamento de uso do solo ou drenagem.
"""

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import shapely
from rasterio.enums import Resampling
from PIL import Image
from pyproj import Transformer
from rasterio.features import geometry_mask, rasterize
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parent.parent
GEO = Path('H:/IDR-PARANA/GEOPROCESSAMENTO')
MUNI = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT = ROOT / 'public' / 'data' / 'aspectos-fisicos-pr.json'
OUT_USO = ROOT / 'public' / 'data' / 'uso-solo'
CACHE = ROOT / 'data' / 'cache'

MDE = GEO / 'MDE_PR_12_5m.tif'
HIDRO = GEO / 'PRHidro' / 'PRHidro2.gpkg'
NASC = GEO / 'Nascentes_PR' / 'nascentes_PR.shp'
USO = (GEO / 'uso do solo_iat_parana' / '00-Mapeamento_Uso_e_Cobertura_da_Terra_do_Estado_do_Parana_2012_2016'
       / 'Mapeamento_Uso_e_Cobertura_da_Terra_do_Estado_do_Parana_2012_2016.gpkg')
DECL_URL = ('https://geopr.iat.pr.gov.br/server/rest/services/00_PUBLICACOES/'
            'zee_declividade/FeatureServer/0/query')

UTM = 31982
# Faixas de altitude (m): as MESMAS paradas do color-relief da camada Altimetria.
FAIXAS_ALT = [200, 400, 600, 800, 1000, 1200]
# A ZEE grava "0 a 3" e "3 a 10" em parte das feicoes; a legenda do IAT junta em 0-10 %.
DECL_CLASSE = {'0 a 3': '0 a 10', '3 a 10': '0 a 10'}
USO_RES_M = 30  # pixel do PNG do uso do solo, no chão
# Cores do IAT (as mesmas de USO_SOLO em src/data/aspectosFisicos.js); a ordem é o índice da paleta.
USO_CORES = {
    'Agricultura Anual': '#89cd66', 'Agricultura Perene': '#cdcd66', 'Pastagem/Campo': '#70a800',
    'Floresta Nativa': '#267300', 'Plantios Florestais': '#38a800', 'Várzea': '#cd8966',
    'Corpos d’Água': '#73dfff', 'Mangue': '#cafce3', 'Restinga': '#b4d79e', 'Linha de Praia': '#ffd37f',
    'Solo Exposto/Mineração': '#732600', 'Área Construída': '#ff7f7f', 'Área Urbanizada': '#ff73df',
    'Sem classificação': '#b2b2b2',
}


def municipios():
    g = gpd.read_file(MUNI)[['CD_MUN', 'NM_MUN', 'geometry']].to_crs(UTM)
    g['geometry'] = poligonal(g.geometry.values)
    return g.reset_index(drop=True)


def poligonal(geoms):
    """make_valid só com saída de área. O método padrão (linework) devolve
    GeometryCollection de polígono + linha para anel colapsado, e o overlay
    do GEOS recusa essa entrada ("mixed-dimension") no recorte."""
    return shapely.make_valid(geoms, method='structure', keep_collapsed=False)


def so_areas(r):
    """Só as partes de área do recorte (a divisa devolve polígono + linha)."""
    r = r.explode(index_parts=False).explode(index_parts=False)
    return r[r.geometry.geom_type == 'Polygon']


def recorta(feicoes, munis):
    """Pares (feicao, municipio) com a geometria recortada; inteiras quando dentro."""
    pares = gpd.sjoin(feicoes, munis[['CD_MUN', 'geometry']], predicate='intersects', how='inner')
    a = pares.geometry.values
    b = munis.geometry.values[pares['index_right'].to_numpy()]
    dentro = shapely.within(a, b)
    geom = np.where(dentro, a, shapely.intersection(a, b, grid_size=0.01))
    return pares.drop(columns='index_right').set_geometry(gpd.GeoSeries(geom, index=pares.index, crs=UTM))


def nascentes(munis):
    pts = gpd.read_file(NASC, columns=[]).to_crs(UTM)
    j = gpd.sjoin(pts, munis[['CD_MUN', 'geometry']], predicate='within')
    print(f'nascentes: {len(pts)} pontos, {len(j)} dentro da malha')
    return j.groupby('CD_MUN').size().to_dict()


def drenagem(munis):
    linhas = gpd.read_file(HIDRO, columns=[]).to_crs(UTM)
    linhas = linhas[~linhas.geometry.is_empty & linhas.geometry.notna()].reset_index(drop=True)
    r = recorta(linhas, munis)
    km = (r.geometry.length / 1000).groupby(r['CD_MUN']).sum()
    print(f'drenagem: {len(linhas)} trechos, {km.sum():,.0f} km na malha')
    return km.to_dict()


def baixa_declividade():
    cache = CACHE / 'zee_declividade_31982.geojson'
    if cache.exists():
        return gpd.read_file(cache)
    ids = json.loads(_post(DECL_URL, {'where': '1=1', 'returnIdsOnly': 'true', 'f': 'json'}))['objectIds']
    ids.sort()
    feats = []
    for i in range(0, len(ids), 500):
        lote = ids[i:i + 500]
        j = json.loads(_post(DECL_URL, {
            'objectIds': ','.join(map(str, lote)), 'outFields': 'classe', 'outSR': str(UTM),
            'returnGeometry': 'true', 'f': 'geojson',
        }))
        feats += j['features']
        print(f'  declividade: {len(feats)}/{len(ids)}', end='\r')
    print()
    g = gpd.GeoDataFrame.from_features(feats, crs=UTM)
    CACHE.mkdir(parents=True, exist_ok=True)
    g.to_file(cache, driver='GeoJSON')
    return g


def _post(url, campos, tentativas=4):
    corpo = urllib.parse.urlencode(campos).encode()
    for k in range(tentativas):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=corpo), timeout=180) as r:
                return r.read().decode('utf-8')
        except Exception as err:  # GeoPR devolve 503 sob carga: tenta de novo
            if k == tentativas - 1:
                raise
            print(f'  retry {k + 1}: {err}')


def declividade(munis):
    d = baixa_declividade()
    d['classe'] = d['classe'].map(lambda c: DECL_CLASSE.get(c, c))
    d['geometry'] = poligonal(d.geometry.values)
    r = recorta(d[['classe', 'geometry']], munis)
    ha = (r.geometry.area / 1e4).groupby([r['CD_MUN'], r['classe']]).sum()
    print(f'declividade: {len(d)} poligonos, {ha.sum():,.0f} ha na malha')
    out = {}
    for (cod, classe), v in ha.items():
        out.setdefault(cod, {})[classe] = round(v)
    return out


def altitude(munis):
    out = {}
    with rasterio.open(MDE) as src:
        geoms = munis.to_crs(src.crs)
        for i, row in geoms.iterrows():
            w = from_bounds(*row.geometry.bounds, transform=src.transform).round_offsets().round_lengths()
            # Leitura a 25 m (metade da resolucao): sobra precisao para a ficha.
            shape = (max(1, w.height // 2), max(1, w.width // 2))
            # masked: a média ignora o nodata (0) do MDE em vez de puxar a cota para baixo.
            z = src.read(1, window=w, out_shape=shape, resampling=Resampling.average, boundless=True, masked=True)
            t = src.window_transform(w) * rasterio.Affine.scale(w.width / shape[1], w.height / shape[0])
            fora = geometry_mask([row.geometry], out_shape=shape, transform=t)
            dentro = ~fora & ~np.ma.getmaskarray(z)
            # O ALOS dá cotas negativas na planície costeira (ruído): contam como 0 m.
            v = np.maximum(z.data[dentro].astype(np.float64), 0)
            if not v.size:
                continue
            px_ha = abs(t.a * t.e) / 1e4
            bordas = [-np.inf, *FAIXAS_ALT, np.inf]
            n, _ = np.histogram(v, bins=bordas)
            out[row.CD_MUN] = {
                'min': int(v.min()), 'med': int(round(v.mean())), 'max': int(v.max()),
                'faixas': [round(x * px_ha) for x in n],
            }
            print(f'  altitude: {i + 1}/{len(geoms)}', end='\r')
    print()
    return out


def uso_solo(munis):
    """Area por classe (ha) e a imagem do uso do solo recortada de cada municipio.

    Desenho em PNG paleta, nao vetor: o mapeamento vem de classificacao de
    imagem e e muito fragmentado (4,3 milhoes de vertices so em Ponta Grossa,
    1,5 MB por municipio mesmo simplificado a 60 m). Em raster de 30 m o
    estado inteiro fica em ~20 MB.

    Um municipio por vez, lendo do gpkg so o retangulo dele: carregar os
    650 mil poligonos do estado de uma vez passava de 15 GB de RAM.
    """
    OUT_USO.mkdir(parents=True, exist_ok=True)
    caixas = munis.to_crs(4674).geometry.bounds.values
    out, bboxes, total = {}, {}, 0
    for i, (mun, caixa) in enumerate(zip(munis.itertuples(), caixas)):
        uso = gpd.read_file(USO, bbox=tuple(caixa), columns=['NIVEL_II']).to_crs(UTM)
        if uso.empty:
            continue
        uso['classe'] = uso['NIVEL_II'].fillna('Sem classificação')
        uso['geometry'] = poligonal(uso.geometry.values)
        # O recorte na divisa devolve GeometryCollection (polígono + linha): só as partes de área.
        r = so_areas(recorta(uso[['classe', 'geometry']], munis.iloc[[i]].reset_index(drop=True)))
        if r.empty:
            continue
        ha = (r.geometry.area / 1e4).groupby(r['classe']).sum()
        out[mun.CD_MUN] = {c: round(v) for c, v in ha.items() if v >= 0.5}
        bboxes[mun.CD_MUN] = _png_uso(mun.CD_MUN, r.to_crs(3857))
        total += (OUT_USO / f'{mun.CD_MUN}.png').stat().st_size
        print(f'  uso do solo: {i + 1}/{len(munis)}', end=chr(13))
    print()
    soma = sum(v for m in out.values() for v in m.values())
    print(f'uso do solo: {len(bboxes)} imagens, {total / 1e6:.1f} MB, {soma:,.0f} ha na malha')
    return out, bboxes


def _png_uso(cod, grupo):
    """PNG paleta em Web Mercator (o image source do MapLibre estica em mercator);
    devolve os cantos [w, s, e, n] em graus."""
    x0, y0, x1, y1 = grupo.total_bounds
    lat = np.degrees(2 * np.arctan(np.exp((y0 + y1) / 2 / 6378137)) - np.pi / 2)
    # ponytail: 30 m no chão; nítido até ~z13. Mais perto, pixel aparente (aceito).
    res = USO_RES_M / np.cos(np.radians(lat))
    w, h = int(np.ceil((x1 - x0) / res)), int(np.ceil((y1 - y0) / res))
    t = rasterio.transform.from_origin(x0, y1, res, res)
    idx = {c: i + 1 for i, c in enumerate(USO_CORES)}
    a = rasterize(((g, idx.get(c, idx['Sem classificação'])) for g, c in zip(grupo.geometry, grupo['classe'])),
                  out_shape=(h, w), transform=t, fill=0, dtype='uint8')
    im = Image.fromarray(a, 'P')
    paleta = [0, 0, 0] + [int(cor[k:k + 2], 16) for cor in USO_CORES.values() for k in (1, 3, 5)]
    im.putpalette(paleta)
    im.save(OUT_USO / f'{cod}.png', 'PNG', optimize=True, transparency=0)
    x1r, y0r = x0 + w * res, y1 - h * res  # borda real da imagem (pixels inteiros)
    (lw, ln), (le, ls) = Transformer.from_crs(3857, 4326, always_xy=True).itransform([(x0, y1), (x1r, y0r)])
    return [round(lw, 6), round(ls, 6), round(le, 6), round(ln, 6)]


def main():
    munis = municipios()
    amostra = sys.argv[1:]  # IBGEs: roda só esses e imprime, sem gravar o JSON
    if amostra:
        munis = munis[munis['CD_MUN'].isin(amostra)].reset_index(drop=True)
    area_ha = (munis.set_index('CD_MUN').geometry.area / 1e4).round().astype(int).to_dict()
    nasc = nascentes(munis)
    km = drenagem(munis)
    decl = declividade(munis)
    uso, uso_bbox = uso_solo(munis)
    alt = altitude(munis)
    saida = {
        'fonte': {
            'altitude': 'MDE ALOS PALSAR 12,5 m (IDR-Paraná, GEOPROCESSAMENTO), lido a 25 m',
            'declividade': 'IAT/GeoPR · ZEE-PR (zee_declividade)',
            'drenagem': 'IAT/GeoPR · rede hidrográfica ottocodificada 2020',
            'nascentes': 'FBDS via IAT/GeoPR (fbds_nascentes)',
            'uso': 'IAT/GeoPR · Mapeamento de Uso e Cobertura da Terra 2012-2016',
        },
        'faixasAltitude': FAIXAS_ALT,
        'municipios': {
            cod: {
                'areaHa': area_ha[cod],
                'alt': alt.get(cod),
                'decl': decl.get(cod, {}),
                'drenKm': round(km.get(cod, 0), 1),
                'nascentes': int(nasc.get(cod, 0)),
                'uso': uso.get(cod, {}),
                'usoBbox': uso_bbox.get(cod),
            }
            for cod in munis['CD_MUN']
        },
    }
    if amostra:
        print(json.dumps(saida['municipios'], ensure_ascii=False, indent=1))
        return
    OUT.write_text(json.dumps(saida, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{OUT}: {OUT.stat().st_size / 1e3:.0f} KB')


if __name__ == '__main__':
    sys.exit(main())
