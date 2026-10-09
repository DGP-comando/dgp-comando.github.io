#!/usr/bin/env python3
"""Transformadores e postes da rede de distribuicao da Copel em PMTiles.

Fonte: BDGD COPEL-DIS 2022-12-31 V11 (ANEEL), a mesma base das linhas de media
tensao (build_distribuicao.py), lida direto da .gdb:

  - UNTRMT (unidades transformadoras de MT, 457.941 em operacao):
    public/data/copel-transformadores.pmtiles, zooms 10 e 12 (o MapLibre
    amplia o 12 dali para cima).
  - PONNOT (pontos notaveis: postes, derivacoes, torres; 3,75 milhoes):
    public/data/copel-postes.pmtiles, so o zoom 13 (um nivel ja passa de 40 MB).

PMTiles = um arquivo so, lido por HTTP Range (GitHub Pages e Vite respondem).
O GDAL (pyogrio) escreve o arquivo e reprojeta de EPSG:4674 para a grade web.

Atributos sao os codigos da BDGD; os rotulos ficam no front
(src/maplibre/layers/redeCopel.js). LGPD: so equipamento da rede, nenhuma
unidade consumidora.

Uso: py -3 scripts/build_rede_copel_pontos.py   (BDGD_GDB sobrescreve a origem)
"""

import os
from pathlib import Path

import pyogrio

GDB = Path(os.environ.get(
    'BDGD_GDB',
    'G:/UPWORK/01-CONTRACTS/energy/data/raw/bdgd/Copel-Dis_2866_2022-12-31_V11_20250424-0845.gdb',
))
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data'
PR = (-54.7, -26.8, -48.0, -22.4)  # w, s, e, n com folga

CAMADAS = [
    # (layer BDGD, saida, nome no PMTiles, {coluna BDGD: atributo}, zooms)
    ('UNTRMT', 'copel-transformadores.pmtiles', 'trafos',
     {'POT_NOM': 'kva', 'TIP_TRAFO': 'tipo', 'FAS_CON_P': 'fases', 'ARE_LOC': 'area'}, ['10', '12']),
    ('PONNOT', 'copel-postes.pmtiles', 'postes',
     {'TIP_PN': 'tipo', 'MAT': 'mat', 'ESTR': 'estr', 'ALT': 'alt', 'ESF': 'esf'}, ['13', '13']),
]


def valida(df, layer):
    if df.crs is None or df.crs.to_epsg() != 4674:
        raise SystemExit(f'{layer}: CRS inesperado {df.crs}')
    w, s, e, n = df.total_bounds
    if w < PR[0] or s < PR[1] or e > PR[2] or n > PR[3]:
        raise SystemExit(f'{layer}: pontos fora do PR {df.total_bounds}')
    vazios = df.geometry.is_empty | df.geometry.isna()
    if vazios.any():
        print(f'{layer}: {int(vazios.sum())} sem geometria, descartados')
    return df[~vazios]


def main() -> None:
    for layer, arquivo, nome, cols, (zmin, zmax) in CAMADAS:
        df = pyogrio.read_dataframe(GDB, layer=layer, columns=list(cols))
        df = valida(df, layer).rename(columns=cols)
        if 'kva' in df:
            df['kva'] = df['kva'].astype(float)
        for c in df.columns.drop('geometry'):
            if df[c].dtype == object:
                df[c] = df[c].fillna('').astype(str).str.strip()
        out = OUT / arquivo
        out.unlink(missing_ok=True)
        pyogrio.write_dataframe(
            df, out, driver='PMTiles', layer=nome,
            dataset_options={'MINZOOM': zmin, 'MAXZOOM': zmax, 'NAME': nome},
        )
        print(f'{layer}: {len(df)} pontos -> {out.name} {out.stat().st_size / 1e6:.1f} MB (zoom {zmin}-{zmax})')


if __name__ == '__main__':
    main()
