#!/usr/bin/env python3
"""Fase 0 do "enrich" do DataGeo: um imóvel do CAR (ou um ponto) vira ~60 campos
estruturados, cada um com rótulo, unidade, fonte e referência.

Entrada: código do CAR (PR-...), ou lon/lat (acha o imóvel do CAR que contém o
ponto; sem imóvel, enriquece só o ponto). Saída no envelope da public-api do c2:
  {success, data: {imovel, campos: {id: valor}}, meta: {catalogo: {id: {...}}, avisos}}

Só dado PÚBLICO (nada do bucket privado): CAR do SFB sem nome nem CPF, IAT, IBGE,
INCRA, ANA/INPE, FUNAI, ICMBio, CONAB, ANEEL/EPE, BR-DWGD, SEAB/DERAL (SIPT).
Tudo lido de public/data/ (offline, determinístico); fontes ao vivo (outorgas,
licenças do IAT) ficam para a fase 1.

Limites (vão nos avisos de toda resposta):
  - CAR é declaratório; a divisa vem das fatias do mapa (simplificada a ~5 m e
    quantizada), serve para triagem, não para medir divisa nem instruir processo;
  - declividade (ZEE-PR) e uso do solo (IAT 2012-2016) lidos dos PNG de 30 m
    por município;
  - preço da terra = referência municipal do SIPT por classe, não avaliação.

Uso:
  py -3 scripts/enrich_imovel.py PR-4100103-...            # JSON no stdout
  py -3 scripts/enrich_imovel.py --ponto -50.33 -23.30
  py -3 scripts/enrich_imovel.py --servir 8787             # GET /v1/enrich?car=|lon=&lat=
  py -3 scripts/enrich_imovel.py --avaliar 200             # invariantes numa amostra + casos-ouro
"""

import argparse
import json
import math
import random
import sys
import unicodedata
from datetime import date
from functools import cached_property, reduce
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import Point, Polygon, shape
from shapely.ops import transform, unary_union
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parents[1]
PUB = ROOT / 'public' / 'data'
SIPT = ROOT.parent / 'precos-de-terras' / 'dashboard' / 'public' / 'data'
PARA_UTM = Transformer.from_crs('EPSG:4674', 'EPSG:31982', always_xy=True).transform  # SIRGAS 2000 / UTM 22S
AVISOS = [
    'CAR é declaratório e a divisa é a das fatias do mapa (simplificada a ~5 m): triagem, não medição.',
    'Declividade (ZEE-PR) e uso do solo (IAT 2012-2016) em pixels de 30 m.',
    'Preço da terra: referência municipal do SIPT/SEAB por classe de terra, não avaliação do imóvel.',
]
SIPT_CLASSES = {
    'A-I': 'lavoura, aptidão boa (I)', 'A-II': 'lavoura, aptidão boa (II)', 'A-III': 'lavoura, aptidão regular (III)',
    'A-IV': 'lavoura, aptidão restrita (IV)', 'B-V': 'pastagem plantada (V)', 'B-VI': 'pastagem plantada (VI)',
    'B-VII': 'silvicultura/pastagem natural (VII)', 'C-VIII': 'preservação da flora (VIII)',
}
DECL = {'0 a 10': '#016100', '10 a 20': '#a3c500', '20 a 45': '#ffba00', '>45': '#ff2200'}
USO = {
    'Agricultura Anual': '#89cd66', 'Agricultura Perene': '#cdcd66', 'Pastagem/Campo': '#70a800',
    'Floresta Nativa': '#267300', 'Plantios Florestais': '#38a800', 'Várzea': '#cd8966', 'Corpos d’Água': '#73dfff',
    'Mangue': '#cafce3', 'Restinga': '#b4d79e', 'Linha de Praia': '#ffd37f', 'Solo Exposto/Mineração': '#732600',
    'Área Construída': '#ff7f7f', 'Área Urbanizada': '#ff73df', 'Sem classificação': '#b2b2b2',
}
USO_CAMPOS = {  # id do campo -> classes do IAT somadas
    'uso_agricultura_anual_pct': ['Agricultura Anual'], 'uso_agricultura_perene_pct': ['Agricultura Perene'],
    'uso_pastagem_pct': ['Pastagem/Campo'], 'uso_floresta_nativa_pct': ['Floresta Nativa', 'Mangue', 'Restinga'],
    'uso_silvicultura_pct': ['Plantios Florestais'], 'uso_agua_varzea_pct': ['Corpos d’Água', 'Várzea'],
    'uso_outros_pct': ['Linha de Praia', 'Solo Exposto/Mineração', 'Área Construída', 'Área Urbanizada', 'Sem classificação'],
}
RESTRICOES = {  # id -> (arquivo, campo do nome, rótulo, fonte)
    'uc_federal': ('ucs-federais-pr', 'nome', 'Unidade de conservação federal', 'MMA/CNUC'),
    'uc_estadual': ('ucs-estaduais-pr', 'nome', 'Unidade de conservação estadual', 'MMA/CNUC'),
    'terra_indigena': ('terras-indigenas-pr', 'nome', 'Terra indígena', 'FUNAI/CMR'),
    'quilombola': ('quilombolas-pr', 'nome', 'Território quilombola', 'IBGE · Censo 2022'),
    'assentamento': ('assentamentos-incra-pr', 'nome', 'Assentamento da reforma agrária', 'INCRA/SIPRA'),
    'faxinal': ('faxinais-territorios-pr', 'nome', 'Território de faxinal', 'IAT/GeoPR · Limites Faxinais e ARESUR (Decreto 3.446/1997)'),
}
DISTANCIAS = {  # id -> (arquivo, rótulo, fonte, filtro)
    'dist_rodovia_federal_km': ('rodovias-federais-pr', 'Distância à rodovia federal', 'OSM · DNIT/DER-PR', None),
    'dist_rodovia_estadual_km': ('rodovias-estaduais-pr', 'Distância à rodovia estadual', 'OSM · DNIT/DER-PR', None),
    'dist_ferrovia_km': ('ferrovias-pr', 'Distância à ferrovia', 'OpenStreetMap', None),
    'dist_linha_transmissao_km': ('linhas-transmissao-pr', 'Distância à linha de transmissão em operação', 'EPE (operação)',
                                  lambda p: not p.get('planejada')),
}


def chave(s: str) -> str:
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().upper()
    return ' '.join(s.replace("'", ' ').replace('-', ' ').split())


def ler(nome: str):
    return json.loads((PUB / nome).read_text(encoding='utf-8'))


def rgb(hexcor: str) -> tuple[int, int, int]:
    return tuple(int(hexcor[i:i + 2], 16) for i in (1, 3, 5))


def merc_y(lat: float) -> float:
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def km(d_m: float) -> float:
    return round(d_m / 1000, 2)


# ------------------------------------------------------------------ CAR

class Car:
    """Imóveis ativos do CAR das fatias do mapa (build_car.py): delta encadeado por grupo."""

    def __init__(self):
        self.index = ler('car/index.json')
        self.d = self.index['cell_deg']
        self.escala = self.index['escala']
        self._celulas: dict[str, dict] = {}

    def celula(self, key: str) -> dict | None:
        if key not in self._celulas:
            arq = PUB / 'car' / f'{key}.json'
            self._celulas[key] = json.loads(arq.read_text(encoding='utf-8')) if arq.exists() else None
        return self._celulas[key]

    def aneis(self, key: str) -> dict[int, list]:
        """índice em `p` -> [anéis [(lon, lat), ...]] da célula."""
        cel = self.celula(key)
        if not cel:
            return {}
        i, j = map(int, key.split('_'))
        ox, oy = round(j * self.d * self.escala), round(i * self.d * self.escala)
        out: dict[int, list] = {}
        for g, linhas in enumerate(cel['t']):
            px, py = ox, oy
            for n, enc in enumerate(linhas):
                pts = []
                for k in range(0, len(enc) - 1, 2):
                    px += enc[k]
                    py += enc[k + 1]
                    pts.append((px / self.escala, py / self.escala))
                if len(pts) >= 3:
                    out.setdefault(cel['i'][g][n], []).append(pts)
        return out

    @cached_property
    def por_codigo(self) -> dict[str, list[str]]:
        """cod_imovel -> células onde ele tem anel (varre as ~330 células uma vez)."""
        idx: dict[str, list[str]] = {}
        for key in self.index['cells']:
            for linha in self.celula(key)['p']:
                idx.setdefault(linha[0], []).append(key)
            self._celulas.pop(key, None)  # não segura 70 MB na memória
        return idx

    def imovel(self, cod: str) -> dict | None:
        aneis, attrs = [], None
        for key in self.por_codigo.get(cod, []):
            cel = self.celula(key)
            for n, linha in enumerate(cel['p']):
                if linha[0] == cod:
                    attrs = linha
                    aneis += self.aneis(key).get(n, [])
        return self._monta(attrs, aneis) if attrs else None

    def no_ponto(self, lon: float, lat: float) -> dict | None:
        """Menor imóvel cujo polígono contém o ponto (célula do ponto e vizinhas)."""
        i, j = math.floor(lat / self.d), math.floor(lon / self.d)
        pt, achados = Point(lon, lat), []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                key = f'{i + di}_{j + dj}'
                cel = self.celula(key)
                if not cel:
                    continue
                for n, aneis in self.aneis(key).items():
                    geom = poligono(aneis)
                    if geom.contains(pt):
                        achados.append(cel['p'][n][0])
        imoveis = [self.imovel(c) for c in set(achados)]
        return min(imoveis, key=lambda m: m['geom'].area) if imoveis else None

    def _monta(self, linha: list, aneis: list) -> dict:
        cod, area, mf, tipo, cond, data = linha
        return {
            'cod': cod, 'area_ha': area, 'mf': mf, 'data': data, 'geom': poligono(aneis),
            'tipo': self.index['tipos'][tipo] if isinstance(tipo, int) else tipo,
            'condicao': self.index['condicoes'][cond] if isinstance(cond, int) else cond,
        }


def poligono(aneis: list):
    """Anéis soltos -> polígono par-ímpar (furo = anel dentro de outro)."""
    polys = [make_valid(Polygon(a)) for a in aneis if len(a) >= 3]
    return make_valid(reduce(lambda x, y: x.symmetric_difference(y), polys)) if polys else Polygon()


# ------------------------------------------------------------- camadas

class Camadas:
    """Camadas públicas em memória, projetadas para UTM 22S onde há distância/área."""

    @cached_property
    def municipios(self):
        g = ler('municipios-pr.geojson')['features']
        geoms = [shape(f['geometry']) for f in g]
        return geoms, [(f['properties']['CD_MUN'], f['properties']['NM_MUN']) for f in g], STRtree(geoms)

    def municipios_de(self, geom) -> list[tuple[str, str, float]]:
        """(ibge, nome, fração da área) dos municípios que o polígono toca, maior primeiro."""
        geoms, attrs, arvore = self.municipios
        out = []
        for k in arvore.query(geom, predicate='intersects'):
            a = geoms[k].intersection(geom).area
            if a > 0 or geom.area == 0:
                out.append((*attrs[k], a))
        tot = sum(a for *_, a in out) or 1
        return sorted(((ib, nm, a / tot) for ib, nm, a in out), key=lambda x: -x[2])

    def utm(self, nome: str, filtro=None):
        feats = [f for f in ler(f'{nome}.geojson')['features'] if not filtro or filtro(f['properties'])]
        geoms = [transform(PARA_UTM, make_valid(shape(f['geometry']))) for f in feats]
        return geoms, [f['properties'] for f in feats], STRtree(geoms)

    @cached_property
    def restricoes(self):
        return {k: self.utm(arq) for k, (arq, *_) in RESTRICOES.items()}

    @cached_property
    def linhas(self):
        return {k: self.utm(arq, filtro) for k, (arq, _, _, filtro) in DISTANCIAS.items()}

    @cached_property
    def armazens(self):
        return self.utm('armazens-conab-pr', lambda p: p.get('kind') == 'armazem_conab')

    @cached_property
    def ceasas(self):
        return self.utm('ceasas-pr')

    @cached_property
    def subestacoes(self):
        return self.utm('subestacoes-pr', lambda p: not p.get('planejada'))

    @cached_property
    def pivos(self):
        return self.utm('pivos-pr')

    @cached_property
    def sem_cobertura(self):
        return self.utm('conectividade-sem-cobertura')

    @cached_property
    def ottobacias(self):
        g = ler('ottobacias-idr-pr.geojson')['features']
        geoms = [shape(f['geometry']) for f in g]
        return geoms, [f['properties'] for f in g], STRtree(geoms)

    @cached_property
    def aspectos(self):
        return ler('aspectos-fisicos-pr.json')['municipios']

    @cached_property
    def clima(self):
        return ler('clima-historico-grade-pr.json')

    @cached_property
    def info(self):
        return ler('municipios-info.json')['municipios']

    @cached_property
    def modulos(self):
        return ler('modulos-fiscais-pr.json')['municipios']

    @cached_property
    def regional(self):
        """ibge -> (regional, mesorregião) do IDR, da malha do precos-de-terras."""
        out = {}
        terr =json.loads((SIPT / 'territorios.geojson').read_text(encoding='utf-8'))['features'] if SIPT.exists() else []
        for f in terr:
            p = f['properties']
            out[str(p['CodIbge'])] = (p.get('RegIdr'), p.get('MesoIdr'))
        return out

    @cached_property
    def sipt(self) -> dict[str, dict]:
        """chave(município) -> {subcategoria: (ano, R$/ha)} do último ano com preço."""
        if not SIPT.exists():
            return {}
        out: dict[str, dict] = {}
        for r in json.loads((SIPT / 'detailed.json').read_text(encoding='utf-8')):
            if r.get('nivel') != 'Municipio' or not r.get('preco'):
                continue
            m = out.setdefault(chave(r['territorio']), {})
            ano, _ = m.get(r['subcategoria'], (0, 0))
            if r['ano'] >= ano:
                m[r['subcategoria']] = (r['ano'], r['preco'])
        return out


def mais_proximo(camada, geom_utm):
    geoms, props, arvore = camada
    if not geoms:
        return None, None
    k = arvore.nearest(geom_utm)
    return props[k], geom_utm.distance(geoms[k])


def classes_png(png: Path, bbox: list[float], cores: dict[str, str], geom) -> dict[str, int]:
    """Pixels de cada classe do PNG (paleta, 30 m, mercator no bbox) dentro do polígono (lon/lat)."""
    if not png.exists() or geom.is_empty:
        return {}
    im = Image.open(png).convert('RGB')
    w, h = im.size
    o, s, l, n = bbox
    ytop, ybot = merc_y(n), merc_y(s)
    px = lambda lon, lat: ((lon - o) / (l - o) * w, (ytop - merc_y(lat)) / (ytop - ybot) * h)
    mask = Image.new('1', (w, h), 0)
    desenho = ImageDraw.Draw(mask)
    for poly in getattr(geom, 'geoms', [geom]):
        if poly.geom_type != 'Polygon' or poly.is_empty:
            continue
        desenho.polygon([px(*c) for c in poly.exterior.coords], fill=1)
        for furo in poly.interiors:
            desenho.polygon([px(*c) for c in furo.coords], fill=0)
    m = np.array(mask, dtype=bool)
    if not m.any():  # imóvel menor que um pixel: o pixel do centro
        cx, cy = px(*geom.representative_point().coords[0])
        if 0 <= int(cx) < w and 0 <= int(cy) < h:
            m[int(cy), int(cx)] = True
    pix = np.array(im)[m]
    out = {}
    for nome, cor in cores.items():
        k = int(np.all(pix == rgb(cor), axis=1).sum())
        if k:
            out[nome] = k
    return out


def clima_no_ponto(clima: dict, lon: float, lat: float) -> dict | None:
    """Nó da grade mais próximo com dado; na divisa o nó pode cair fora da máscara do PR (vazio): vale o vizinho."""
    b, w, h = clima['bounds'], clima['width'], clima['height']
    x = (lon - b['west']) / (b['east'] - b['west']) * (w - 1)
    y = (lat - b['south']) / (b['north'] - b['south']) * (h - 1)
    if not (-0.5 <= x < w - 0.5 and -0.5 <= y < h - 0.5):
        return None
    nos = sorted(((i - x) ** 2 + (j - y) ** 2, j * w + i)
                 for i in range(max(0, round(x) - 1), min(w, round(x) + 2))
                 for j in range(max(0, round(y) - 1), min(h, round(y) + 2)))
    pr = clima['campos']['pr']
    k = next((k for _, k in nos if pr[k] is not None), None)
    return {c: v[k] for c, v in clima['campos'].items()} if k is not None else None


# --------------------------------------------------------------- enrich

CATALOGO: dict[str, dict] = {}


def campo(id_: str, rotulo: str, fonte: str, unidade: str = '', referencia: str = '') -> str:
    CATALOGO.setdefault(id_, {'rotulo': rotulo, 'unidade': unidade, 'fonte': fonte, 'referencia': referencia})
    return id_


class Enrich:
    def __init__(self):
        self.car = Car()
        self.cam = Camadas()

    def por_codigo(self, cod: str) -> dict:
        im = self.car.imovel(cod)
        if not im:
            raise LookupError(f'imóvel {cod!r} não está entre os ativos do CAR')
        return self._enriquece(im, im['geom'])

    def por_ponto(self, lon: float, lat: float) -> dict:
        if not (-55 < lon < -48 and -27 < lat < -22):
            raise ValueError('ponto fora do Paraná')
        im = self.car.no_ponto(lon, lat)
        return self._enriquece(im, im['geom'] if im else Point(lon, lat))

    def _enriquece(self, im: dict | None, geom) -> dict:
        v: dict[str, object] = {}
        utm = transform(PARA_UTM, geom)
        centro = geom.representative_point()
        lon, lat = centro.x, centro.y
        muns = self.cam.municipios_de(geom)
        ibge, nome_mun, _ = muns[0] if muns else (None, None, 0)
        car = 'SICAR/SFB · CAR, imóveis ativos (WFS sicar_imoveis_pr)'

        if im:
            v[campo('car_codigo', 'Código do imóvel no CAR', car)] = im['cod']
            v[campo('area_declarada_ha', 'Área declarada', car, 'ha')] = im['area_ha']
            v[campo('area_geometria_ha', 'Área da geometria (UTM 22S)', 'cálculo DataGeo sobre o CAR', 'ha')] = round(utm.area / 1e4, 2)
            v[campo('modulos_fiscais', 'Módulos fiscais', car, 'MF')] = im['mf']
            v[campo('classe_modulos', 'Porte (Lei 8.629, art. 4)', car)] = porte(im['mf'])
            v[campo('car_tipo', 'Tipo de imóvel no CAR (IRU, AST, PCT)', car)] = im['tipo']
            v[campo('car_condicao', 'Condição no CAR', car)] = im['condicao']
            v[campo('car_inscricao', 'Data de inscrição no CAR', car)] = im['data']
        v[campo('lon', 'Longitude do ponto interno', 'cálculo DataGeo', '°')] = round(lon, 5)
        v[campo('lat', 'Latitude do ponto interno', 'cálculo DataGeo', '°')] = round(lat, 5)
        v[campo('municipio', 'Município (maior parte da área)', 'IBGE · malha municipal 2022')] = nome_mun
        v[campo('ibge', 'Código IBGE do município', 'IBGE · malha municipal 2022')] = ibge
        v[campo('n_municipios', 'Municípios que o imóvel toca', 'IBGE · malha municipal 2022')] = len(muns)
        reg = self.cam.regional.get(str(ibge), (None, None))
        v[campo('regional_idr', 'Regional do IDR-Paraná', 'IDR-Paraná · divisão regional')] = reg[0]
        v[campo('mesorregiao_idr', 'Mesorregião (IDR-Paraná)', 'IDR-Paraná · divisão regional')] = reg[1]
        mf = self.cam.modulos.get(str(ibge), {})
        v[campo('modulo_fiscal_municipio_ha', 'Tamanho do módulo fiscal no município',
                'INCRA · SNCR 2013 + IE 5/2022', 'ha')] = mf.get('mf')

        self._relevo_uso(v, geom, muns)
        self._restricoes(v, utm)
        self._logistica(v, utm)
        self._agua(v, geom, utm)
        self._clima(v, lon, lat)
        self._terra(v, nome_mun)
        self._municipio(v, ibge)
        return {'imovel': bool(im), 'campos': v}

    def _relevo_uso(self, v, geom, muns):
        decl, uso = {}, {}
        for ib, _, _ in muns:
            a = self.cam.aspectos.get(str(ib))
            if not a:
                continue
            for k, n in classes_png(PUB / 'declividade' / f'{ib}.png', a['declBbox'], DECL, geom).items():
                decl[k] = decl.get(k, 0) + n
            for k, n in classes_png(PUB / 'uso-solo' / f'{ib}.png', a['usoBbox'], USO, geom).items():
                uso[k] = uso.get(k, 0) + n
        fd, fu = 'IAT/GeoPR · ZEE-PR declividade (30 m)', 'IAT/GeoPR · Uso e Cobertura da Terra 2012-2016 (30 m)'
        td, tu = sum(decl.values()), sum(uso.values())
        for k, rot in [('0 a 10', '0_10'), ('10 a 20', '10_20'), ('20 a 45', '20_45'), ('>45', '45_mais')]:
            v[campo(f'decl_{rot}_pct', f'Área com declividade {k.replace(" a ", "-")} %', fd, '%')] = pct(decl.get(k, 0), td)
        v[campo('decl_predominante', 'Classe de declividade predominante', fd)] = max(decl, key=decl.get) if decl else None
        for id_, classes in USO_CAMPOS.items():
            v[campo(id_, 'Uso do solo: ' + ', '.join(classes).lower(), fu, '%')] = pct(sum(uso.get(c, 0) for c in classes), tu)
        v[campo('uso_predominante', 'Uso do solo predominante', fu)] = max(uso, key=uso.get) if uso else None
        v[campo('pixels_30m', 'Pixels de 30 m lidos (declividade/uso)', 'cálculo DataGeo')] = f'{td}/{tu}'

    def _restricoes(self, v, utm):
        area = utm.area
        for id_, (_, campo_nome, rotulo, fonte) in RESTRICOES.items():
            geoms, props, arvore = self.cam.restricoes[id_]
            ha, nomes = 0.0, []
            for k in arvore.query(utm, predicate='intersects'):
                inter = geoms[k].intersection(utm)
                if area == 0 or inter.area > 0:
                    ha += inter.area / 1e4
                    nomes.append(props[k].get(campo_nome))
            v[campo(f'{id_}_sobreposicao_pct', f'{rotulo}: % do imóvel sobreposto', fonte, '%')] = (
                pct(ha * 1e4, area) if area else (100.0 if nomes else 0.0))
            v[campo(f'{id_}_nome', f'{rotulo}: nome', fonte)] = '; '.join(sorted({n for n in nomes if n})) or None

    def _logistica(self, v, utm):
        for id_, (_, rotulo, fonte, _) in DISTANCIAS.items():
            _, d = mais_proximo(self.cam.linhas[id_], utm)
            v[campo(id_, rotulo, fonte, 'km')] = km(d) if d is not None else None
        p, d = mais_proximo(self.cam.armazens, utm)
        f = 'CONAB/CDA 2023 (armazéns cadastrados)'
        v[campo('armazem_proximo', 'Armazém mais próximo', f)] = p and f"{p.get('nome')} ({p.get('municipio')})"
        v[campo('armazem_proximo_km', 'Distância ao armazém mais próximo', f, 'km')] = km(d)
        v[campo('armazem_proximo_cap_t', 'Capacidade do armazém mais próximo', f, 't')] = p and p.get('cap_t')
        geoms, props, arvore = self.cam.armazens
        perto = arvore.query(utm.buffer(30_000), predicate='intersects')
        v[campo('armazens_30km_cap_t', 'Capacidade de armazenagem a até 30 km', f, 't')] = round(
            sum(props[k].get('cap_t') or 0 for k in perto))
        p, d = mais_proximo(self.cam.ceasas, utm)
        v[campo('ceasa_proxima', 'CEASA mais próxima', 'CEASA/PR')] = p and p.get('nome')
        v[campo('ceasa_proxima_km', 'Distância à CEASA mais próxima', 'CEASA/PR', 'km')] = km(d)
        p, d = mais_proximo(self.cam.subestacoes, utm)
        f = 'EPE (subestações em operação)'
        v[campo('subestacao_proxima', 'Subestação mais próxima', f)] = p and f"{p.get('nome')} ({p.get('tensao')} kV)"
        v[campo('subestacao_proxima_km', 'Distância à subestação mais próxima', f, 'km')] = km(d)
        geoms, props, arvore = self.cam.sem_cobertura
        sem = sum(geoms[k].intersection(utm).area for k in arvore.query(utm, predicate='intersects'))
        v[campo('sem_cobertura_celular_pct', 'Área sem cobertura de telefonia móvel', 'ANATEL · IDR-PR (áreas sem cobertura)',
                '%')] = pct(sem, utm.area) if utm.area else (100.0 if sem or arvore.query(utm, predicate='intersects').size else 0.0)

    def _agua(self, v, geom, utm):
        geoms, props, arvore = self.cam.ottobacias
        ks = arvore.query(geom.representative_point(), predicate='within')
        o = props[ks[0]] if len(ks) else {}
        f = 'IAT/GeoPR · ottobacias (rede ottocodificada 2020)'
        v[campo('ottobacia_codigo', 'Ottobacia (código Pfafstetter)', f)] = o.get('cod')
        v[campo('bacia_hidrografica', 'Bacia hidrográfica', f)] = o.get('bacia')
        v[campo('ottobacia_manancial', 'Ottobacia de manancial de abastecimento', f)] = o.get('man')
        g, p, arv = self.cam.pivos
        perto = arv.query(utm.buffer(5_000), predicate='intersects')
        f = 'ANA/INPE · pivôs centrais 2022'
        v[campo('pivos_5km', 'Pivôs centrais a até 5 km', f)] = len(perto)
        v[campo('pivos_5km_ha', 'Área irrigada por pivô a até 5 km', f, 'ha')] = round(sum(p[k].get('ha') or 0 for k in perto), 1)

    def _clima(self, v, lon, lat):
        c = clima_no_ponto(self.cam.clima, lon, lat) or {}
        f = 'BR-DWGD (Xavier et al., 2022), normal 1990-2019, grade 0,1°'
        for id_, chave_, rot, un in [
            ('chuva_anual_mm', 'pr', 'Chuva média anual', 'mm'), ('temp_media_c', 'tmed', 'Temperatura média anual', '°C'),
            ('eto_anual_mm', 'eto', 'Evapotranspiração de referência anual', 'mm'),
            ('balanco_hidrico_mm', 'balanco', 'Balanço hídrico anual (chuva - ETo)', 'mm'),
            ('meses_deficit', 'mesesDeficit', 'Meses com déficit hídrico', 'meses'),
            ('dias_geada_ano', 'geada3', 'Dias por ano com mínima abaixo de 3 °C', 'dias'),
            ('dias_calor35_ano', 'calor35', 'Dias por ano com máxima acima de 35 °C', 'dias'),
            ('dias_chuva50_ano', 'chuva50', 'Dias por ano com chuva acima de 50 mm', 'dias'),
        ]:
            val = c.get(chave_)
            v[campo(id_, rot, f, un)] = round(val, 1) if isinstance(val, (int, float)) else None

    def _terra(self, v, nome_mun):
        precos = self.cam.sipt.get(chave(nome_mun or ''), {})
        f = 'SEAB/DERAL · SIPT (preços de terras rurais)'
        for sub, rot in SIPT_CLASSES.items():
            ano, preco = precos.get(sub, (None, None))
            v[campo(f'preco_terra_{sub.lower().replace("-", "_")}_rs_ha', f'Preço da terra no município: {rot}', f, 'R$/ha',
                    'último ano publicado')] = preco
        v[campo('preco_terra_ano', 'Ano do preço da terra (SIPT)', f)] = max((a for a, _ in precos.values()), default=None)

    def _municipio(self, v, ibge):
        m = self.cam.info.get(str(ibge), {})
        f = 'SEAB/DERAL · VBP; IBGE · população'
        v[campo('municipio_populacao', 'População do município', 'IBGE · estimativa', 'hab')] = (m.get('pop') or {}).get('valor')
        v[campo('municipio_vbp_rs', 'Valor Bruto da Produção agropecuária do município', f, 'R$',
                str((m.get('vbp') or {}).get('anoB') or ''))] = (m.get('vbp') or {}).get('valB')
        v[campo('municipio_vbp_rs_ha', 'VBP por hectare do município', f, 'R$/ha')] = (m.get('vbpHa') or {}).get('valB')
        v[campo('municipio_cadeia_lider', 'Cadeia produtiva líder no município', f)] = m.get('cadeia')


def porte(mf) -> str | None:
    if mf is None:
        return None
    return ('pequena (até 4 MF)' if mf <= 4 else 'média (4 a 15 MF)' if mf <= 15 else 'grande (acima de 15 MF)')


def pct(parte: float, total: float) -> float | None:
    return round(100 * parte / total, 1) if total else None


def resposta(fn) -> dict:
    try:
        data = fn()
        return {'success': True, 'data': data, 'error': None,
                'meta': {'gerado_em': date.today().isoformat(), 'avisos': AVISOS,
                         'catalogo': {k: CATALOGO[k] for k in data['campos']}}}
    except (LookupError, ValueError) as e:
        return {'success': False, 'data': None, 'error': str(e)}


# ------------------------------------------------------------ avaliação

def _demo() -> None:
    assert chave("Diamante D'Oeste") == 'DIAMANTE D OESTE' and chave('São José') == 'SAO JOSE'
    assert porte(4) == 'pequena (até 4 MF)' and porte(4.01).startswith('média') and porte(16).startswith('grande')
    assert pct(1, 4) == 25.0 and pct(1, 0) is None
    q = poligono([[(0, 0), (4, 0), (4, 4), (0, 4)], [(1, 1), (2, 1), (2, 2), (1, 2)]])
    assert abs(q.area - 15) < 1e-9, 'anel interno vira furo'
    clima = {'bounds': {'west': 0, 'east': 2, 'south': 0, 'north': 1}, 'width': 3, 'height': 2,
             'campos': {'pr': [1, 2, 3, 4, 5, 6]}}
    assert clima_no_ponto(clima, 2, 1)['pr'] == 6 and clima_no_ponto(clima, 0, 0)['pr'] == 1, 'linha 0 = sul'
    assert clima_no_ponto(clima, 5, 5) is None


def avaliar(n: int, semente: int = 7) -> int:
    """Invariantes numa amostra de imóveis + casos-ouro conferidos à mão. Devolve o nº de falhas."""
    e = Enrich()
    falhas = []
    cods = sorted(e.car.por_codigo)
    random.Random(semente).shuffle(cods)
    razoes = []
    for cod in cods[:n]:
        r = e.por_codigo(cod)['campos']
        dec = [r[k] for k in r if k.startswith('decl_') and k.endswith('_pct') and r[k] is not None]
        uso = [r[k] for k in USO_CAMPOS if r[k] is not None]
        if dec and abs(sum(dec) - 100) > 0.5:
            falhas.append((cod, 'declividade não soma 100', sum(dec)))
        if uso and abs(sum(uso) - 100) > 0.5:
            falhas.append((cod, 'uso não soma 100', sum(uso)))
        if r['area_declarada_ha']:
            razoes.append(r['area_geometria_ha'] / r['area_declarada_ha'])
        for k in r:
            if k.endswith('_km') and r[k] is not None and not 0 <= r[k] < 400:
                falhas.append((cod, k, r[k]))
            if k.endswith('_pct') and r[k] is not None and not -0.01 <= r[k] <= 100.01:
                falhas.append((cod, k, r[k]))
        if r['municipio'] is None or r['chuva_anual_mm'] is None:
            falhas.append((cod, 'sem município ou clima', r['municipio']))
        # ponto interno volta para o mesmo imóvel (ou um menor sobreposto: o CAR tem sobreposições)
        via_ponto = e.por_ponto(r['lon'], r['lat'])['campos']
        if not via_ponto.get('car_codigo'):
            falhas.append((cod, 'ponto interno sem imóvel', (r['lon'], r['lat'])))
    razoes.sort()
    med = razoes[len(razoes) // 2] if razoes else None
    perto = sum(0.9 <= x <= 1.1 for x in razoes) / len(razoes) if razoes else 0
    print(f'amostra {n}: área da geometria / declarada, mediana {med:.3f}, {perto:.0%} entre 0,9 e 1,1')
    if med is None or not 0.95 <= med <= 1.05 or perto < 0.8:
        falhas.append(('amostra', 'área da geometria não confere com a declarada', med))

    # Casos-ouro: um ponto dentro da REBIO das Perobas (Tuneiras do Oeste/Cianorte) e um em Curitiba.
    perobas = e.por_ponto(-52.763, -23.882)['campos']
    if not perobas['uc_federal_sobreposicao_pct'] or 'PEROBAS' not in (perobas['uc_federal_nome'] or ''):
        falhas.append(('ouro', 'REBIO das Perobas não detectada', perobas['uc_federal_nome']))
    cwb = e.por_ponto(-49.27, -25.43)['campos']
    if cwb['municipio'] != 'Curitiba' or 'Curitiba' not in (cwb['ceasa_proxima'] or ''):
        falhas.append(('ouro', 'Curitiba: município ou CEASA errados', (cwb['municipio'], cwb['ceasa_proxima'])))
    print(f'campos por resposta: {len(CATALOGO)}')
    for f in falhas[:20]:
        print('FALHA', f)
    print('avaliação:', 'OK' if not falhas else f'{len(falhas)} falhas')
    return len(falhas)


# ---------------------------------------------------------------- serviço

def servir(porta: int) -> None:
    e = Enrich()
    e.car.por_codigo  # aquece o índice antes da primeira chamada

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            st = None
            if u.path == '/v1/fields':
                corpo = {'success': True, 'data': CATALOGO, 'error': None}
            elif u.path != '/v1/enrich':
                corpo, st = {'success': False, 'data': None, 'error': 'use /v1/enrich ou /v1/fields'}, 404
            elif 'car' in q:
                corpo = resposta(lambda: e.por_codigo(q['car']))
            else:
                try:
                    lon, lat = float(q['lon']), float(q['lat'])
                    corpo = resposta(lambda: e.por_ponto(lon, lat))
                except (KeyError, ValueError):
                    corpo = {'success': False, 'data': None, 'error': 'informe car=PR-... ou lon= e lat='}
            st = st or (200 if corpo['success'] else 400)
            b = json.dumps(corpo, ensure_ascii=False).encode('utf-8')
            self.send_response(st)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)

    print(f'http://localhost:{porta}/v1/enrich?car=PR-...  |  ?lon=-51.5&lat=-24.5  |  /v1/fields')
    ThreadingHTTPServer(('127.0.0.1', porta), H).serve_forever()


def main() -> None:
    _demo()
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('car', nargs='?')
    ap.add_argument('--ponto', nargs=2, type=float, metavar=('LON', 'LAT'))
    ap.add_argument('--servir', type=int, metavar='PORTA')
    ap.add_argument('--avaliar', type=int, metavar='N')
    a = ap.parse_args()
    if a.servir:
        return servir(a.servir)
    if a.avaliar:
        sys.exit(1 if avaliar(a.avaliar) else 0)
    e = Enrich()
    r = resposta(lambda: e.por_codigo(a.car)) if a.car else resposta(lambda: e.por_ponto(*a.ponto)) if a.ponto else None
    if not r:
        ap.error('informe um código do CAR, --ponto, --servir ou --avaliar')
    sys.stdout.buffer.write(json.dumps(r, ensure_ascii=False, indent=1).encode('utf-8'))


if __name__ == '__main__':
    main()
