#!/usr/bin/env python3
"""Gera faxinais-pr.geojson (pontos) e faxinais-territorios-pr.geojson (polígonos).

Fontes oficiais do IAT no GeoPR (ArcGIS REST, download direto, sem login,
conferido em 2026-10-01):
  - Pontos: "Localização dos Faxinais NGEO - ZEE-PR" (zee_localiz_faxinais_2010_p),
    227 faxinais do levantamento de 2010 no estado.
  - Polígonos: "Limites Faxinais" (Hosted/Faxinais, camada 0), 30 perímetros de
    território inscritos no CAR com a situação na ARESUR, e "ARESUR Faxinais"
    (aresur_faxinais), 24 perímetros das Áreas Especiais de Uso Regulamentado
    (Decreto 3.446/1997). As duas bases se sobrepõem: o perímetro ARESUR que
    cobre um território já listado só empresta a resolução e a área dela; o que
    não casa com nenhum entra como polígono próprio.

Município normalizado pelo nome do IBGE (municipios-pr.geojson), sem acento e
com as grafias erradas da origem corrigidas. Saída no padrão de
build_limites_ambientais.py (UTF-8 compacto, 5 casas).

Uso: py -3 scripts/build_faxinais.py
"""

from __future__ import annotations

import json
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import shape

from build_limites_ambientais import OUT, UA, _num, _round_coords, _text, to_geometry, write_collection

BASE = 'https://geopr.iat.pr.gov.br/server/rest/services'
PONTOS = f'{BASE}/00_PUBLICACOES/zee_localiz_faxinais_2010_p/FeatureServer/0'
LIMITES = f'{BASE}/Hosted/Faxinais/FeatureServer/0'
ARESUR = f'{BASE}/00_PUBLICACOES/aresur_faxinais/FeatureServer/0'
GERADO_EM = '2026-10-01'

# Grafias da origem que não batem com o IBGE nem sem acento.
MUNICIPIO_ALIAS = {
    'prudetopolis': 'prudentopolis',
    'sao jose do triunfo': 'sao joao do triunfo',  # Faxinal dos Seixas (ARESUR 075/2010)
}

# Fração da área do menor polígono que precisa cair na interseção para o
# perímetro ARESUR ser considerado o mesmo faxinal do território do CAR.
SOBREPOSICAO_MIN = 0.5

# Tolerância (graus, ~5 km) para ponto sem município cair fora da divisa
# simplificada do IBGE.
DIVISA_MAX_GRAUS = 0.05


def fetch_geojson(layer_url: str) -> list[dict]:
    """Todas as feições da camada em SIRGAS 2000 (outSR=4674)."""
    qs = urllib.parse.urlencode({'where': '1=1', 'outFields': '*', 'outSR': 4674, 'f': 'geojson'})
    req = urllib.request.Request(f'{layer_url}/query?{qs}', headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    if 'features' not in payload:
        raise RuntimeError(f'{layer_url}: resposta sem features: {str(payload)[:200]}')
    if payload.get('properties', {}).get('exceededTransferLimit'):
        raise RuntimeError(f'{layer_url}: passou do limite de transferência, paginar')
    return payload['features']


def _chave(nome: str) -> str:
    s = unicodedata.normalize('NFD', nome.strip().lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return MUNICIPIO_ALIAS.get(s, s)


class Municipios:
    """Os 399 municípios do IBGE (municipios-pr.geojson): por nome e por posição."""

    def __init__(self):
        gj = json.loads((OUT / 'municipios-pr.geojson').read_text(encoding='utf-8'))
        self.feicoes = [((str(f['properties']['CD_MUN']), f['properties']['NM_MUN']), shape(f['geometry']))
                        for f in gj['features']]
        self.por_nome = {_chave(nm): (cod, nm) for (cod, nm), _ in self.feicoes}

    def em(self, geom) -> tuple[str, str] | None:
        ponto = geom.representative_point()
        dentro = next((m for m, g in self.feicoes if g.contains(ponto)), None)
        if dentro:
            return dentro
        # Ponto logo além da divisa (ex.: Taquaral dos Bugre, 1,5 km ao sul de
        # São Mateus do Sul): o município mais próximo, até ~5 km.
        dist, perto = min((g.distance(ponto), m) for m, g in self.feicoes)
        return perto if dist <= DIVISA_MAX_GRAUS else None

    def de(self, nome, geom) -> tuple[str, str]:
        """(código IBGE, nome oficial) pelo nome da origem; sem nome, pela posição."""
        texto = _text(nome)
        achado = self.por_nome.get(_chave(texto)) if texto else self.em(geom)
        if achado is None:
            raise ValueError(f'município sem correspondência no IBGE: {texto!r}')
        return achado


def _resolucao(v) -> str:
    s = _text(v)
    return '' if s in ('', '?') else s


def build_pontos(ibge: Municipios) -> None:
    features = []
    for f in fetch_geojson(PONTOS):
        p = f['properties']
        lon, lat = f['geometry']['coordinates'][:2]
        cod, nome_mun = ibge.de(p['municipio'], shape(f['geometry']))
        features.append({
            'type': 'Feature',
            'properties': {
                'nome': _text(p['nome']),
                'tipo': _text(p['tipo']),  # Faxinal, ARESUR ou vazio (pontos do NGEO)
                'situacao': _text(p['situacao']),
                'nro': _text(p['nro']),
                'municipio': nome_mun,
                'ibge': cod,
            },
            'geometry': {'type': 'Point', 'coordinates': _round_coords([lon, lat])},
        })
    write_collection('faxinais-pr.geojson', features, {
        'fonte': 'IAT/GeoPR · Localização dos Faxinais NGEO, ZEE-PR (2010)',
        'geradoEm': GERADO_EM,
    })


def _sobrepoe(a, b) -> bool:
    menor = min(a.area, b.area)
    return menor > 0 and a.intersection(b).area / menor >= SOBREPOSICAO_MIN


def build_territorios(ibge: Municipios) -> None:
    aresur = [(shape(f['geometry']).buffer(0), f['properties']) for f in fetch_geojson(ARESUR)]
    usados = set()
    features = []
    limites = fetch_geojson(LIMITES)
    # "Área Imóvel" com o recibo de uma "Área do Território" é o imóvel dentro
    # do mesmo território (Campestre dos Paulas, Mandirituba): vira só a área
    # do imóvel no território, não um segundo polígono do mesmo faxinal.
    territorio = {_text(f['properties']['recibo']) for f in limites
                  if _text(f['properties']['tipo']) == 'Área do Território'}
    imovel_ha = {_text(f['properties']['recibo']): _num(f['properties']['area']) for f in limites
                 if _text(f['properties']['tipo']) == 'Área Imóvel'}
    for f in limites:
        p = f['properties']
        if _text(p['tipo']) == 'Área Imóvel' and _text(p['recibo']) in territorio:
            continue
        geom = shape(f['geometry']).buffer(0)
        casado = next((i for i, (g, _) in enumerate(aresur) if i not in usados and _sobrepoe(geom, g)), None)
        ap = aresur[casado][1] if casado is not None else {}
        if casado is not None:
            usados.add(casado)
        geometry = to_geometry(geom, 0.00002)
        if geometry is None:
            continue
        cod, nome_mun = ibge.de(p['municipio'], geom)
        features.append({
            'type': 'Feature',
            'properties': {
                'nome': _text(p['fax_car']),
                'base': 'CAR',
                'perimetro': _text(p['tipo']),  # Área do Território / Área Imóvel
                'aresur': {'Sim': 'Sim', '?': 'Em análise'}.get(_text(p['aresur']), _text(p['aresur'])),
                'resolucao': _resolucao(p['res_sema']) or _resolucao(ap.get('res_sema')),
                'area_ha': _num(p['area']),
                'area_resolucao_ha': _num(ap.get('areas_resol')),
                'area_imovel_ha': imovel_ha.get(_text(p['recibo'])) if _text(p['tipo']) == 'Área do Território' else None,
                'obs': _text(p['obs__']),
                'recibo_car': _text(p['recibo']),
                'municipio': nome_mun,
                'ibge': cod,
            },
            'geometry': geometry,
        })
    for i, (geom, p) in enumerate(aresur):
        if i in usados:
            continue
        geometry = to_geometry(geom, 0.00002)
        if geometry is None:
            continue
        cod, nome_mun = ibge.de(p['município'], geom)
        features.append({
            'type': 'Feature',
            'properties': {
                'nome': _text(p['faxinais']),
                'base': 'ARESUR',
                'perimetro': 'Perímetro ARESUR',
                'aresur': 'Sim',
                'resolucao': _resolucao(p['res_sema']),
                'area_ha': _num(_text(p['area_ha']).replace(',', '.')),
                'area_resolucao_ha': _num(p['areas_resol']),
                'area_imovel_ha': None,
                'obs': '',
                'recibo_car': '',
                'municipio': nome_mun,
                'ibge': cod,
            },
            'geometry': geometry,
        })
    print(f'  ARESUR casados com território do CAR: {len(usados)}/{len(aresur)}')
    write_collection('faxinais-territorios-pr.geojson', features, {
        'fonte': 'IAT/GeoPR · Limites Faxinais e ARESUR Faxinais (Decreto 3.446/1997)',
        'geradoEm': GERADO_EM,
    })


if __name__ == '__main__':
    ibge = Municipios()
    build_pontos(ibge)
    build_territorios(ibge)
