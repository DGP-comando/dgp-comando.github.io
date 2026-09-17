#!/usr/bin/env python3
"""Gera as duas saidas do CAR (imoveis ATIVOS) a partir do acervo de fetch_car.py.

  1. public/data/car/ — divisas dos imoveis fatiadas numa grade de 0,25 grau
     que o front carrega por zoom (mesmo formato da rede de distribuicao e das
     estradas, ver slice_grid.py). Cada ANEL do poligono vira uma linha; os
     grupos sao as CLASSES DE MODULOS FISCAIS, para a cor no mapa e a
     distribuicao na ficha municipal contarem a mesma historia.

  2. public/data/car-municipios.json — contagem e area por classe de modulos
     fiscais, por municipio, mais o total do estado. E o que a ficha municipal
     desenha; sai dos ATRIBUTOS (`area`, `m_fiscal`), nao da geometria
     simplificada, entao os numeros sao os declarados no CAR.

Classes de modulos fiscais, com limite superior INCLUSIVO — a convencao legal
brasileira ("ate 4 modulos" = pequena propriedade, Lei 8.629 art. 4):
    0-4, 4-10, 10-20, 20-50, >50

GENERALIZACAO: as divisas saem simplificadas a SIMPLIFY_M em EPSG:31982 e
quantizadas em passos de ~5 m. A camada serve para VER onde estao os imoveis e
de que porte; NAO serve para medir divisa nem para instruir processo. O CAR e
declaratorio: o que esta ali e o que o proprietario declarou, nao cadastro
fundiario validado.

LGPD: entram apenas geometria, area, modulos fiscais e municipio. O CAR publico
nao expoe CPF nem nome do proprietario, e `cod_imovel` NAO e copiado para a
saida do mapa — so a contagem agregada e a divisa generalizada.

Uso:
  py -3 scripts/build_car.py --car /caminho/car-pr
"""

import argparse
import json
import time
from pathlib import Path

import geopandas as gpd

from slice_grid import cell_key, quantize, write_grid

RAIZ = Path(__file__).resolve().parent.parent
OUT_GRADE = RAIZ / 'public' / 'data' / 'car'
OUT_FICHA = RAIZ / 'public' / 'data' / 'car-municipios.json'

CELL_DEG = 0.25
ESCALA = 20_000   # graus * 2e4 ~ 5 m: a divisa ja vem generalizada, 1 m seria ruido
SIMPLIFY_M = 30.0
MIN_AREA_M2 = 2_000.0  # aneis menores que isso somem na tela; nao valem bytes

# (rotulo, limite superior inclusivo em modulos fiscais; None = sem teto)
CLASSES = [
    ('0-4', 4.0),
    ('4-10', 10.0),
    ('10-20', 20.0),
    ('20-50', 50.0),
    ('>50', None),
]
ROTULOS = [rotulo for rotulo, _ in CLASSES]
FONTE = 'SICAR/SFB · CAR, imóveis ativos (WFS sicar_imoveis_pr)'


def classe_de(m_fiscal: float) -> int:
    """Indice da classe de modulos fiscais, limite superior inclusivo."""
    for i, (_, teto) in enumerate(CLASSES):
        if teto is None or m_fiscal <= teto:
            return i
    return len(CLASSES) - 1


def aneis_quantizados(geom):
    """Aneis (externo + ilhas) de um poligono/multipoligono, ja quantizados."""
    if geom is None or geom.is_empty:
        return
    partes = geom.geoms if geom.geom_type.startswith('Multi') else [geom]
    for poly in partes:
        if poly.geom_type != 'Polygon':
            continue
        for anel in [poly.exterior, *poly.interiors]:
            pts = quantize(list(anel.coords), ESCALA)
            if pts:
                yield pts


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--car', default='car-pr', help='diretorio dos GeoJSON de fetch_car.py')
    args = ap.parse_args()

    origem = Path(args.car)
    arquivos = sorted(origem.glob('*.geojson'))
    if not arquivos:
        raise SystemExit(f'nenhum GeoJSON em {origem} — rode scripts/fetch_car.py antes')
    print(f'{len(arquivos)} municipios em {origem}')

    # cells[key][k] = aneis quantizados da classe CLASSES[k]
    cells: dict[str, list[list]] = {}
    # ficha[ibge] = {'n': [...], 'ha': [...]}
    ficha: dict[str, dict[str, list]] = {}
    imoveis = 0
    sem_geometria = 0
    t0 = time.time()

    for n, caminho in enumerate(arquivos, 1):
        ibge = caminho.stem
        g = gpd.read_file(caminho)
        contagem = [0] * len(CLASSES)
        area_ha = [0.0] * len(CLASSES)
        if not g.empty:
            # Agregacao da ficha: atributos declarados, geometria original.
            for m_fiscal, area in zip(g['m_fiscal'].values, g['area'].values):
                k = classe_de(float(m_fiscal))
                contagem[k] += 1
                area_ha[k] += float(area)
            imoveis += len(g)

            # Grade do mapa: simplificada e quantizada.
            metrico = g.to_crs(31982)
            grandes = metrico.geometry.area >= MIN_AREA_M2
            geoms = metrico.geometry[grandes].simplify(SIMPLIFY_M).to_crs(4674)
            classes = [classe_de(float(m)) for m in g['m_fiscal'].values[grandes.values]]
            for geom, k in zip(geoms.values, classes):
                if geom is None or geom.is_empty:
                    sem_geometria += 1
                    continue
                for pts in aneis_quantizados(geom):
                    lon = pts[len(pts) // 2][0] / ESCALA
                    lat = pts[len(pts) // 2][1] / ESCALA
                    key = cell_key(lat, lon, CELL_DEG)
                    cells.setdefault(key, [[] for _ in CLASSES])[k].append(pts)

        ficha[ibge] = {'n': contagem, 'ha': [round(v, 1) for v in area_ha]}
        if n % 50 == 0 or n == len(arquivos):
            print(f'  [{n}/{len(arquivos)}] {imoveis} imoveis, '
                  f'{len(cells)} celulas, {(time.time() - t0) / 60:.1f} min', flush=True)

    index = write_grid(OUT_GRADE, cells, 'classes', ROTULOS, FONTE, CELL_DEG, ESCALA)

    estado = {
        'n': [sum(ficha[i]['n'][k] for i in ficha) for k in range(len(CLASSES))],
        'ha': [round(sum(ficha[i]['ha'][k] for i in ficha), 1) for k in range(len(CLASSES))],
    }
    OUT_FICHA.write_text(json.dumps({
        'geradoEm': time.strftime('%Y-%m-%d'),
        'fonte': FONTE,
        'status': 'AT',
        'classes': ROTULOS,
        'limites': [teto for _, teto in CLASSES],
        'estado': estado,
        'municipios': ficha,
    }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

    print(f'\n{imoveis} imoveis ativos, {sem_geometria} sem geometria apos simplificar')
    print(f'{OUT_FICHA.name}: {OUT_FICHA.stat().st_size / 1e3:.0f} KB')
    print('estado por classe:', dict(zip(ROTULOS, estado['n'])))
    assert sum(estado['n']) == imoveis
    assert index['trechos'] > 0


if __name__ == '__main__':
    main()
