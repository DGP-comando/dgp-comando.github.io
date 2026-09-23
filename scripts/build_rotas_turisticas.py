#!/usr/bin/env python3
"""Gera public/data/rotas-turisticas-pr.geojson.

Pontos das rotas turísticas do PR recebidos em KMZ (Google My Maps), sem
edição, em data/rotas-turisticas/: Rota do Queijo Paranaense e Rota da Uva e
do Vinho. Cada ponto leva `rota`, `nome` e `descricao` (texto do balão do
My Maps, com as quebras de linha preservadas e o HTML removido).

Uso:
  py -3 scripts/build_rotas_turisticas.py
"""

import html
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'data' / 'rotas-turisticas'
OUT = ROOT / 'public' / 'data' / 'rotas-turisticas-pr.geojson'
ROTAS = {
    'rota-do-queijo.kmz': 'Rota do Queijo Paranaense',
    'rota-da-uva-e-vinho.kmz': 'Rota da Uva e do Vinho',
}
NS = {'k': 'http://www.opengis.net/kml/2.2'}


def texto(desc):
    s = re.sub(r'<br\s*/?>', '\n', desc or '', flags=re.I)
    s = html.unescape(re.sub(r'<[^>]+>', '', s))
    linhas = [re.sub(r'[ \t]+', ' ', ln).strip() for ln in s.split('\n')]
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(linhas)).strip()


def main():
    feats = []
    for arq, rota in ROTAS.items():
        with zipfile.ZipFile(SRC / arq) as z:
            kml = z.read(next(n for n in z.namelist() if n.endswith('.kml')))
        n = 0
        for pm in ET.fromstring(kml).iter('{%s}Placemark' % NS['k']):
            c = pm.find('.//k:Point/k:coordinates', NS)
            if c is None:
                continue
            lon, lat = (float(v) for v in c.text.strip().split(',')[:2])
            if not (-55 < lon < -48 and -27 < lat < -22):
                print(f'  fora do PR, ignorado: {rota} / {pm.findtext("k:name", "", NS)}')
                continue
            feats.append({'type': 'Feature', 'properties': {
                'rota': rota,
                'nome': (pm.findtext('k:name', '', NS) or '').strip(),
                'descricao': texto(pm.findtext('k:description', '', NS)),
            }, 'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]}})
            n += 1
        print(f'{rota}: {n} pontos')
    OUT.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(feats)} pontos, {OUT.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
