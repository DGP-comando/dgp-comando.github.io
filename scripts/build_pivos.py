#!/usr/bin/env python3
"""Pivos centrais de irrigacao do PR (ANA/INPE 2022) cruzados com as outorgas.

Fonte: projeto pivos-pr (G:/UPWORK/01-CONTRACTS/pivos-pr, ver o README de la),
output/pivos_x_outorgas.gpkg camada `pivos`: 302 pivos do Levantamento da
Agricultura Irrigada por Pivos Centrais (ANA/INPE, base 2022), com a demanda
estimada e a outorga mais provavel (IAT SIGARH/CRH ou ANA) e a classe do
vinculo (ALTA, VAZAO INCOMPATIVEL, DISTANTE, SEM OUTORGA).

Saida: public/data/pivos-pr.geojson, cada pivo duas vezes: o poligono (zoom de
perto) e o ponto interno (vista do estado, onde 50 ha somem). LGPD: sem o
requerente da outorga (pessoa fisica); empreendimento fica, como na camada de
outorgas.

Uso: py -3 scripts/build_pivos.py   (PIVOS_ROOT sobrescreve a origem)
"""

import json
import math
import os
from pathlib import Path

import pyogrio

ROOT = Path(os.environ.get('PIVOS_ROOT', 'G:/UPWORK/01-CONTRACTS/pivos-pr'))
GPKG = ROOT / 'output' / 'pivos_x_outorgas.gpkg'
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'pivos-pr.geojson'

CAMPOS = {
    'id_pivo': 'id', 'id_sistema': 'sistema', 'NM_MUN': 'municipio', 'area_ha': 'ha', 'demanda_m3h': 'demanda',
    'n_pivos_sistema': 'pivosSistema', 'confianca': 'vinculo', 'n_outorgas': 'nOutorgas',
    'q_outorgada_m3h': 'qOutorgada', 'cobertura': 'cobertura', 'dist_outorga_principal_m': 'dist',
    'out_fonte': 'fonte', 'out_ato': 'ato', 'out_tipo_ato': 'tipoAto', 'out_situacao': 'situacao',
    'out_vigente_hoje': 'vigente', 'out_empreendimento': 'empreendimento', 'out_corpo_hidrico': 'corpoHidrico',
    'out_manancial': 'manancial', 'out_q_max_m3h': 'qMax', 'out_dt_vencimento': 'vencimento',
}
CLASSES = {'ALTA', 'VAZÃO INCOMPATÍVEL', 'DISTANTE', 'SEM OUTORGA'}


def limpo(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, float):
        return round(v, 2)
    if hasattr(v, 'item'):
        return v.item()
    if isinstance(v, int):
        return v
    return str(v).strip() or None


def main() -> None:
    df = pyogrio.read_dataframe(GPKG, layer='pivos')
    if df.crs is None or df.crs.to_epsg() != 4674:
        raise SystemExit(f'CRS inesperado: {df.crs}')
    fora = set(df['confianca']) - CLASSES
    if fora:
        raise SystemExit(f'classes nao mapeadas: {fora}')
    if df['id_pivo'].duplicated().any():
        raise SystemExit('id_pivo duplicado')

    feats = []
    for _, r in df.iterrows():
        props = {novo: limpo(r[velho]) for velho, novo in CAMPOS.items()}
        geom = r.geometry
        anel = [[round(x, 6), round(y, 6)] for x, y in geom.exterior.coords]
        feats.append({'type': 'Feature', 'properties': props, 'geometry': {'type': 'Polygon', 'coordinates': [anel]}})
        p = geom.representative_point()
        feats.append({'type': 'Feature', 'properties': props,
                      'geometry': {'type': 'Point', 'coordinates': [round(p.x, 6), round(p.y, 6)]}})
    fc = {'type': 'FeatureCollection', 'fonte': 'ANA/INPE · pivôs centrais 2022 × outorgas IAT/ANA (pivos-pr)', 'features': feats}
    OUT.write_text(json.dumps(fc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(df)} pivos, {df.area_ha.sum():.0f} ha -> {OUT.name} {OUT.stat().st_size / 1e3:.0f} KB')


if __name__ == '__main__':
    main()
