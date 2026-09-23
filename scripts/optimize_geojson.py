#!/usr/bin/env python3
"""Otimiza os GeoJSON/JSON estaticos de public/data/ para o browser.

Para cada arquivo alvo:
  - linhas e poligonos: shapely simplify(tolerancia, preserve_topology=True),
    em graus (os dados estao em lon/lat, EPSG:4326/4674);
  - coordenadas quantizadas a 5 casas decimais (~1,1 m) e Z descartado
    quando e sempre 0;
  - vertices consecutivos repetidos (efeito da quantizacao) removidos;
  - propriedades de ruido OSM (@id, timestamp, version, changeset, user, uid)
    removidas, SO se nao forem referenciadas em src/;
  - JSON minificado (separators=(',', ':'), ensure_ascii=False, UTF-8).

Idempotente: o FeatureCollection recebe o membro "otimizacao" com a tolerancia
aplicada; rodar de novo com a mesma tolerancia nao simplifica outra vez (so
requantiza e reminifica, o que nao muda nada).

Salvaguardas por feicao: se o resultado ficar invalido (poligono) ou degenerado
(anel com menos de 4 vertices, linha com menos de 2), cai para a geometria
original apenas quantizada; se ainda assim quebrar, mantem a original intacta.
O numero de feicoes nunca muda.

Uso (da raiz do repo):
  py -3 scripts/optimize_geojson.py              # otimiza e grava
  py -3 scripts/optimize_geojson.py --dry-run    # so mostra a tabela
  py -3 scripts/optimize_geojson.py --backup-dir C:/tmp/geojson-orig
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

from shapely.geometry import mapping, shape

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public' / 'data'
SRC = ROOT / 'src'
DECIMALS = 5
MARKER = 'otimizacao'
OSM_NOISE = ('@id', 'timestamp', 'version', 'changeset', 'user', 'uid')

# Tolerancia em graus (0 = nao simplifica, so quantiza/minifica).
# municipios-pr: 0 de proposito. Simplificar poligono a poligono desalinha as
# divisas compartilhadas (frestas e sobreposicoes visiveis no hover), e o
# arquivo ja vem com 4 casas e ~200 KB.
TARGETS = {
    'rodovias-estaduais-pr.geojson': 0.00005,
    'rodovias-federais-pr.geojson': 0.00005,
    'ferrovias-pr.geojson': 0.00005,
    'linhas-transmissao-pr.geojson': 0.00005,
    'conectividade-sem-cobertura.geojson': 0.0001,
    'terras-indigenas-pr.geojson': 0.00002,
    'quilombolas-pr.geojson': 0.00002,
    'municipios-pr.geojson': 0.0,
    'armazens-conab-pr.geojson': 0.0,
    'usinas-pr.geojson': 0.0,
    'subestacoes-pr.geojson': 0.0,
    'ceasas-pr.geojson': 0.0,
    'conectividade-torres.json': None,  # None = JSON generico, so minifica
    'municipios-info.json': None,
}


@dataclass(frozen=True)
class Stats:
    size: int
    features: int
    vertices: int
    invalid: int


# ---------------------------------------------------------------- coordenadas

def _is_position(value) -> bool:
    return isinstance(value, list) and len(value) >= 2 and all(
        isinstance(v, (int, float)) for v in value)


def count_vertices(coords) -> int:
    if _is_position(coords):
        return 1
    if isinstance(coords, list):
        return sum(count_vertices(c) for c in coords)
    return 0


def all_z_zero(coords) -> bool:
    if _is_position(coords):
        return len(coords) < 3 or coords[2] == 0
    return all(all_z_zero(c) for c in coords)


def quantize(coords, keep_z: bool):
    """Arredonda posicoes e remove vertices consecutivos repetidos."""
    if _is_position(coords):
        dims = coords if keep_z else coords[:2]
        return [round(float(v), DECIMALS) for v in dims]
    out = [quantize(c, keep_z) for c in coords]
    if out and _is_position(out[0]):
        deduped = [out[0]]
        for pos in out[1:]:
            if pos != deduped[-1]:
                deduped.append(pos)
        return deduped
    return out


def geometry_ok(geom: dict) -> bool:
    """Estrutura minima que os loaders esperam (anel >= 4, linha >= 2)."""
    kind, coords = geom['type'], geom['coordinates']
    if kind == 'LineString':
        return len(coords) >= 2
    if kind == 'MultiLineString':
        return bool(coords) and all(len(line) >= 2 for line in coords)
    if kind == 'Polygon':
        return bool(coords) and all(len(r) >= 4 and r[0] == r[-1] for r in coords)
    if kind == 'MultiPolygon':
        return bool(coords) and all(
            poly and all(len(r) >= 4 and r[0] == r[-1] for r in poly) for poly in coords)
    return True


def is_invalid_polygon(geom: dict) -> bool:
    if not geom or geom['type'] not in ('Polygon', 'MultiPolygon'):
        return False
    try:
        return not shape(geom).is_valid
    except (ValueError, TypeError):
        return True


# ------------------------------------------------------------------ feicoes

def optimize_geometry(geom: dict, tolerance: float) -> tuple[dict, str]:
    """Devolve (geometria, desfecho) com desfecho em simplified|quantized|original."""
    if not geom or geom.get('type') not in (
            'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'):
        return geom, 'original'
    keep_z = not all_z_zero(geom['coordinates'])
    was_invalid = is_invalid_polygon(geom)
    candidates = []
    if tolerance > 0 and geom['type'] not in ('Point', 'MultiPoint'):
        simplified = shape(geom).simplify(tolerance, preserve_topology=True)
        if not simplified.is_empty and simplified.geom_type == geom['type']:
            candidates.append(('simplified', mapping(simplified)))
    candidates.append(('quantized', geom))
    for outcome, cand in candidates:
        new = {'type': geom['type'],
               'coordinates': quantize(json.loads(json.dumps(cand['coordinates'])), keep_z)}
        if not geometry_ok(new):
            continue
        if not was_invalid and is_invalid_polygon(new):
            continue
        return new, outcome
    return geom, 'original'


def referenced_in_src(name: str) -> bool:
    pattern = re.compile(re.escape(name))
    for path in SRC.rglob('*'):
        if path.suffix in ('.js', '.mjs', '.jsx', '.ts', '.tsx', '.vue', '.html') and path.is_file():
            if pattern.search(path.read_text(encoding='utf-8', errors='ignore')):
                return True
    return False


def droppable_props(features: list) -> set[str]:
    present = {k for f in features for k in (f.get('properties') or {})}
    return {k for k in present if k in OSM_NOISE and not referenced_in_src(k)}


def fc_stats(data: dict, size: int) -> Stats:
    feats = data.get('features', [])
    return Stats(
        size=size,
        features=len(feats),
        vertices=sum(count_vertices((f.get('geometry') or {}).get('coordinates', [])) for f in feats),
        invalid=sum(is_invalid_polygon(f.get('geometry')) for f in feats),
    )


def optimize_collection(data: dict, tolerance: float) -> tuple[dict, dict]:
    prior = data.get(MARKER) or {}
    already = prior.get('tolerancia', -1) >= tolerance and prior.get('casas') == DECIMALS
    effective = 0.0 if already else tolerance
    drop = droppable_props(data['features'])
    outcomes = {'simplified': 0, 'quantized': 0, 'original': 0}
    features = []
    for feat in data['features']:
        geom, outcome = optimize_geometry(feat.get('geometry'), effective)
        outcomes[outcome] += 1
        props = feat.get('properties')
        new_props = None if props is None else {k: v for k, v in props.items() if k not in drop}
        features.append({**feat, 'geometry': geom, 'properties': new_props})
    head = {k: v for k, v in data.items() if k not in ('features', MARKER)}
    if tolerance > 0 or prior:
        # So quem foi simplificado precisa do marcador de idempotencia.
        head[MARKER] = {'tolerancia': max(tolerance, prior.get('tolerancia', 0)), 'casas': DECIMALS}
    out = {**head, 'features': features}
    return out, {'outcomes': outcomes, 'dropped': sorted(drop), 'skipped_simplify': already}


# --------------------------------------------------------------------- main

def dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def human(n: int) -> str:
    return f'{n / 1024 / 1024:.2f} MB' if n >= 1024 * 1024 else f'{n / 1024:.0f} KB'


def process(name: str, tolerance, dry_run: bool, backup_dir: Path | None) -> dict | None:
    path = DATA / name
    if not path.exists():
        print(f'[skip] {name} nao existe', file=sys.stderr)
        return None
    raw = path.read_bytes()
    data = json.loads(raw.decode('utf-8'))
    is_fc = isinstance(data, dict) and data.get('type') == 'FeatureCollection'
    if tolerance is not None and not is_fc:
        raise ValueError(f'{name}: esperado FeatureCollection')
    if is_fc and tolerance is not None:
        before = fc_stats(data, len(raw))
        new, info = optimize_collection(data, tolerance)
    else:
        before = Stats(len(raw), 0, 0, 0)
        new, info = data, {'outcomes': {}, 'dropped': [], 'skipped_simplify': False}
    text = dump(new)
    encoded = text.encode('utf-8')
    after = fc_stats(new, len(encoded)) if is_fc and tolerance is not None else Stats(len(encoded), 0, 0, 0)
    if after.features != before.features:
        raise RuntimeError(f'{name}: contagem de feicoes mudou {before.features} -> {after.features}')
    json.loads(text)  # sanidade: o que sera gravado e JSON valido
    if not dry_run and encoded != raw:
        if backup_dir:
            backup_dir.mkdir(parents=True, exist_ok=True)
            target = backup_dir / name
            if not target.exists():
                shutil.copy2(path, target)
        path.write_text(text, encoding='utf-8', newline='')
    return {'name': name, 'tol': tolerance, 'before': before, 'after': after, **info}


def print_table(rows: list[dict]) -> None:
    head = f"{'arquivo':38} {'tol(deg)':>8} {'antes':>9} {'depois':>9} {'-%':>5} " \
           f"{'feicoes':>13} {'vertices antes->depois':>24} {'inval a->d':>10}"
    print(head)
    print('-' * len(head))
    tb = ta = 0
    for r in rows:
        b, a = r['before'], r['after']
        tb, ta = tb + b.size, ta + a.size
        pct = 100 * (1 - a.size / b.size) if b.size else 0
        tol = '-' if r['tol'] is None else f"{r['tol']:g}"
        feats = f'{b.features}->{a.features}' if b.features else '-'
        verts = f'{b.vertices}->{a.vertices}' if b.vertices else '-'
        inval = f'{b.invalid}->{a.invalid}' if b.features else '-'
        print(f"{r['name']:38} {tol:>8} {human(b.size):>9} {human(a.size):>9} {pct:>4.0f}% "
              f"{feats:>13} {verts:>24} {inval:>10}")
        extra = []
        fell_back = r['outcomes'] and (r['outcomes']['quantized'] or r['outcomes']['original'])
        if fell_back and r['tol'] and not r['skipped_simplify']:
            extra.append(f"fallback: {r['outcomes']['quantized']} so quantizadas, "
                         f"{r['outcomes']['original']} originais")
        if r['dropped']:
            extra.append(f"props removidas: {', '.join(r['dropped'])}")
        if r['skipped_simplify']:
            extra.append('ja otimizado (simplificacao nao reaplicada)')
        for line in extra:
            print(f"{'':40}{line}")
    print('-' * len(head))
    pct = 100 * (1 - ta / tb) if tb else 0
    print(f"{'TOTAL':38} {'':>8} {human(tb):>9} {human(ta):>9} {pct:>4.0f}%")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dry-run', action='store_true', help='nao grava, so reporta')
    parser.add_argument('--backup-dir', type=Path, help='copia os originais antes de sobrescrever')
    parser.add_argument('files', nargs='*', help='subconjunto de arquivos (nome em public/data)')
    args = parser.parse_args()
    names = args.files or list(TARGETS)
    unknown = [n for n in names if n not in TARGETS]
    if unknown:
        parser.error(f'sem configuracao: {unknown}')
    rows = [r for r in (process(n, TARGETS[n], args.dry_run, args.backup_dir) for n in names) if r]
    print_table(rows)
    if args.dry_run:
        print('\n(dry-run: nada gravado)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
