#!/usr/bin/env python3
"""Umidade do solo no PR, último dia disponível do SMAP L4 (NASA), grade 0,09°.

O produto da página NASA-USDA Global Soil Moisture
(earth.gsfc.nasa.gov/hydro/data/nasa-usda-global-soil-moisture-data) parou no
Earth Engine (NASA_USDA/HSL/SMAP_soil_moisture vai até 2020-12-31 e o 10 km até
2022-08-02); o sucessor indicado pelo próprio catálogo é o SMAP L4
(NASA/SMAP/SPL4SMGP/008: 9 km, 3 em 3 horas, assimila o SMAP num modelo de
superfície). Aqui: média das 8 imagens do último dia, reamostrada numa grade
regular lat/lon sobre o PR, fora do estado = null.

Saída: public/data/umidade-solo-pr.json (dado aberto da NASA).
Uso: set EE_PROJECT=<projeto> && py -3 scripts/build_umidade_solo.py
"""

import json
import os
from pathlib import Path

ASSET = 'NASA/SMAP/SPL4SMGP/008'
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'umidade-solo-pr.json'
PASSO = 0.09
W, H = 75, 48
# Centros das células extremas (oeste/norte fixos, leste/sul pelo tamanho da grade).
BOUNDS = {'west': -54.65, 'north': -22.5,
          'east': round(-54.65 + (W - 1) * PASSO, 4), 'south': round(-22.5 - (H - 1) * PASSO, 4)}
# banda -> (chave no JSON, fator, casas)
BANDAS = {
    'sm_surface': ('sup', 100, 1),            # % volume, 0-5 cm
    'sm_rootzone': ('raiz', 100, 1),          # % volume, 0-100 cm
    'sm_profile': ('perfil', 100, 1),         # % volume, superfície ao leito rochoso
    'sm_rootzone_pctl': ('pctl', 1, 0),       # percentil climatológico da zona de raiz
    'sm_surface_anomaly': ('anom', 100, 1),   # anomalia da superfície, pontos percentuais
    'sm_rootzone_wetness': ('molh', 100, 0),  # grau de saturação da zona de raiz, %
}


def grade(ee, img, pr):
    w, h = W, H
    m = PASSO * 0.49  # meia célula, um tico para dentro: nem uma linha a mais
    # Grade com origem no canto noroeste; linha 0 do sampleRectangle = norte.
    proj = ee.Projection('EPSG:4326', [PASSO, 0, BOUNDS['west'] - PASSO / 2, 0, -PASSO, BOUNDS['north'] + PASSO / 2])
    ret = ee.Geometry.Rectangle([BOUNDS['west'] - m, BOUNDS['south'] - m, BOUNDS['east'] + m, BOUNDS['north'] + m], None, False)
    amostra = (img.clip(pr).reproject(proj).unmask(-9999)
               .sampleRectangle(region=ret, defaultValue=-9999).getInfo()['properties'])
    vals = {}
    for banda, (chave, fator, casas) in BANDAS.items():
        linhas = amostra[banda][::-1]  # sul primeiro
        assert len(linhas) == h and len(linhas[0]) == w, (banda, len(linhas), len(linhas[0]), h, w)
        vals[chave] = [None if v <= -9000 else round(v * fator, casas) for row in linhas for v in row]
    return w, h, vals


def main() -> None:
    import ee
    ee.Initialize(project=os.environ.get('EE_PROJECT'))
    col = ee.ImageCollection(ASSET)
    fim = ee.Date(col.sort('system:time_start', False).first().get('system:time_start'))
    dia = col.filterDate(fim.advance(-21, 'hour'), fim.advance(1, 'minute'))
    n = dia.size().getInfo()
    assert n == 8, f'esperava 8 imagens no dia, veio {n}'
    pr = ee.FeatureCollection('FAO/GAUL/2015/level1').filter(ee.Filter.eq('ADM1_NAME', 'Parana')).geometry().buffer(5000)
    w, h, vals = grade(ee, dia.select(list(BANDAS)).mean(), pr)
    data = fim.format('YYYY-MM-dd').getInfo()
    validos = sum(v is not None for v in vals['raiz'])
    assert validos > 2000, f'só {validos} células no PR'
    for chave, faixa in (('sup', (0, 100)), ('raiz', (0, 100)), ('pctl', (0, 100))):
        xs = [v for v in vals[chave] if v is not None]
        assert faixa[0] <= min(xs) and max(xs) <= faixa[1], (chave, min(xs), max(xs))
    doc = {'data': data, 'fonte': f'NASA SMAP L4 (SPL4SMGP v8) · média diária de {data}',
           'bounds': BOUNDS, 'width': w, 'height': h, **vals}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{data}: {w}x{h}, {validos} células no PR -> {OUT.name} {OUT.stat().st_size / 1e3:.0f} KB')


if __name__ == '__main__':
    main()
