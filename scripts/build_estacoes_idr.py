#!/usr/bin/env python3
"""Gera data/privado/estacoes-idr-pr.geojson: estações, polos e unidades
florestais de pesquisa do IDR-Paraná.

- Estações: polígonos dos KML de H:/IDR-PARANA/02-PESQUISA/MAPAS ESTAÇÕES IDR/
  KML ESTAÇÕES/KML (um arquivo por área; áreas com a mesma coordenação levam
  a mesma chave `unidade`).
- Unidades florestais: os 13 núcleos das fazendas florestais (camada
  "Núcleos 2024" do GT Fazendas Florestais). Cada núcleo vai para a unidade
  florestal do município onde tem mais área; sem unidade florestal nesse
  município (núcleo 8, Campo Largo), `unidade` fica vazia. Contratante fora
  (há pessoa física); ficam uso, contrato e área.
- Polos de pesquisa: sem polígono; ponto na sede do município
  (representative_point do limite IBGE), `aproximado`.

A chave `unidade` é a mesma que a Edge Function datageo-servidores (c2-parana)
grava em cada servidor: o tooltip da camada lista os servidores por ela.

Uso:  py -3 scripts/build_estacoes_idr.py  &&  py -3 scripts/upload_privado.py
Requer: geopandas.
"""

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
KML_DIR = Path('H:/IDR-PARANA/02-PESQUISA/MAPAS ESTAÇÕES IDR/KML ESTAÇÕES/KML')
NUCLEOS = Path('H:/IDR-PARANA/CULTIVOS FLORESTAIS/01-GT FAZENDAS FLORESTAIS/00-Planejamento/00-Geo/2024/Núcleos.gpkg')
NUCLEOS_CAMADA = 'Núcleos 2024'
# município com mais área do núcleo -> unidade florestal do SisPont
UF_DO_MUNICIPIO = {
    'Castro': ('uf-castro', 'Unidade Florestal de Castro'),
    'Cerro Azul': ('uf-cerro-azul', 'Unidade Florestal de Cerro Azul'),
    'Doutor Ulysses': ('uf-doutor-ulysses', 'Unidade Florestal Doutor Ulysses'),
    'Ponta Grossa': ('uf-ponta-grossa', 'Unidade Florestal de Ponta Grossa'),
}
MUNICIPIOS = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT = ROOT / 'data' / 'privado' / 'estacoes-idr-pr.geojson'

# arquivo KML -> (unidade, nome da estação, município da área)
ESTACOES = {
    'Cambará.kml': ('cambara-joaquim-tavora', 'Estação de Pesquisa Cambará/Joaquim Távora', 'Cambará'),
    'Joaquim Távora.kml': ('cambara-joaquim-tavora', 'Estação de Pesquisa Cambará/Joaquim Távora', 'Joaquim Távora'),
    'Cerro Azul.kml': ('cerro-azul', 'Estação de Pesquisa Cerro Azul', 'Cerro Azul'),
    'Fazenda Modelo.kml': ('fazenda-modelo', 'Estação de Pesquisa Fazenda Modelo', 'Ponta Grossa'),
    'Guarapuava.kml': ('guarapuava', 'Estação de Pesquisa Guarapuava', 'Guarapuava'),
    'Ibiporã.kml': ('londrina-ibipora', 'Estação de Pesquisa Londrina/Ibiporã', 'Ibiporã'),
    'Londrina.kml': ('londrina-ibipora', 'Estação de Pesquisa Londrina/Ibiporã', 'Londrina'),
    'Irati.kml': ('irati', 'Estação de Pesquisa Irati', 'Irati'),
    'Lapa.kml': ('lapa', 'Estação de Pesquisa Lapa', 'Lapa'),
    'Morretes.kml': ('morretes', 'Unidade de Pesquisa Morretes', 'Morretes'),
    'Palmas.kml': ('pato-branco-palmas', 'Estação de Pesquisa Pato Branco/Palmas', 'Palmas'),
    'PatoBranco.kml': ('pato-branco-palmas', 'Estação de Pesquisa Pato Branco/Palmas', 'Pato Branco'),
    'Palotina.kml': ('palotina', 'Estação de Pesquisa Palotina', 'Palotina'),
    'Paranavaí.kml': ('paranavai', 'Estação de Pesquisa Paranavaí', 'Paranavaí'),
    'Pinhais (CPRA).kml': ('pinhais', 'Estação de Pesquisa Pinhais (CPRA)', 'Pinhais'),
    'Ponta Grossa.kml': ('ponta-grossa', 'Estação de Pesquisa Ponta Grossa', 'Ponta Grossa'),
    'Santa Helena.kml': ('santa-helena', 'Estação de Pesquisa Santa Helena', 'Santa Helena'),
    'Santa Tereza do Oeste.kml': ('santa-tereza-do-oeste', 'Estação de Pesquisa Santa Tereza do Oeste', 'Santa Tereza do Oeste'),
    'Umuarama.kml': ('umuarama-xambre', 'Estação de Pesquisa Umuarama/Xambrê', 'Umuarama'),
    'Xambrê.kml': ('umuarama-xambre', 'Estação de Pesquisa Umuarama/Xambrê', 'Xambrê'),
}

# unidade -> (nome, tipo, município sede)
PONTOS = {
    'polo-curitiba': ('Polo de Pesquisa Curitiba', 'polo', 'Curitiba'),
    'polo-londrina': ('Polo de Pesquisa Londrina', 'polo', 'Londrina'),
    'polo-ponta-grossa': ('Polo de Pesquisa Ponta Grossa', 'polo', 'Ponta Grossa'),
    'polo-paranavai': ('Polo de Pesquisa Paranavaí', 'polo', 'Paranavaí'),
    'polo-santa-tereza-do-oeste': ('Polo de Pesquisa Santa Tereza do Oeste', 'polo', 'Santa Tereza do Oeste'),
    'polo-pato-branco': ('Polo de Pesquisa Pato Branco', 'polo', 'Pato Branco'),
    'polo-guarapuava': ('Polo de Pesquisa Guarapuava', 'polo', 'Guarapuava'),
    'polo-irati': ('Polo de Pesquisa Irati', 'polo', 'Irati'),
}


def estacoes() -> gpd.GeoDataFrame:
    arquivos = {p.name: p for p in KML_DIR.glob('*.kml')}
    faltando = set(ESTACOES) - set(arquivos)
    sobrando = set(arquivos) - set(ESTACOES)
    if faltando or sobrando:
        raise SystemExit(f'KML fora do mapeamento. faltando={sorted(faltando)} novos={sorted(sobrando)}')
    partes = []
    for nome_arq, (unidade, nome, municipio) in ESTACOES.items():
        g = gpd.read_file(arquivos[nome_arq]).to_crs(4326)
        geom = g.geometry.make_valid().union_all()
        if geom.is_empty:
            raise SystemExit(f'{nome_arq}: geometria vazia')
        partes.append({'unidade': unidade, 'nome': nome, 'tipo': 'estacao', 'municipio': municipio,
                       'aproximado': False, 'geometry': geom})
    return gpd.GeoDataFrame(partes, crs=4326)


def nucleos(mun: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    g = gpd.read_file(NUCLEOS, layer=NUCLEOS_CAMADA).to_crs(31982)
    if len(g) != 13 or not g.geometry.is_valid.all():
        raise SystemExit(f'{NUCLEOS.name}: esperado 13 núcleos válidos, veio {len(g)}')
    linhas = []
    for _, r in g.sort_values('Núcleo').iterrows():
        area = mun.geometry.intersection(r.geometry).area
        municipio = mun['NM_MUN'].iloc[int(area.values.argmax())]
        unidade, nome_uf = UF_DO_MUNICIPIO.get(municipio, ('', ''))
        texto = lambda v: '' if pd.isna(v) else str(v).strip()  # noqa: E731
        linhas.append({
            'unidade': unidade,
            'nome': f'Fazenda florestal · Núcleo {int(r["Núcleo"])}',
            'tipo': 'unidade-florestal',
            'municipio': municipio,
            'aproximado': False,
            'unidade_nome': nome_uf,
            'uso': texto(r['Tipo']),
            'contrato': texto(r['Contrato']),
            'area_ha': round(float(r.geometry.area) / 1e4),
            'geometry': r.geometry.simplify(10),  # 10 m: basta para o mapa, derruba o arquivo
        })
    return gpd.GeoDataFrame(linhas, crs=31982).to_crs(4326)


def pontos(mun: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    sede = dict(zip(mun['NM_MUN'], mun.geometry.representative_point().to_crs(4326)))
    linhas = []
    for unidade, (nome, tipo, municipio) in PONTOS.items():
        if municipio not in sede:
            raise SystemExit(f'{unidade}: município {municipio!r} não está em {MUNICIPIOS.name}')
        linhas.append({'unidade': unidade, 'nome': nome, 'tipo': tipo, 'municipio': municipio,
                       'aproximado': True, 'geometry': sede[municipio]})
    return gpd.GeoDataFrame(linhas, crs=4326)


def main():
    mun = gpd.read_file(MUNICIPIOS).to_crs(31982)  # áreas e representative_point em métrico
    partes = [estacoes(), nucleos(mun), pontos(mun)]
    gdf = gpd.GeoDataFrame(pd.concat(partes, ignore_index=True), crs=4326)
    gdf['geometry'] = gdf.geometry.force_2d().set_precision(1e-6)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(json.loads(gdf.to_json(drop_id=True)), ensure_ascii=False), encoding='utf-8')
    por_tipo = gdf['tipo'].value_counts().to_dict()
    print(f'{OUT.relative_to(ROOT)}: {len(gdf)} feições {por_tipo}, {OUT.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
