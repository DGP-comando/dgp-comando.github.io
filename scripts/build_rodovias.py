#!/usr/bin/env python3
"""Gera public/data/rodovias-{federais,estaduais}-pr.geojson via Overpass.

Malha rodoviaria do Parana a partir do OSM:
  - Federais:  ways com ref BR-xxx (BR-277, BR-376...)
  - Estaduais: ways com ref PR-xxx ou PRC-xxx
As municipais NAO entram aqui: sao buscadas em runtime pelo front
(datageoRodovias.js) via Overpass por bbox, so quando o zoom esta no
nivel de municipio — estaticamente seriam dezenas de MB.

Coordenadas arredondadas a 5 casas (~1 m) e decimadas (1 a cada 2 vertices
em ways densos) para caber no Pages.

Uso: py -3 scripts/build_rodovias.py
Re-rodar: quando o OSM mudar de forma relevante (raro; malha e estavel).
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / 'public' / 'data'
OVERPASS = 'https://overpass-api.de/api/interpreter'
UA = {'User-Agent': 'datageo-command/1.0 (build script)'}

# area do Parana no OSM (relation 297640 -> area id 3600297640)
AREA = 3600297640

QUERIES = {
    'federais': f"""
[out:json][timeout:180];
area({AREA})->.pr;
way["highway"]["ref"~"^BR-[0-9]+"](area.pr);
out geom;
""",
    'estaduais': f"""
[out:json][timeout:180];
area({AREA})->.pr;
way["highway"]["ref"~"^PRC?-[0-9]+"](area.pr);
out geom;
""",
}


def fetch(query, retries=3):
    data = ('data=' + urllib.parse.quote(query)).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(OVERPASS, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)
        except Exception as e:
            print(f'  tentativa {attempt + 1}: {e}')
            if attempt == retries - 1:
                raise
            time.sleep(15 * (attempt + 1))


def to_geojson(osm, decimate_over=60):
    feats = []
    for el in osm.get('elements', []):
        geom = el.get('geometry') or []
        if len(geom) < 2:
            continue
        pts = geom
        if len(pts) > decimate_over:
            # decima mantendo as pontas (curvas de rodovia toleram bem)
            pts = pts[::2] + ([geom[-1]] if geom[-1] not in pts[-1:] else [])
        coords = [[round(p['lon'], 5), round(p['lat'], 5)] for p in pts]
        tags = el.get('tags', {})
        feats.append({
            'type': 'Feature',
            'properties': {
                'ref': tags.get('ref', ''),
                'name': tags.get('name', ''),
            },
            'geometry': {'type': 'LineString', 'coordinates': coords},
        })
    return {'type': 'FeatureCollection', 'features': feats}


def main():
    for kind, query in QUERIES.items():
        print(f'{kind}: consultando Overpass...')
        osm = fetch(query)
        gj = to_geojson(osm)
        out = OUT_DIR / f'rodovias-{kind}-pr.geojson'
        out.write_text(
            json.dumps(gj, ensure_ascii=False, separators=(',', ':')),
            encoding='utf-8',
        )
        refs = {f['properties']['ref'] for f in gj['features']}
        print(f'  {len(gj["features"])} ways, {len(refs)} rodovias, '
              f'{out.stat().st_size / 1024:.0f} KB -> {out.name}')
        time.sleep(10)  # cortesia entre queries


if __name__ == '__main__':
    main()
