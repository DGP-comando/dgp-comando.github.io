#!/usr/bin/env python3
"""Gera as camadas de logistica agro em public/data/.

Fontes (locais, ja LGPD-clean — sem contato/PII):
  1. armazens-conab-pr.geojson  <- valor-de-terras/.../logistics_pois_seed_pr.sql
     (cadastro CDA/CONAB 2023-11: ~2457 armazens + porto de Paranagua,
     capacidade em toneladas)
  2. agroindustrias-pr.geojson  <- valor-de-terras/.../cadeias_pois_seed.sql
     (SIGSIF/MAPA: frigorificos + laticinios, centroide municipal; OSM:
     serrarias)
  3. ceasas-pr.geojson          <- Overpass (name~ceasa no PR), com fallback
     hardcoded das 5 unidades da CEASA/PR se o Overpass falhar.

Uso: py -3 scripts/build_logistica.py
"""

import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'data'
SEEDS = Path('E:/UPWORK/01-CONTRACTS/valor-de-terras/supabase/migrations')
LOGISTICS_SQL = SEEDS / '20260703233100_logistics_pois_seed_pr.sql'
CADEIAS_SQL = SEEDS / '20260704140200_cadeias_pois_seed.sql'

POINT_RE = re.compile(r"st_makepoint\((-?\d+\.?\d*),\s*(-?\d+\.?\d*)\)")

# Fallback CEASA/PR (5 unidades publicas; coords aproximadas de sede)
CEASA_FALLBACK = [
    ('CEASA Curitiba', -49.3182, -25.5653),
    ('CEASA Londrina', -51.1371, -23.3486),
    ('CEASA Maringá', -51.9056, -23.4570),
    ('CEASA Cascavel', -53.4419, -24.9800),
    ('CEASA Foz do Iguaçu', -54.5510, -25.5090),
]


def parse_tuple_line(line):
    """Divide os campos de uma linha de VALUES respeitando aspas simples."""
    line = line.strip().rstrip(',;')
    if not (line.startswith('(') and line.endswith(')')):
        return None
    body = line[1:-1]
    fields, cur, in_q, depth = [], '', False, 0
    i = 0
    while i < len(body):
        ch = body[i]
        if in_q:
            if ch == "'":
                if i + 1 < len(body) and body[i + 1] == "'":
                    cur += "'"
                    i += 1
                else:
                    in_q = False
            else:
                cur += ch
        elif ch == "'":
            in_q = True
        elif ch == '(':
            depth += 1
            cur += ch
        elif ch == ')':
            depth -= 1
            cur += ch
        elif ch == ',' and depth == 0:
            fields.append(cur)
            cur = ''
        else:
            cur += ch
        i += 1
    fields.append(cur)
    return [f.strip() for f in fields]


def title_pt(name):
    small = {'de', 'da', 'do', 'das', 'dos', 'e'}
    words = str(name or '').lower().split()
    return ' '.join(w if (i > 0 and w in small) else w.capitalize() for i, w in enumerate(words))


def feat(lon, lat, props):
    return {
        'type': 'Feature',
        'properties': props,
        'geometry': {'type': 'Point', 'coordinates': [round(lon, 5), round(lat, 5)]},
    }


def build_armazens():
    feats = []
    for line in LOGISTICS_SQL.read_text(encoding='utf-8').splitlines():
        f = parse_tuple_line(line)
        if not f or len(f) < 8:
            continue
        kind = f[0]
        m = POINT_RE.search(f[7])
        if not m:
            continue
        lon, lat = float(m.group(1)), float(m.group(2))
        cap = None
        if f[6] not in ('null', ''):
            try:
                cap = int(float(f[6]))
            except ValueError:
                cap = None
        feats.append(feat(lon, lat, {
            'kind': kind,
            'nome': title_pt(f[2]),
            'municipio': f[3],
            'tipo': f[5],
            'cap_t': cap,
        }))
    out = OUT / 'armazens-conab-pr.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'armazens: {len(feats)} pontos, {out.stat().st_size / 1024:.0f} KB')


def build_agroindustrias():
    feats = []
    for line in CADEIAS_SQL.read_text(encoding='utf-8').splitlines():
        f = parse_tuple_line(line)
        if not f or len(f) < 6:
            continue
        kind = f[0]
        if kind not in ('frigorifico', 'laticinio', 'serraria'):
            continue
        m = POINT_RE.search(f[5])
        if not m:
            continue
        lon, lat = float(m.group(1)), float(m.group(2))
        feats.append(feat(lon, lat, {
            'kind': kind,
            'nome': title_pt(f[1]),
            'municipio': title_pt(f[2]),
        }))
    kinds = {}
    for x in feats:
        kinds[x['properties']['kind']] = kinds.get(x['properties']['kind'], 0) + 1
    out = OUT / 'agroindustrias-pr.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'agroindustrias: {kinds}, {out.stat().st_size / 1024:.0f} KB')


def build_ceasas():
    feats = []
    query = (
        '[out:json][timeout:60];area(3600297640)->.pr;'
        'nwr["name"~"ceasa",i](area.pr);out center;'
    )
    try:
        data = ('data=' + urllib.parse.quote(query)).encode()
        req = urllib.request.Request(
            'https://overpass-api.de/api/interpreter', data=data,
            headers={'User-Agent': 'datageo-command/1.0 (build script)'})
        with urllib.request.urlopen(req, timeout=120) as r:
            osm = json.load(r)
        seen = set()
        for el in osm.get('elements', []):
            name = (el.get('tags') or {}).get('name', '')
            if not name:
                continue
            lat = el.get('lat') or (el.get('center') or {}).get('lat')
            lon = el.get('lon') or (el.get('center') or {}).get('lon')
            if lat is None or lon is None:
                continue
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            feats.append(feat(lon, lat, {'kind': 'ceasa', 'nome': name}))
    except Exception as e:
        print(f'  Overpass falhou ({e}); usando fallback hardcoded')
    if len(feats) < 3:
        feats = [feat(lon, lat, {'kind': 'ceasa', 'nome': nome})
                 for nome, lon, lat in CEASA_FALLBACK]
    out = OUT / 'ceasas-pr.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'ceasas: {len(feats)} pontos')


if __name__ == '__main__':
    build_armazens()
    build_agroindustrias()
    time.sleep(2)
    build_ceasas()
