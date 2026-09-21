#!/usr/bin/env python3
"""Gera public/data/radios-pr.json: rádios ao vivo do PR agrupadas por município.

Fonte: Radio Browser (radio-browser.info), diretório comunitário de domínio
público com endpoints e checagem diária de disponibilidade. O radio.garden tem
um acervo parecido, mas a API dele é privada; aqui só entra o que é aberto.

O modelo de dados copia o do radio.garden: o ponto no mapa é o LUGAR (o
município), e o lugar tem uma lista de estações. Coordenada própria da
estação não vai para a saída: quem desenha o ponto usa o centroide do
município (prCentroids.js), então o JSON leva só o código IBGE.

Regras de seleção, na ordem:
  1. lastcheckok == 1 e url_resolved em HTTPS. O Pages serve em HTTPS e o
     navegador bloqueia áudio HTTP numa página HTTPS (mixed content).
  2. Estado declarado cita o Paraná (Paraná, Parana, PR, "Londrina, Paraná"),
     OU estado vazio com geo_lat/long dentro do PR. Estado que cita OUTRA UF
     sai, mesmo com geo no PR: o geo do Radio Browser é um clique no mapa de
     quem cadastrou e erra mais que o campo estado.
  3. Município: o nome de município mais longo que aparece como palavra
     inteira no nome, no campo estado ou nas tags (ou um apelido de APELIDOS);
     senão, o polígono municipal que contém o geo. O nome vem antes do geo
     pelo mesmo motivo da regra 2: "Alpha FM Curitiba" com o clique caído em
     São José dos Pinhais é de Curitiba. Sem município, a estação sai (e é
     listada no log): um ponto no centro do estado seria inventar lugar.
  4. Dedup por url_resolved.

Uso:
  py -3 scripts/build_radios.py
"""

import json
import re
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parent.parent
GEOJSON = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT = ROOT / 'public' / 'data' / 'radios-pr.json'
API = 'https://de1.api.radio-browser.info/json/stations/search?countrycode=BR&limit=100000'
UA = 'datageo-command/1.0 (build script; github.com/DGP-comando)'
# Apelidos de cidade que aparecem em nome de rádio. Só entra o inequívoco.
APELIDOS = {'capital do papel': '4127106'}  # Telêmaco Borba
OTHER_UFS = (
    'acre', 'alagoas', 'amapa', 'amazonas', 'bahia', 'ceara', 'distrito federal',
    'espirito santo', 'goias', 'maranhao', 'mato grosso', 'minas gerais', 'para',
    'paraiba', 'pernambuco', 'piaui', 'rio de janeiro', 'rio grande', 'rondonia',
    'roraima', 'santa catarina', 'sao paulo', 'sergipe', 'tocantins',
    'ac', 'al', 'ap', 'am', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mt', 'ms', 'mg',
    'pa', 'pb', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc', 'sp', 'se', 'to',
)


def norm(text: str) -> str:
    ascii_ = unicodedata.normalize('NFKD', text or '').encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', ' ', ascii_.lower()).strip()


def has_word(haystack: str, needle: str) -> bool:
    return f' {needle} ' in f' {haystack} '


def uf_of(state: str) -> str:
    """'pr' quando o estado cita o Paraná, 'outra' quando cita outra UF, '' se vazio."""
    s = norm(state)
    if not s:
        return ''
    if has_word(s, 'parana') or has_word(s, 'pr'):
        return 'pr'
    return 'outra' if any(has_word(s, uf) for uf in OTHER_UFS) else ''


def load_municipios():
    fc = json.loads(GEOJSON.read_text(encoding='utf-8'))
    muns = [(f['properties']['CD_MUN'], f['properties']['NM_MUN'], shape(f['geometry'])) for f in fc['features']]
    # Mais longo primeiro: "Nova Esperança do Sudoeste" antes de "Nova Esperança".
    by_name = sorted(((norm(nome), ibge) for ibge, nome, _ in muns), key=lambda x: -len(x[0]))
    return muns, by_name


def municipio_by_geo(muns, lat, lon):
    if lat is None or lon is None:
        return None
    p = Point(lon, lat)
    return next((ibge for ibge, _, geom in muns if geom.contains(p)), None)


def municipio_by_name(by_name, *texts):
    hay = ' '.join(norm(t) for t in texts)
    candidates = [*by_name, *APELIDOS.items()]
    return next((ibge for nome, ibge in candidates if has_word(hay, nome)), None)


def station_row(st):
    tags = [t.strip() for t in (st.get('tags') or '').split(',') if t.strip()][:4]
    return {
        'id': st['stationuuid'],
        'name': st['name'].strip(),
        'url': st['url_resolved'],
        'homepage': st.get('homepage') or '',
        'favicon': st['favicon'] if (st.get('favicon') or '').startswith('https://') else '',
        'codec': st.get('codec') or '',
        'bitrate': st.get('bitrate') or 0,
        'tags': tags,
    }


def main():
    req = urllib.request.Request(API, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        stations = json.load(resp)
    muns, by_name = load_municipios()
    nomes = {ibge: nome for ibge, nome, _ in muns}

    places, seen, dropped = {}, set(), []
    for st in stations:
        url = st.get('url_resolved') or ''
        if st.get('lastcheckok') != 1 or not url.startswith('https://') or url in seen:
            continue
        uf = uf_of(st.get('state'))
        geo_ibge = municipio_by_geo(muns, st.get('geo_lat'), st.get('geo_long'))
        if uf == 'outra' or (uf == '' and not geo_ibge):
            continue
        ibge = municipio_by_name(by_name, st['name'], st.get('state') or '', st.get('tags') or '') or geo_ibge
        if not ibge:
            dropped.append(st['name'].strip())
            continue
        seen.add(url)
        places.setdefault(ibge, []).append(station_row(st))

    out = {
        'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'Radio Browser (radio-browser.info)',
        'places': [
            {'ibge': ibge, 'nome': nomes[ibge], 'stations': sorted(sts, key=lambda s: s['name'].lower())}
            for ibge, sts in sorted(places.items(), key=lambda kv: -len(kv[1]))
        ],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    total = sum(len(p['stations']) for p in out['places'])
    print(f'{total} estações em {len(out["places"])} municípios -> {OUT}')
    for p in out['places']:
        print(f'  {p["nome"]}: ' + '; '.join(s['name'] for s in p['stations']))
    print(f'{len(dropped)} sem município identificável (fora): ' + '; '.join(dropped))


if __name__ == '__main__':
    main()
