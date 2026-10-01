"""Fontes (nascentes) protegidas pelo IDR-Paraná com solo-cimento, para captação de água.

Entrada (fora do repositório, planilhas do programa de Proteção de Fontes):
    H:\\IDR-PARANA\\RECURSOS NATURAIS E SUSTENTABILIDADE\\01-PROTEÇÃO DE FONTES
      TabFontes_10NOV24c.xlsx                         base estadual (10/11/2024)
      Planilha_atualizar fonte_nov_24_reg_Campo Mourão.xlsx   atualização da regional

Saída: data/privado/fontes-protegidas.json (bucket privado: nome do produtor;
o CPF NÃO sai, só serve para ligar a fonte à família da CAF PF), com um ponto
por fonte e o resumo por município (total, construção x reforma, por ano).

Coordenadas: UTM sem fuso declarado. Tenta SIRGAS 2000 / 22S e depois 21S e
fica com o primeiro que cai no município da planilha; fora dele mas no PR, o
ponto entra marcado; fora do PR (ou sem coordenada) a fonte só entra nas
contagens.

    py -3 scripts/build_fontes_protegidas.py   (depois de build_caf.py, para o vínculo com a CAF)
"""
import json
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely
from pyproj import Transformer

from build_caf import E25, PRIV, PUB, cpf, norm

PASTA = Path(r'H:\IDR-PARANA\RECURSOS NATURAIS E SUSTENTABILIDADE\01-PROTEÇÃO DE FONTES')
BASE = PASTA / 'TabFontes_10NOV24c.xlsx'
CAMPO_MOURAO = PASTA / 'Planilha_atualizar fonte_nov_24_reg_Campo Mourão.xlsx'
REFERENCIA = '2024-11-10'
OUT = PRIV / 'fontes-protegidas.json'
UTM = [Transformer.from_crs(f'EPSG:{z}', 'EPSG:4674', always_xy=True) for z in (31982, 31981)]
TIPOS = ['Construção', 'Reforma', 'Cercamento', 'Caxambu']


def tipo(t):
    t = str(t or '').strip().capitalize()
    return t if t in TIPOS else 'Construção' if not t or t == 'Nan' else t


def ler():
    base = pd.read_excel(BASE, dtype=str)
    cm = pd.read_excel(CAMPO_MOURAO, sheet_name='Proteção de Nascentes', header=None, skiprows=2, dtype=str)
    cm = pd.DataFrame({
        'Regiao': cm[0], 'Municipio': cm[1], 'Comunidade': cm[2], 'Produtor': cm[3], 'CPF': cm[4],
        'UtmX': cm[5], 'UtmY': cm[6], 'Tipo': cm[7].where(cm[7].notna(), None).map(lambda v: 'Reforma' if v else 'Construção'),
        'AnoProt': cm[9], 'MesProt': cm[10],
    }).dropna(subset=['UtmX'])
    novas = cm[~cm.UtmX.isin(base.UtmX)]
    df = pd.concat([base, novas], ignore_index=True)
    antes = len(df)
    df = df.drop_duplicates(subset=['Municipio', 'Produtor', 'UtmX', 'UtmY', 'AnoProt'])
    print(f'base {len(base)} + {len(novas)} novas de Campo Mourão; {antes - len(df)} duplicadas fora')
    return df


def localiza(x, y, poly, pr):
    """(lon, lat, status) pela 1a zona UTM que cai no município; senão no PR; senão nada."""
    no_pr = None
    for t in UTM:
        lon, lat = t.transform(x, y)
        if poly is not None and shapely.contains_xy(poly, lon, lat):
            return lon, lat, 'ok'
        if no_pr is None and shapely.contains_xy(pr, lon, lat):
            no_pr = (lon, lat, 'fora_municipio')
    return no_pr or (None, None, 'sem_local')


def main():
    mun = gpd.read_file(PUB / 'municipios-pr.geojson').to_crs('EPSG:4674')
    poly = {str(m.CD_MUN): m.geometry.buffer(0.01) for m in mun.itertuples()}
    for g in poly.values():
        shapely.prepare(g)
    pr = shapely.union_all(list(poly.values()))
    shapely.prepare(pr)
    ibge_de = {norm(m.NM_MUN): str(m.CD_MUN) for m in mun.itertuples()}

    df = ler()
    df['ibge'] = df.CodIbge.where(df.CodIbge.notna() & df.CodIbge.isin(poly), df.Municipio.map(lambda m: ibge_de.get(norm(m))))
    sem_mun = df.ibge.isna()
    if sem_mun.any():
        print(f'  {int(sem_mun.sum())} sem município reconhecido: {sorted(set(df.Municipio[sem_mun]))}')
        df = df[~sem_mun]
    df['tipo'] = df.Tipo.map(tipo)
    df['ano'] = pd.to_numeric(df.AnoProt, errors='coerce')

    membros = pd.read_csv(E25 / '02 - MEMBROS_FAMILIARES.csv', dtype=str, keep_default_na=False, usecols=['nr_caf', 'nr_cpf'])
    fam_de_cpf = dict(zip(membros.nr_cpf.map(cpf), membros.nr_caf))

    pontos, status = [], {}
    for r in df.itertuples():
        x, y = pd.to_numeric(r.UtmX, errors='coerce'), pd.to_numeric(r.UtmY, errors='coerce')
        lon, lat, st = localiza(x, y, poly.get(r.ibge), pr) if x > 0 and y > 0 else (None, None, 'sem_local')
        status[st] = status.get(st, 0) + 1
        if lon is None:
            continue
        mes = re.sub(r'\s+', ' ', str(r.MesProt)).strip() if pd.notna(r.MesProt) else ''
        caf = fam_de_cpf.get(cpf(r.CPF)) if pd.notna(r.CPF) else None
        pontos.append([round(lon, 6), round(lat, 6), r.ibge,
                       '' if pd.isna(r.Comunidade) else str(r.Comunidade).strip(),
                       '' if pd.isna(r.Produtor) else re.sub(r'\s+', ' ', str(r.Produtor)).strip(),
                       TIPOS.index(r.tipo) if r.tipo in TIPOS else 0,
                       None if pd.isna(r.ano) else int(r.ano), mes, 0 if st == 'ok' else 1, caf])

    municipios = {}
    for ibge, g in df.groupby('ibge'):
        municipios[ibge] = {
            'total': len(g),
            'tipos': {t: int((g.tipo == t).sum()) for t in TIPOS if (g.tipo == t).any()},
            'por_ano': {str(int(a)): int(n) for a, n in g.ano.dropna().value_counts().sort_index().items()},
        }
    OUT.write_text(json.dumps({
        'fonte': 'IDR-Paraná · Proteção de Fontes (solo-cimento)', 'referencia': REFERENCIA, 'tipos': TIPOS,
        'campos': ['lon', 'lat', 'ibge', 'comunidade', 'produtor', 'tipo', 'ano', 'mes', 'fora_municipio', 'caf'],
        'p': pontos, 'municipios': municipios,
    }, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    com_caf = sum(1 for p in pontos if p[9])
    print(f'{len(df)} fontes em {len(municipios)} municípios · {len(pontos)} no mapa · {status} · '
          f'{com_caf} ligadas a família da CAF -> {OUT.name} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
