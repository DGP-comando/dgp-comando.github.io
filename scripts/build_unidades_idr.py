#!/usr/bin/env python3
"""Gera data/privado/unidades-idr-pr.geojson: endereços das unidades do IDR-Paraná.

Fonte: base Unidades_IDR (GEOPROCESSAMENTO/00_IDR, 442 pontos, 2024) auditada
contra "Endereços e Contatos" do site do IDR em 2026-09-28
(data/unidades-idr/, fora do repositório):
  - unidades_idr_corrigido.geojson: endereço/CEP do site, e-mail corrigido,
    13 pontos que estavam em outro município movidos para o geocódigo do
    endereço oficial; pendências em `problemas_pendentes`.
  - site_municipais.json / site_outros.json: o que o site publica.

Regras daqui:
  - ponto fora do próprio município (folga de ~500 m) -> sede do município
    (representative_point do limite IBGE), `aproximado`.
  - unidade no site e não na base -> sede do município, `aproximado`.
  - só contato institucional: e-mail @idr.pr.gov.br / @iapar.br de unidade
    (nominais saem), telefone fixo (celular sai).

Uso:  py -3 scripts/build_unidades_idr.py && py -3 scripts/upload_privado.py
"""

import json
import re
import unicodedata
from pathlib import Path

import geopandas as gpd
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'data' / 'unidades-idr'
MUNICIPIOS = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT = ROOT / 'data' / 'privado' / 'unidades-idr-pr.geojson'

TIPOS = {
    'Unidade Municipal de Extensão': 'ume', 'Unidade Regional de Extensão': 'regional',
    'Estação de Pesquisa': 'estacao', 'Polo de Pesquisa': 'polo', 'Sede': 'sede',
}
# E-mails nominais (pessoa, não unidade) conhecidos na base.
EMAIL_NOMINAL = {'dieissoni@iapar.br'}


def norm(s) -> str:
    return ' '.join(unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().upper().split())


def email_ok(e) -> str:
    e = str(e or '').strip().lower()
    return e if re.fullmatch(r'[a-z0-9._-]+@(idr\.pr\.gov\.br|iapar\.br)', e) and e not in EMAIL_NOMINAL else ''


def telefone_ok(t) -> str:
    t = str(t or '').strip()
    return '' if not t or t == 'nan' or re.search(r'\)\s*9\d{3,4}-?\d{4}', t) else t


def main():
    mun = gpd.read_file(MUNICIPIOS).to_crs(31982)
    sede = dict(zip(mun['NM_MUN'].map(norm), mun.geometry.representative_point().to_crs(4326)))
    limite = dict(zip(mun['NM_MUN'].map(norm), mun.to_crs(4326).geometry))
    nome_ibge = dict(zip(mun['NM_MUN'].map(norm), mun['NM_MUN']))

    base = gpd.read_file(SRC / 'unidades_idr_corrigido.geojson').to_crs(4326)
    linhas = []
    for _, r in base.iterrows():
        m = norm(r['MUNICÍPIO'])
        if m not in sede:
            raise SystemExit(f'município fora do IBGE: {r["MUNICÍPIO"]}')
        # ~500 m de folga: o limite IBGE generalizado deixa sedes de divisa "fora".
        fora = not limite[m].buffer(0.005).contains(r.geometry)
        linhas.append({
            'nome': f'{r["UNIDADE"]} · {nome_ibge[m]}' if TIPOS[r['UNIDADE']] in ('ume', 'regional', 'estacao', 'polo') else r['UNIDADE'],
            'tipo': TIPOS[r['UNIDADE']],
            'municipio': nome_ibge[m],
            'regional': r['REGIONAL'] or '',
            'endereco': r['ENDERECO'] or '',
            'telefone': telefone_ok(r['TELEFONE']),
            'email': email_ok(r['E-MAIL']),
            'aproximado': bool(fora),
            'no_site': r['fonte_endereco'] is not None and str(r['fonte_endereco']) != 'nan',
            'geometry': sede[m] if fora else r.geometry,
        })

    # No site e não na base: UMEs e unidades regionais novas.
    na_base = {(l['tipo'], norm(l['municipio'])) for l in linhas}
    site = json.loads((SRC / 'site_municipais.json').read_text(encoding='utf-8'))
    site += [s for s in json.loads((SRC / 'site_outros.json').read_text(encoding='utf-8'))
             if s.get('tipo') == 'Unidade Regional de Extensão']
    for s in site:
        tipo = TIPOS.get(s.get('tipo'))
        m = norm(s.get('municipio') or s.get('nome'))
        if tipo not in ('ume', 'regional') or (tipo, m) in na_base or m not in sede or s.get('sem_unidade'):
            continue
        linhas.append({
            'nome': f'{s["tipo"]} · {nome_ibge[m]}', 'tipo': tipo, 'municipio': nome_ibge[m],
            'regional': s.get('regional', ''), 'endereco': s.get('endereco', ''),
            'telefone': telefone_ok(s.get('telefone')), 'email': email_ok(s.get('email')),
            'aproximado': True, 'no_site': True, 'geometry': sede[m],
        })

    gdf = gpd.GeoDataFrame(pd.DataFrame(linhas), geometry='geometry', crs=4326)
    gdf['geometry'] = gdf.geometry.set_precision(1e-6)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(json.loads(gdf.to_json(drop_id=True)), ensure_ascii=False), encoding='utf-8')
    print(f'{OUT.relative_to(ROOT)}: {len(gdf)} unidades {gdf["tipo"].value_counts().to_dict()}, '
          f'{int(gdf["aproximado"].sum())} na sede municipal (aproximado), {int((~gdf["no_site"]).sum())} fora do site')


if __name__ == '__main__':
    main()
