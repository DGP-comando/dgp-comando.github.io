#!/usr/bin/env python3
"""Gera data/privado/radios-pr.json: rádios do PR agrupadas por município.

Quatro fontes, na ordem de autoridade:

  1. data/radios/radcom-pr.json — as rádios COMUNITÁRIAS instaladas no PR, da
     consulta pública do SRD/Anatel (entidade, município, canal), completadas
     por pesquisa (nome no ar, site, stream, contato, endereço, programa
     rural). É a fonte que traz a rádio que fala com o produtor: toda
     comunitária entra, com ou sem transmissão pela internet.
  2. data/radios/radiogarden-pr.json — estações que o radio.garden lista no
     PR, com o stream próprio de cada emissora (o destino do redirecionamento
     deles, não o proxy) e contato raspado do site da emissora
     (scripts/fetch_radiogarden.py).
  3. data/radios/diretorios-pr.json — Ache Rádios e Rankeador, que têm uma
     página por município (scripts/fetch_diretorios_radio.py). É onde a
     comunitária pequena aparece com o nome no ar; ela completa a outorga da
     Anatel da mesma cidade.
  4. Radio Browser, consultado aqui mesmo: diretório comunitário de domínio
     público com checagem diária de disponibilidade.

Regras:
  - Toca no navegador só stream HTTPS: o Pages serve em HTTPS e o navegador
    bloqueia áudio HTTP (mixed content). Estação sem stream HTTPS entra com
    `url` vazio, "só no dial", se tiver frequência; sem frequência nem stream
    não há o que mostrar e ela sai.
  - A mesma rádio vinda de duas fontes (mesmo município e frequência, ou mesmo
    stream) vira uma só; a comunitária da Anatel manda no nome e no selo,
    contato e stream se completam.
  - Contato é só institucional (telefone do estúdio, WhatsApp da rádio,
    endereço do estúdio). Endereço que não parece endereço (texto de notícia
    raspado junto) é descartado em vez de exibido.
  - Município: nome no texto da estação (o mais longo que casa como palavra
    inteira), senão polígono municipal que contém a coordenada.

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
RADCOM = ROOT / 'data' / 'radios' / 'radcom-pr.json'
RADIOGARDEN = ROOT / 'data' / 'radios' / 'radiogarden-pr.json'
DIRETORIOS = ROOT / 'data' / 'radios' / 'diretorios-pr.json'
EXTRAS = ROOT / 'data' / 'radios' / 'contatos-extra.json'
OUT = ROOT / 'data' / 'privado' / 'radios-pr.json'
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
ADDR_OK = re.compile(
    r'^(?:Rua|R\.|Avenida|Av\.?|Travessa|Tv\.|Rodovia|Rod\.|Praça|Pça\.?|Alameda|Estrada|Linha)\s+'
    r'[^,;]{2,60}?(?:,|\s-|\s)\s*(?:n[º°o.]?\s*)?\d{1,5}\b',
    re.I,
)
# DDD do Paraná (41 a 46): número de outra região é da agência que fez o site
# ou de uma homônima em outro estado, não do estúdio.
PHONE = re.compile(r'\(?\b(4[1-6])\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b')


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


def freq_of(*texts) -> str:
    """'87,9 FM' ou '1300 AM' achado no texto; vazio se nenhum."""
    for text in texts:
        t = str(text or '')
        fm = re.search(r'(?<![\d.,])(8[7-9]|9\d|10[0-8])[.,](\d)(?![\d])', t)
        if fm:
            return f'{fm.group(1)},{fm.group(2)} FM'
        am = re.search(r'(?<!\d)(\d{3,4})\s*(?:AM|kHz)\b', t, re.I)
        if am and 530 <= int(am.group(1)) <= 1700:
            return f'{am.group(1)} AM'
    return ''


def clean_phone(raw: str) -> str:
    m = PHONE.search(str(raw or '').replace('+55', ' '))
    return f'({m.group(1)}) {m.group(2)}-{m.group(3)}' if m else ''


def clean_whatsapp(raw: str) -> str:
    d = re.sub(r'\D', '', str(raw or ''))
    body = d[2:] if d.startswith('55') and len(d) >= 12 else d
    return body if 10 <= len(body) <= 11 and not re.fullmatch(r'0+', body) else ''


def clean_address(raw: str) -> str:
    a = re.sub(r'\s+', ' ', str(raw or '')).strip(' ,.-')
    return a if len(a) <= 140 and ADDR_OK.match(a) else ''


def clean_url(raw: str) -> str:
    u = str(raw or '').strip()
    return u if re.match(r'https?://[^\s]+\.[^\s]+', u) else ''


def contact(d: dict) -> dict:
    email = str(d.get('email') or '').strip()
    return {
        'telefone': clean_phone(d.get('telefone')),
        'whatsapp': clean_whatsapp(d.get('whatsapp')),
        'email': email if re.fullmatch(r'[\w.+-]+@[\w-]+(\.[\w-]+)+', email) else '',
        'endereco': clean_address(d.get('endereco')),
        'site': clean_url(d.get('site') or d.get('website')),
        'instagram': clean_url(d.get('instagram')),
        'facebook': clean_url(d.get('facebook')),
    }


def playable(url: str) -> str:
    return url if str(url or '').startswith('https://') else ''


def entidade_legivel(nome: str) -> str:
    """ASSOCIACAO COMUNITARIA DE X -> Associacao Comunitaria de X."""
    minus = {'de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'para'}
    words = re.sub(r'\s+', ' ', nome.strip()).split(' ')
    return ' '.join(w.lower() if i and w.lower() in minus else w.capitalize() for i, w in enumerate(words))


def radcom_stations(muns_by_norm):
    out, seen = [], set()
    for i, r in enumerate(json.loads(RADCOM.read_text(encoding='utf-8'))):
        ibge = muns_by_norm.get(norm(r['municipio'].split(' (')[0]))
        if not ibge:
            continue
        freq = f"{float(r['freq_mhz']):.1f}".replace('.', ',') + ' FM'
        nome = (r.get('nome') or '').strip()
        # Achado que não é desta outorga: nome com outra frequência, ou a mesma
        # emissora já atribuída a outra entidade do mesmo município e canal.
        wrong_freq = freq_of(nome) not in ('', freq)
        twin = (ibge, norm(nome)) in seen
        found = bool(nome) and not wrong_freq and not twin
        seen.add((ibge, norm(nome)))
        out.append({
            'ibge': ibge, 'id': f"anatel-{ibge}-{r['canal']}-{i}", 'freq': freq,
            'name': nome if found else f'Comunitária {freq}',
            'url': playable(r.get('stream')) if found and r.get('stream_validado', True) else '',
            'comunitaria': True, 'rural': found and bool(r.get('rural')),
            'entidade': entidade_legivel(r['entidade']),
            **(contact(r) if found else contact({})),
        })
    return out


def radiogarden_stations(muns, by_name, muns_by_norm):
    out = []
    for r in json.loads(RADIOGARDEN.read_text(encoding='utf-8')):
        # O radio.garden agrupa a região metropolitana no ponto da cidade-polo
        # ("Pinhais FM" em Curitiba): município citado no nome manda.
        ibge = (municipio_by_name(by_name, r['name']) or muns_by_norm.get(norm(r['city']))
                or municipio_by_geo(muns, r['lat'], r['lon']))
        freq = freq_of(r['name'])
        url = playable(r['stream']) if r.get('stream_ok') else ''
        if not ibge or not (url or freq):
            continue
        out.append({'ibge': ibge, 'id': f"rg-{r['rg_id']}", 'name': r['name'].strip(), 'freq': freq, 'url': url,
                    'comunitaria': False, 'rural': False, **contact(r)})
    return out


def diretorio_stations(muns_by_norm):
    """Ache Rádios + Rankeador (scripts/fetch_diretorios_radio.py), se já baixado."""
    if not DIRETORIOS.exists():
        return []
    out = []
    for i, r in enumerate(json.loads(DIRETORIOS.read_text(encoding='utf-8'))):
        ibge = muns_by_norm.get(norm(r['municipio']))
        if ibge:
            out.append({'ibge': ibge, 'id': f'dir-{ibge}-{i}', 'name': r['name'].strip(), 'freq': r['freq'],
                        'url': playable(r.get('stream')), 'comunitaria': bool(r.get('comunitaria')),
                        'rural': False, **contact(r)})
    return out


def fill_radcom(radcom: list, found: list) -> list:
    """Comunitária achada em diretório completa a outorga da Anatel na mesma cidade.

    Casa pelo canal; senão, com a primeira outorga da cidade ainda sem nome,
    e aí vale a frequência do diretório: é a que está no ar (várias
    comunitárias mudaram de canal depois da outorga registrada no SRD).
    Devolve as que não casaram com nenhuma outorga.
    """
    rest = []
    for st in found:
        city = [r for r in radcom if r['ibge'] == st['ibge']]
        generic = [r for r in city if r['name'].startswith('Comunitária ')]
        target = next((r for r in city if r['freq'] == st['freq']), None) or (generic[0] if generic else None)
        if target is None:
            rest.append(st)
            continue
        if target['name'].startswith('Comunitária '):
            target['name'], target['freq'] = st['name'], st['freq']
        merge_into(target, st)
    return rest


def radiobrowser_stations(muns, by_name):
    req = urllib.request.Request(API, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        stations = json.load(resp)
    out = []
    for st in stations:
        url = st.get('url_resolved') or ''
        if st.get('lastcheckok') != 1 or not url.startswith('https://'):
            continue
        uf = uf_of(st.get('state'))
        geo_ibge = municipio_by_geo(muns, st.get('geo_lat'), st.get('geo_long'))
        if uf == 'outra' or (uf == '' and not geo_ibge):
            continue
        ibge = municipio_by_name(by_name, st['name'], st.get('state') or '', st.get('tags') or '') or geo_ibge
        if not ibge:
            continue
        tags = [t.strip() for t in (st.get('tags') or '').split(',') if t.strip()][:4]
        out.append({'ibge': ibge, 'id': st['stationuuid'], 'name': st['name'].strip(), 'freq': freq_of(st['name']),
                    'url': url, 'comunitaria': False, 'rural': False, 'tags': tags,
                    'favicon': st['favicon'] if (st.get('favicon') or '').startswith('https://') else '',
                    'bitrate': st.get('bitrate') or 0, **contact({'site': st.get('homepage')})})
    return out


def merge_into(base: dict, extra: dict) -> None:
    """Completa `base` com o que `extra` tem e ela não; comunitária manda no nome,
    exceto quando o dela é o genérico "Comunitária 87,9 FM"."""
    if base['name'].startswith('Comunitária ') and not extra['name'].startswith('Comunitária '):
        base['name'] = extra['name']
    for k, v in extra.items():
        if k in ('ibge', 'id', 'name', 'comunitaria'):
            continue
        if v and not base.get(k):
            base[k] = v
    base['rural'] = base.get('rural') or extra.get('rural', False)
    base['comunitaria'] = base.get('comunitaria') or extra.get('comunitaria', False)


def main():
    muns, by_name = load_municipios()
    nomes = {ibge: nome for ibge, nome, _ in muns}
    muns_by_norm = {norm(nome): ibge for ibge, nome, _ in muns}

    stations = []
    by_freq, by_url = {}, {}
    radcom = radcom_stations(muns_by_norm)
    diretorio = diretorio_stations(muns_by_norm)
    outros = fill_radcom(radcom, [d for d in diretorio if d['comunitaria']])
    sources = [radcom, radiogarden_stations(muns, by_name, muns_by_norm),
               outros + [d for d in diretorio if not d['comunitaria']], radiobrowser_stations(muns, by_name)]
    for batch in sources:
        for st in batch:
            fkey = (st['ibge'], st['freq']) if st['freq'] else None
            twin = by_url.get(st['url']) if st['url'] else None
            # Duas comunitárias no mesmo canal da mesma cidade são outorgas distintas.
            if not twin and fkey in by_freq and not (st['comunitaria'] and by_freq[fkey]['comunitaria']):
                twin = by_freq[fkey]
            if twin:
                merge_into(twin, st)
            else:
                stations.append(st)
                twin = st
            if fkey:
                by_freq.setdefault(fkey, twin)
            if twin['url']:
                by_url.setdefault(twin['url'], twin)

    # Contato achado depois, no site da rádio ou em busca
    # (scripts/fetch_contatos_radio.py, scripts/buscar_contatos_radio.py):
    # só preenche o que falta, sempre passando pela mesma limpeza.
    extras = json.loads(EXTRAS.read_text(encoding='utf-8')) if EXTRAS.exists() else {}
    for st in stations:
        extra = extras.get(st['id'])
        if not extra:
            continue
        if extra.get('name') and st['name'].startswith('Comunitária '):
            st['name'] = extra['name']
        for k, v in contact(extra).items():
            if v and not st.get(k):
                st[k] = v

    places = {}
    for st in stations:
        places.setdefault(st.pop('ibge'), []).append({k: v for k, v in st.items() if v not in ('', [], 0, None)})
    live = lambda s: bool(s.get('url'))  # noqa: E731
    out = {
        'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sources': ['Anatel SRD (RadCom)', 'radio.garden', 'Ache Rádios', 'Rankeador', 'Radio Browser'],
        'places': [
            {'ibge': ibge, 'nome': nomes[ibge],
             'stations': sorted(sts, key=lambda s: (not live(s), not s.get('comunitaria'), s['name'].lower()))}
            for ibge, sts in sorted(places.items(), key=lambda kv: nomes[kv[0]])
        ],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    all_st = [s for p in out['places'] for s in p['stations']]
    print(f"{len(all_st)} estações em {len(out['places'])} municípios -> {OUT}")
    print(f"  ao vivo (https): {sum(map(live, all_st))} · só no dial: {sum(not live(s) for s in all_st)}")
    print(f"  comunitárias: {sum(bool(s.get('comunitaria')) for s in all_st)} "
          f"(ao vivo {sum(bool(s.get('comunitaria')) and live(s) for s in all_st)}) · rural: {sum(bool(s.get('rural')) for s in all_st)}")
    print(f"  com telefone/whats: {sum(bool(s.get('telefone') or s.get('whatsapp')) for s in all_st)} · "
          f"com endereço: {sum(bool(s.get('endereco')) for s in all_st)}")


if __name__ == '__main__':
    main()
