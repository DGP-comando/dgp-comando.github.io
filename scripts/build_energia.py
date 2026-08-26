#!/usr/bin/env python3
"""Gera as camadas de transmissao de energia em public/data/.

Fonte: GeoJSONs EPE (Webmap EPE / expansao da transmissao) ja baixados no
projeto energy (E:/UPWORK/01-CONTRACTS/energy/data/raw/epe), recortados no
PR + vizinhanca:
  - linhas-transmissao-pr.geojson: LTs em operacao (248) + planejadas (49),
    props {nome, tensao, ano, planejada}
  - subestacoes-pr.geojson: SEs em operacao (83) + planejadas (10),
    props {nome, tensao, ano, planejada}

Coordenadas arredondadas a 5 casas. Re-rodar quando o projeto energy
atualizar os raw (scrapers/download_grid_pr.py de la).

Uso: py -3 scripts/build_energia.py
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'data'
EPE = Path('E:/UPWORK/01-CONTRACTS/energy/data/raw/epe')


def round_coords(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 5), round(coords[1], 5)]
    return [round_coords(c) for c in coords]


def load(name):
    return json.loads((EPE / name).read_text(encoding='utf-8'))['features']


def build_lts():
    feats = []
    for f in load('epe_lt_operacao_pr.geojson'):
        p = f['properties']
        feats.append({
            'type': 'Feature',
            'properties': {
                'nome': p.get('Nome', ''),
                'tensao': p.get('Tensao'),
                'ano': p.get('Ano_Opera'),
                'planejada': False,
            },
            'geometry': {'type': f['geometry']['type'],
                         'coordinates': round_coords(f['geometry']['coordinates'])},
        })
    for f in load('epe_lt_planejada_pr.geojson'):
        p = f['properties']
        feats.append({
            'type': 'Feature',
            'properties': {
                'nome': p.get('Nome', ''),
                'tensao': p.get('Tensao'),
                'ano': p.get('Ano_Planej'),
                'planejada': True,
            },
            'geometry': {'type': f['geometry']['type'],
                         'coordinates': round_coords(f['geometry']['coordinates'])},
        })
    out = OUT / 'linhas-transmissao-pr.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'LTs: {len(feats)} ({sum(1 for x in feats if x["properties"]["planejada"])} planejadas), '
          f'{out.stat().st_size / 1024:.0f} KB')


def build_ses():
    feats = []
    for name, planejada in (('epe_se_operacao_pr.geojson', False),
                            ('epe_se_planejada_pr.geojson', True)):
        for f in load(name):
            p = f['properties']
            feats.append({
                'type': 'Feature',
                'properties': {
                    'nome': p.get('Nome', ''),
                    'tensao': p.get('Tensao'),
                    'ano': p.get('Ano_Opera'),
                    'planejada': planejada,
                },
                'geometry': {'type': 'Point',
                             'coordinates': round_coords(f['geometry']['coordinates'])},
            })
    out = OUT / 'subestacoes-pr.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'SEs: {len(feats)} ({sum(1 for x in feats if x["properties"]["planejada"])} planejadas), '
          f'{out.stat().st_size / 1024:.0f} KB')





# ---------------------------------------------------------------------------
# Geracao: usinas SIGEL/ANEEL por tipo + aerogeradores
# ---------------------------------------------------------------------------

SIGEL = Path('E:/UPWORK/01-CONTRACTS/energy/data/raw/sigel')
USINA_FILES = {
    'uhe': 'sigel_uhe_pr.geojson',
    'pch': 'sigel_pch_pr.geojson',
    'cgh': 'sigel_cgh_pr.geojson',
    'ute': 'sigel_ute_pr.geojson',
    'eol': 'sigel_eol_pr.geojson',
    'ufv': 'sigel_ufv_pr.geojson',
}


def _pot_kw(p):
    for k in ('POT_KW', 'P_OUT_KW', 'P_FISC_KW', 'POT_FISC_KW'):
        v = p.get(k)
        if v:
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return None


def build_usinas():
    feats = []
    counts = {}
    for tipo, fname in USINA_FILES.items():
        data = json.loads((SIGEL / fname).read_text(encoding='utf-8'))
        for f in data['features']:
            p = f['properties']
            nome = p.get('NOME') or p.get('Nome') or ''
            feats.append({
                'type': 'Feature',
                'properties': {
                    'tipo': tipo,
                    'nome': nome,
                    'pot_kw': _pot_kw(p),
                },
                'geometry': {'type': 'Point',
                             'coordinates': round_coords(f['geometry']['coordinates'])},
            })
            counts[tipo] = counts.get(tipo, 0) + 1
    # Aerogeradores: torres individuais dos parques eolicos
    data = json.loads((SIGEL / 'sigel_aerogeradores_pr.geojson').read_text(encoding='utf-8'))
    for f in data['features']:
        p = f['properties']
        feats.append({
            'type': 'Feature',
            'properties': {
                'tipo': 'aerogerador',
                'nome': p.get('NOME_EOL') or '',
                'pot_kw': (float(p['POT_MW']) * 1000) if p.get('POT_MW') else None,
                'alt': p.get('ALT_TOTAL'),
            },
            'geometry': {'type': 'Point',
                         'coordinates': round_coords(f['geometry']['coordinates'])},
        })
    counts['aerogerador'] = len(data['features'])
    out = OUT / 'usinas-pr.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'usinas: {counts}, total {len(feats)}, {out.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    build_lts()
    build_ses()
    build_usinas()
