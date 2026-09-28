#!/usr/bin/env python3
"""Gera data/privado/susaf-pr.json: adesão dos municípios ao SUSAF-PR.

Fontes (recebidas da SEAB/ADAPAR, não públicas):
  1. Mapa "Número de estabelecimentos indicados ao SUSAF por município" (PDF
     vetorial da ADAPAR/DPAV/DISIM). Município colorido = aderiu (direto ou
     por consórcio); a cor é o nº de estabelecimentos indicados. O PDF não tem
     texto: os 399 contornos municipais georreferenciam o mapa (EPSG:4674,
     afim pela extensão) e cada polígono colorido vai para o município de
     maior IoU.
  2. Planilha "1 - Municípios.xlsx": municípios e consórcios com SIM próprio,
     responsável, telefone e e-mail. Consórcios vêm sem os municípios; os
     coloridos fora da planilha ficam como adesão "via consórcio".

Uso:  py -3 scripts/build_susaf.py <mapa.pdf> <municipios.xlsx> --data 2026-08-12
      py -3 scripts/upload_privado.py
Requer: pdfplumber, geopandas, pandas, openpyxl.
"""

import argparse
import json
import unicodedata
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pdfplumber
import shapely
from shapely import affinity
from shapely.geometry import Polygon

ROOT = Path(__file__).resolve().parent.parent
MUNICIPIOS = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT = ROOT / 'data' / 'privado' / 'susaf-pr.json'

# Cor de preenchimento da legenda (RGB 0-1, 3 casas) -> nº de estabelecimentos.
CORES = {
    (0.651, 0.808, 0.89): 0, (0.698, 0.875, 0.541): 1, (0.992, 0.749, 0.435): 2,
    (0.079, 0.434, 0.612): 3, (0.847, 0.641, 0.522): 4, (0.455, 0.431, 0.417): 6,
    (0.878, 0.264, 0.0): 8, (0.349, 0.045, 0.202): 10, (0.949, 0.428, 0.428): 12,
}
# Grafias da planilha que não batem com o IBGE.
ALIAS = {'MANFRIONOPOLIS': 'MANFRINOPOLIS', 'QUATIGA': 'QUATIGUA'}
CONSORCIOS = {'CICA', 'CICENOP', 'CID CENTRO', 'COMESP'}
MIN_IOU = 0.5


def norm(s) -> str:
    v = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().upper()
    v = ' '.join(v.replace("' ", "'").split())
    return ALIAS.get(v, v)


def _poly(curve) -> Polygon:
    p = Polygon(curve['pts'])
    return p if p.is_valid else p.buffer(0)


def _cor(curve):
    c = curve.get('non_stroking_color')
    return tuple(round(v, 3) for v in c) if isinstance(c, (tuple, list)) and len(c) == 3 else None


def estabelecimentos_do_mapa(pdf: Path, mun: gpd.GeoDataFrame) -> dict[str, int]:
    curvas = [c for c in pdfplumber.open(pdf).pages[0].curves if len(c['pts']) >= 4]
    contornos = [_poly(c) for c in curvas if not c.get('fill') and _cor(c)]
    if len(contornos) != len(mun):
        raise SystemExit(f'{len(contornos)} contornos no PDF, esperado {len(mun)}')
    bx = shapely.unary_union(contornos).bounds
    mb = mun.total_bounds
    sx, sy = (mb[2] - mb[0]) / (bx[2] - bx[0]), (mb[3] - mb[1]) / (bx[3] - bx[1])
    if abs(sx / sy - 1) > 0.02:
        raise SystemExit(f'escala x/y = {sx / sy:.3f}: o mapa não está em EPSG:4674')
    # PDF: y cresce para baixo (top); mapa: latitude cresce para cima.
    matriz = [sx, 0, 0, -sy, mb[0] - sx * bx[0], mb[3] + sy * bx[1]]
    idx = mun.sindex
    out: dict[str, int] = {}
    for c in curvas:
        n = CORES.get(_cor(c)) if c.get('fill') else None
        if n is None:
            continue
        g = affinity.affine_transform(_poly(c), matriz)
        iou = {i: mun.geometry.iloc[i].intersection(g).area / mun.geometry.iloc[i].union(g).area
               for i in idx.query(g, predicate='intersects')}
        i = max(iou, key=iou.get, default=None)
        if i is None or iou[i] < MIN_IOU:
            raise SystemExit(f'polígono de cor {n} sem município (IoU {iou.get(i, 0):.2f})')
        cd = str(mun['CD_MUN'].iloc[i])
        if out.get(cd, n) != n:
            raise SystemExit(f'{mun.NM_MUN.iloc[i]}: cores diferentes ({out[cd]} e {n})')
        out[cd] = n
    return out


def sim_da_planilha(xlsx: Path, por_nome: dict[str, str]):
    df = pd.read_excel(xlsx).fillna('')
    col_nome, col_resp, col_tel, col_mail = df.columns[:4]
    sims, consorcios, desconhecidos = {}, {}, []
    for _, r in df.iterrows():
        bruto = str(r[col_nome]).strip()
        suspenso = 'SUSPENSO' in norm(bruto)
        nome = bruto.split(' - ')[0].strip() if suspenso else bruto
        contato = {'responsavel': str(r[col_resp]).strip(), 'telefone': str(r[col_tel]).strip(),
                   'email': str(r[col_mail]).strip()}
        if norm(nome) in CONSORCIOS:
            consorcios[nome] = contato
        elif norm(nome) in por_nome:
            sims[por_nome[norm(nome)]] = {**contato, 'suspenso': suspenso}
        else:
            desconhecidos.append(bruto)
    if desconhecidos:
        raise SystemExit(f'nomes da planilha fora do IBGE: {desconhecidos}')
    return sims, consorcios


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf', type=Path)
    ap.add_argument('xlsx', type=Path)
    ap.add_argument('--data', required=True, help='data de referência do mapa (AAAA-MM-DD)')
    a = ap.parse_args()

    mun = gpd.read_file(MUNICIPIOS).to_crs(4674)
    por_nome = {norm(n): str(c) for n, c in zip(mun.NM_MUN, mun.CD_MUN)}
    nomes = {str(c): n for n, c in zip(mun.NM_MUN, mun.CD_MUN)}
    estab = estabelecimentos_do_mapa(a.pdf, mun)
    sims, consorcios = sim_da_planilha(a.xlsx, por_nome)

    municipios = {}
    for cd in sorted(set(estab) | set(sims)):
        sim = sims.get(cd)
        municipios[cd] = {
            'adesao': 'sim-proprio' if sim else 'consorcio',
            'estabelecimentos': estab.get(cd),  # None: na planilha, mas em branco no mapa
            'suspenso': bool(sim and sim['suspenso']),
            'sim': {k: sim[k] for k in ('responsavel', 'telefone', 'email')} if sim else None,
        }
    divergentes = sorted(nomes[cd] for cd in sims if cd not in estab)
    payload = {
        'fonte': 'SEAB/ADAPAR · SUSAF-PR (mapa DPAV/DISIM e lista de municípios com SIM)',
        'dataMapa': a.data,
        'consorcios': consorcios,
        'municipios': municipios,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')
    via = sum(m['adesao'] == 'consorcio' for m in municipios.values())
    print(f'{OUT.relative_to(ROOT)}: {len(municipios)} municípios ({len(sims)} com SIM próprio, {via} via consórcio), '
          f'{sum(1 for v in estab.values() if v)} com estabelecimentos; na planilha e em branco no mapa: {divergentes}')


if __name__ == '__main__':
    main()
