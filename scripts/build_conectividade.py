#!/usr/bin/env python3
"""Gera os dados da camada de Conectividade (torres + cobertura).

Fonte: acervo do programa ParanaConectado / RenovaPR do IDR-Parana, em
H:\\IDR-PARANA\\renovaPR\\Conectividade (levantamento derivado do licenciamento
ANATEL). VINTAGE: janeiro/2024 — ver FONTE_DATA abaixo e o campo `geradoDe` na
saida; a ficha e o painel mostram essa data, porque um mapa de cobertura sem
data e pior que nenhum.

Saidas (public/data/):
  conectividade-torres.json      ~5.8 mil ERBs com operadora e tecnologias
  conectividade-sem-cobertura.geojson  area SEM cobertura 3G+ , simplificada

Uso:  py -3 scripts/build_conectividade.py
Rodar de novo quando sair levantamento novo (trocar SRC e FONTE_DATA).
"""

import json
from pathlib import Path

import geopandas as gpd

SRC = Path(r'H:\IDR-PARANA\renovaPR\Conectividade')
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data'
FONTE_DATA = '2024-01'
FONTE = 'IDR-Paraná / ParanáConectado — levantamento sobre licenciamento ANATEL'

# Bits de tecnologia, para caber num inteiro em vez de repetir strings 5,8 mil
# vezes no JSON que o browser baixa.
TEC_BITS = (('2G', 1), ('3G', 2), ('4G', 4), ('5G', 8))
# Tolerancia de simplificacao, em METROS (o shapefile esta em UTM 22S). A
# camada e lida em escala ESTADUAL e o levantamento de origem ja e aproximado,
# entao o vertice de cada curva nao carrega informacao — carrega bytes. A 200 m
# o GeoJSON saia com 7,3 MB, inviavel para o browser baixar; a 600 m a forma
# das manchas continua a mesma e o arquivo cabe. Precisao aparente maior que a
# do dado de origem seria desonesta, alem de cara.
SIMPLIFY_M = 600
# Fragmentos menores que isto (km2) somem no zoom estadual e so engordam o
# arquivo. Removidos DEPOIS da simplificacao, que e quando eles aparecem.
MIN_FRAGMENTO_KM2 = 0.5


def build_torres() -> dict:
    """torres_PR.csv -> JSON compacto. Decimal com virgula e ';' como separador."""
    path = SRC / 'torres_PR.csv'
    raw = path.read_text(encoding='utf-8-sig', errors='replace').splitlines()
    header = [h.strip() for h in raw[0].split(';')]
    idx = {name: header.index(name) for name in header}

    operadoras: list[str] = []
    torres = []
    descartadas = 0
    for line in raw[1:]:
        if not line.strip():
            continue
        parts = line.split(';')
        if len(parts) < len(header):
            descartadas += 1
            continue

        def field(name: str) -> str:
            return parts[idx[name]].strip().strip('"')

        try:
            lat = float(field('Latitude').replace(',', '.'))
            lon = float(field('Longitude').replace(',', '.'))
        except ValueError:
            descartadas += 1
            continue
        # Recorte do Parana com folga. Coordenada fora disso e erro de digitacao
        # na planilha de origem, e um ponto no oceano estraga o enquadramento.
        if not (-27.5 <= lat <= -22.0 and -55.5 <= lon <= -47.5):
            descartadas += 1
            continue

        operadora = field('Operadora') or '—'
        if operadora not in operadoras:
            operadoras.append(operadora)

        tecs = field('Tecs').upper()
        mask = 0
        for nome, bit in TEC_BITS:
            if nome in tecs:
                mask |= bit

        torres.append([
            round(lat, 5), round(lon, 5),
            operadoras.index(operadora), mask,
            field('IBGE'),
        ])

    print(f'  torres: {len(torres)} ({descartadas} descartadas), {len(operadoras)} operadoras')
    return {
        'geradoDe': FONTE_DATA,
        'fonte': FONTE,
        'operadoras': operadoras,
        # [lat, lon, indice da operadora, mascara de tecnologia, IBGE]
        'campos': ['lat', 'lon', 'operadora', 'tecs', 'ibge'],
        'tecBits': {nome: bit for nome, bit in TEC_BITS},
        'torres': torres,
    }


def build_sem_cobertura() -> dict:
    """area_descoberta_3goumais.shp -> GeoJSON WGS84 simplificado.

    O acervo guarda a AUSENCIA de cobertura, nao a presenca, e e essa a leitura
    que interessa a uma sala de situacao: onde o programa precisa chegar.
    """
    gdf = gpd.read_file(SRC / 'COBERTURA' / 'area_descoberta_3goumais.shp')
    print(f'  cobertura: {len(gdf)} feicoes, crs {gdf.crs}')
    area_bruta = gdf.area.sum() / 1e6
    # Simplifica ANTES de reprojetar, para a tolerancia estar em metros.
    gdf['geometry'] = gdf.geometry.simplify(SIMPLIFY_M, preserve_topology=True)

    # O arquivo e um multipoligono unico; explodir e descartar as lascas e o
    # que derruba o peso sem mexer nas manchas que importam.
    partes = gdf.explode(index_parts=False).reset_index(drop=True)
    antes = len(partes)
    partes = partes[partes.area / 1e6 >= MIN_FRAGMENTO_KM2]
    print(f'  fragmentos: {antes} -> {len(partes)} (corte em {MIN_FRAGMENTO_KM2} km2)')

    area_km2 = partes.area.sum() / 1e6
    perdido = area_bruta - area_km2
    print(f'  area sem cobertura 3G+: {area_km2:,.0f} km2 '
          f'(simplificacao mexeu em {perdido:+,.0f} km2, {perdido / area_bruta * 100:+.1f}%)')
    gdf = partes.to_crs('EPSG:4326')
    payload = json.loads(gdf.to_json())
    payload['geradoDe'] = FONTE_DATA
    payload['fonte'] = FONTE
    payload['areaKm2'] = round(area_km2, 1)
    return payload


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    print('1/2 torres (ERBs)...')
    torres = build_torres()
    destino = OUT / 'conectividade-torres.json'
    destino.write_text(
        json.dumps(torres, ensure_ascii=False, separators=(',', ':')), encoding='utf-8',
    )
    print(f'  OK {destino.name} ({destino.stat().st_size / 1024:.0f} KB)')

    print('2/2 area sem cobertura...')
    cobertura = build_sem_cobertura()
    destino = OUT / 'conectividade-sem-cobertura.geojson'
    destino.write_text(
        json.dumps(cobertura, ensure_ascii=False, separators=(',', ':')), encoding='utf-8',
    )
    print(f'  OK {destino.name} ({destino.stat().st_size / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
