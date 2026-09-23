#!/usr/bin/env python3
"""Indicadores por município para a ficha municipal e as camadas regionais.

Saídas:
  data/privado/indicadores-municipios.json   (bucket privado: vem de dado do IDR/SEAB)
    {municipios: {ibge: {agro_total, agro_idr, km_total, km_rural, km_conv,
                         associacoes: [sigla], regional}}, associacoes: {sigla: nome}, ...}
  public/data/regionais-idr-pr.geojson        contorno das regionais do IDR (dissolve)
  public/data/associacoes-pr.geojson          contorno das associações de municípios

Fontes:
  - agroindústrias: data/privado/agroindustrias-pr.geojson (frigoríficos/laticínios SIGSIF) +
    data/privado/agroindustrias-idr-pr.geojson (cadastro IDR). total = soma das
    duas; idr = só o cadastro. Contagem por ponto-no-polígono.
  - estradas: rodovias federais/estaduais (public/data) + malha municipal OSM
    urbana/rural (public/data/estradas, tiles de slice_grid.py). km_rural = classe
    rural do OSM (unclassified/track/road). km_conv = convênios SEAB 2026
    (grupo 'conveniadas'). Comprimentos em SIRGAS 2000 / UTM 22S (EPSG:31982),
    recortados pelo limite municipal. Os tiles estão simplificados a 8 m e sem
    trechos < 25 m (build_estradas.py): o total fica levemente subestimado.
  - regionais: data/regionais-idr/Mapa_Regionais_IDR-Parana.html (data-m/data-r).
  - associações: data/associacoes/associacoes-pr.json (SECID-PR; 27 municípios em duas).

Uso: py -3 scripts/build_indicadores_municipais.py   (depois: scripts/upload_privado.py)
"""

import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString

ROOT = Path(__file__).resolve().parents[1]
PUB = ROOT / 'public' / 'data'
PRIV = ROOT / 'data' / 'privado'
MUN = PUB / 'municipios-pr.geojson'
HTML_REGIONAIS = ROOT / 'data' / 'regionais-idr' / 'Mapa_Regionais_IDR-Parana.html'
ASSOCIACOES = ROOT / 'data' / 'associacoes' / 'associacoes-pr.json'
METRICO = 'EPSG:31982'
GEO = 'EPSG:4674'


def norm(nome):
    s = unicodedata.normalize('NFKD', str(nome)).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]', '', s)


def municipios():
    g = gpd.read_file(MUN).set_crs(GEO, allow_override=True)
    g['ibge'] = g['CD_MUN'].astype(str)
    g['chave'] = g['NM_MUN'].map(norm)
    return g[['ibge', 'NM_MUN', 'chave', 'geometry']]


def por_nome(mun, pares, rotulo):
    """{nome do município: valor} -> {ibge: valor}; falha se algum nome não casar."""
    idx = dict(zip(mun['chave'], mun['ibge']))
    out, sobra = {}, []
    for nome, valor in pares:
        ibge = idx.get(norm(nome))
        (sobra.append(nome) if ibge is None else out.__setitem__(ibge, valor))
    if sobra:
        sys.exit(f'{rotulo}: nomes sem município correspondente: {sobra}')
    return out


def regionais(mun):
    html = HTML_REGIONAIS.read_text(encoding='utf-8')
    pares = re.findall(r'data-m="([^"]+)"\s+data-r="([^"]+)"', html)
    return por_nome(mun, [(unescape(m), unescape(r)) for m, r in pares], 'regionais')


def unescape(s):
    import html
    return html.unescape(s).strip()


def associacoes(mun):
    if not ASSOCIACOES.exists():
        print(f'[aviso] {ASSOCIACOES} ausente: associação fica vazia')
        return {}, {}, {}
    dados = json.loads(ASSOCIACOES.read_text(encoding='utf-8'))
    nomes = {a['sigla']: a['nome'] for a in dados['associacoes']}
    # 27 municípios pertencem a duas associações (fonte SECID-PR): lista por município.
    por_assoc = {a['sigla']: set(por_nome(mun, [(m, 1) for m in a['municipios']], a['sigla']))
                 for a in dados['associacoes']}
    assoc = {}
    for sigla, ibges in por_assoc.items():
        for ibge in ibges:
            assoc.setdefault(ibge, []).append(sigla)
    return assoc, nomes, por_assoc


def contar_pontos(mun, arquivo):
    pts = gpd.read_file(arquivo).set_crs(GEO, allow_override=True)
    j = gpd.sjoin(pts, mun[['ibge', 'geometry']], predicate='within', how='inner')
    return j.groupby('ibge').size()


def linhas_tiles():
    """Decodifica public/data/estradas (slice_grid.py) em GeoDataFrame com a classe."""
    pasta = PUB / 'estradas'
    idx = json.loads((pasta / 'index.json').read_text(encoding='utf-8'))
    esc, cell, classes = idx['escala'], idx['cell_deg'], idx['classes']
    geoms, cls = [], []
    for key in idx['cells']:
        i, j = (int(v) for v in key.split('_'))
        px, py = round(j * cell * esc), round(i * cell * esc)
        grupos = json.loads((pasta / f'{key}.json').read_text(encoding='utf-8'))['t']
        for k, trechos in enumerate(grupos):
            for enc in trechos:
                pts = []
                for n in range(0, len(enc), 2):
                    px += enc[n]
                    py += enc[n + 1]
                    pts.append((px / esc, py / esc))
                geoms.append(LineString(pts))
                cls.append(classes[k])
    return gpd.GeoDataFrame({'classe': cls}, geometry=geoms, crs=GEO)


def km_por_municipio(mun_m, linhas):
    """Soma de km de `linhas` recortadas por município (ambos em METRICO)."""
    if linhas.empty:
        return pd.Series(dtype=float)
    x = gpd.overlay(linhas[['geometry']], mun_m[['ibge', 'geometry']], how='intersection',
                    keep_geom_type=True)
    return x.assign(km=x.length / 1000).groupby('ibge')['km'].sum()


def estradas(mun):
    mun_m = mun.to_crs(METRICO)
    osm = linhas_tiles().to_crs(METRICO)
    fed = gpd.read_file(PUB / 'rodovias-federais-pr.geojson').set_crs(GEO, allow_override=True).to_crs(METRICO)
    est = gpd.read_file(PUB / 'rodovias-estaduais-pr.geojson').set_crs(GEO, allow_override=True).to_crs(METRICO)
    conv = gpd.read_file(PRIV / 'estradas-conveniadas-pr.geojson').set_crs(GEO, allow_override=True)
    conv = conv[conv['grupo'] == 'conveniadas'].to_crs(METRICO)
    rural = km_por_municipio(mun_m, osm[osm['classe'] == 'rurais'])
    urbana = km_por_municipio(mun_m, osm[osm['classe'] == 'urbanas'])
    rodov = km_por_municipio(mun_m, pd.concat([fed[['geometry']], est[['geometry']]], ignore_index=True))
    total = rural.add(urbana, fill_value=0).add(rodov, fill_value=0)
    return total, rural, km_por_municipio(mun_m, conv)


def dissolver(mun, atributo, nome_prop):
    g = mun.assign(grupo=mun['ibge'].map(atributo)).dropna(subset=['grupo'])
    d = g.dissolve(by='grupo', aggfunc={'ibge': list}).reset_index()
    d = d.rename(columns={'grupo': nome_prop, 'ibge': 'municipios'})
    d['geometry'] = d.geometry.buffer(0).simplify(0.002)
    return d


def contornos_associacoes(mun, por_assoc, nomes):
    """Um polígono por associação; os de municípios com dupla filiação se sobrepõem."""
    linhas = []
    for sigla, ibges in sorted(por_assoc.items()):
        geom = mun[mun['ibge'].isin(ibges)].geometry.union_all().buffer(0).simplify(0.002)
        linhas.append({'sigla': sigla, 'nome': nomes[sigla], 'municipios': sorted(ibges), 'geometry': geom})
    return gpd.GeoDataFrame(linhas, crs=GEO)


def salvar_geojson(gdf, caminho):
    fc = json.loads(gdf.to_json(drop_id=True))
    for f in fc['features']:
        f['geometry'] = arredondar(f['geometry'])
    caminho.write_text(json.dumps(fc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{caminho.relative_to(ROOT)}: {len(fc["features"])} polígonos, {caminho.stat().st_size // 1024} KB')


def arredondar(geom):
    def r(c):
        return [round(c[0], 5), round(c[1], 5)] if isinstance(c[0], (int, float)) else [r(x) for x in c]
    return {**geom, 'coordinates': r(geom['coordinates'])}


def main():
    mun = municipios()
    reg = regionais(mun)
    assoc, assoc_nomes, por_assoc = associacoes(mun)
    faltam = sorted(set(mun['ibge']) - set(reg))
    if faltam:
        sys.exit(f'municípios sem regional: {faltam}')

    agro_mapa = contar_pontos(mun, PRIV / 'agroindustrias-pr.geojson')
    agro_idr = contar_pontos(mun, PRIV / 'agroindustrias-idr-pr.geojson')
    km_total, km_rural, km_conv = estradas(mun)

    num = lambda s, k, casas=1: round(float(s.get(k, 0)), casas)
    saida = {
        'geradoEm': date.today().isoformat(),
        'fonte': 'IDR-Paraná (cadastro de agroindústrias, regionais) · SEAB (convênios 2026) · '
                 'OSM/DNIT/DER (estradas) · SECID-PR (associações de municípios)',
        'associacoes': assoc_nomes,
        'municipios': {
            ibge: {
                'agro_total': int(agro_mapa.get(ibge, 0) + agro_idr.get(ibge, 0)),
                'agro_idr': int(agro_idr.get(ibge, 0)),
                'km_total': num(km_total, ibge),
                'km_rural': num(km_rural, ibge),
                'km_conv': num(km_conv, ibge),
                'associacoes': sorted(assoc.get(ibge, [])),
                'regional': reg[ibge],
            }
            for ibge in sorted(mun['ibge'])
        },
    }
    out = PRIV / 'indicadores-municipios.json'
    out.write_text(json.dumps(saida, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    m = saida['municipios'].values()
    print(f'{out.relative_to(ROOT)}: {len(m)} municípios · agro {sum(x["agro_total"] for x in m)} '
          f'(IDR {sum(x["agro_idr"] for x in m)}) · {sum(x["km_total"] for x in m):,.0f} km '
          f'(rural {sum(x["km_rural"] for x in m):,.0f}, conv {sum(x["km_conv"] for x in m):,.1f}) · '
          f'{len(set(reg.values()))} regionais · {len(assoc)} com associação ({sum(len(v) > 1 for v in assoc.values())} em duas)')

    salvar_geojson(dissolver(mun, reg, 'regional'), PUB / 'regionais-idr-pr.geojson')
    if por_assoc:
        salvar_geojson(contornos_associacoes(mun, por_assoc, assoc_nomes), PUB / 'associacoes-pr.geojson')


if __name__ == '__main__':
    main()
