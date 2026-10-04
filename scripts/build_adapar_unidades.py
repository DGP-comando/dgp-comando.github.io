"""Unidades da ADAPAR (escritórios regionais e locais) a partir do site oficial.

As 22 páginas "Escritório Regional de X" (adapar.pr.gov.br/Pagina/...) listam
o escritório regional e cada escritório local da circunscrição, com endereço,
CEP, telefone, e-mail, municípios atendidos e um link "MAPA" para o Google
Maps. A coordenada sai do próprio link (`@lat,lon`, `!3d..!4d..` ou `ll=`);
quando o link não tem ponto (só `sll=`, centro da busca) ou o ponto cai fora
do município, cai-se no Nominatim (endereço + município) e, por último, no
centro do município, com a checagem registrada na propriedade.

Saída pública (dado institucional, sem pessoa física):
  public/data/adapar-unidades-pr.geojson

Uso:  py -3 scripts/build_adapar_unidades.py [--refresh]
HTML em data/cache/adapar-unidades/ (reutilizado sem --refresh).
"""

from __future__ import annotations

import html
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote

import requests
from shapely.geometry import Point

from build_urs_programas import Base, OK, feature

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'cache' / 'adapar-unidades'
OUT = ROOT / 'public' / 'data' / 'adapar-unidades-pr.geojson'
INDICE = 'https://www.adapar.pr.gov.br/Pagina/Escritorios-Regionais-da-Adapar'
UA = {'User-Agent': 'DataGeo PR (datageoparana.github.io) build_adapar_unidades'}
NOMINATIM = 'https://nominatim.openstreetmap.org/search'

CAMPOS = {
    'Endereço': re.compile(r'^Endere[çc]o\s*:\s*(.+)$', re.I),
    'CEP': re.compile(r'^CEP\s*:\s*([\d.-]+)', re.I),
    'Telefone': re.compile(r'^(?:Fone|Telefone)[^:]*:\s*(.+)$', re.I),
    'E-mail': re.compile(r'^E-?mail\s*:\s*(\S+)', re.I),
    'Circunscrição': re.compile(r'^Circunscri[çc][ãa]o\s*:\s*(.+)$', re.I),
}
TITULO = re.compile(r'^(?:Escrit[óo]rio|Unidade)\s+(Regional|Local)\b.*?\bde\s+(.+?)\s*$', re.I)
CHEFE = re.compile(r'^Chefe\b.*?(?:Regional|Local)\s+(.+)$', re.I)


def baixar(url: str, nome: str, refresh: bool) -> str:
    CACHE.mkdir(parents=True, exist_ok=True)
    arq = CACHE / f'{nome}.html'
    if arq.exists() and not refresh:
        return arq.read_text(encoding='utf-8')
    r = requests.get(url, headers=UA, timeout=60)
    r.raise_for_status()
    r.encoding = 'utf-8'
    arq.write_text(r.text, encoding='utf-8')
    time.sleep(0.5)
    return r.text


def paginas_regionais(refresh: bool) -> list[str]:
    t = baixar(INDICE, '_indice', refresh)
    return sorted(set(re.findall(r'href="(https?://www\.adapar\.pr\.gov\.br/Pagina/Escritorio-Regional-de-[^"]+)"', t)))


def texto(pagina: str) -> list[str]:
    """Linhas de texto do corpo da página; o link MAPA vira `[MAPA:href]` na própria linha."""
    # Do título da página (h1 "Escritório Regional de X", que a maioria das
    # páginas não repete no corpo) ao fim do artigo.
    m = re.search(r'<h1 class="page-title".*?</article>', pagina, re.S)
    t = m.group(0) if m else pagina
    t = re.sub(r'<a[^>]*href="([^"]+)"[^>]*>\s*MAPA\s*</a>', r' [MAPA:\1] ', t, flags=re.I)
    t = re.sub(r'<br\s*/?>', '\n', t, flags=re.I)
    t = re.sub(r'</(p|div|h\d|li|tr)>', '\n', t, flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t).replace('\xa0', ' ').replace('📌', ' ')
    return [re.sub(r'\s+', ' ', ln).strip() for ln in t.split('\n') if ln.strip()]


def resolver_curto(href: str) -> str:
    """Link curto (maps.app.goo.gl) -> URL longa com o ponto; cache em disco."""
    if 'goo.gl' not in href:
        return href
    cache = CACHE / '_links.json'
    links = json.loads(cache.read_text(encoding='utf-8')) if cache.exists() else {}
    if href not in links:
        try:
            links[href] = requests.get(href, headers=UA, timeout=30, allow_redirects=True).url
        except requests.RequestException:
            links[href] = href
        time.sleep(0.3)
        cache.write_text(json.dumps(links, indent=1), encoding='utf-8')
    return links[href]


def coord_do_link(href: str, *, busca: bool = False) -> tuple[float, float] | None:
    """(lat, lon) do link do Google Maps. `busca=True` aceita também o centro da
    busca (`sll=`), que é só a vizinhança e por isso fica para o fim da fila."""
    h = unquote(html.unescape(href))
    pats = [r'!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)', r'/@(-?\d+\.\d+),(-?\d+\.\d+)', r'[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)',
            r'[?&]q=(-?\d+\.\d+),\s*(-?\d+\.\d+)']
    if busca:
        pats.append(r'[?&]sll=(-?\d+\.\d+),(-?\d+\.\d+)')
    for pat in pats:
        m = re.search(pat, h)
        if m:
            return float(m.group(1)), float(m.group(2))
    return None


def parse(pagina: str, regional: str) -> list[dict]:
    unidades: list[dict] = []
    atual: dict | None = None
    for ln in texto(pagina):
        m = TITULO.match(ln)
        if m and '[MAPA' not in ln:
            tipo, nome = m.group(1).capitalize(), m.group(2).strip(' -')
            repetido = next((u for u in unidades if u['Tipo'] == tipo and u['Nome'] == nome), None)
            if repetido:
                atual = repetido  # h1 da página e h3 do corpo: a mesma unidade
                continue
            atual = {'Tipo': tipo, 'Nome': nome, 'Regional': regional}
            unidades.append(atual)
            continue
        if atual is None:
            continue
        m = CHEFE.match(ln)
        if m and 'Chefe' not in atual:
            atual['Chefe'] = m.group(1).strip()
            continue
        mapa = re.search(r'\[MAPA:(\S+)\]', ln)
        if mapa:
            atual['_mapa'] = mapa.group(1)
            ln = ln.replace(mapa.group(0), '').strip()
        for campo, rx in CAMPOS.items():
            m = rx.match(ln)
            if m and campo not in atual:
                v = m.group(1).strip(' -–,')
                atual[campo] = re.sub(r'\s*-\s*MAPA\s*$', '', v).rstrip(' -')
                break
    return unidades


def _nominatim(q: str) -> tuple[float, float] | None:
    try:
        r = requests.get(NOMINATIM, params={'q': q, 'format': 'json', 'limit': 1, 'countrycodes': 'br'},
                         headers=UA, timeout=30)
        time.sleep(1.1)  # política de uso do Nominatim: 1 req/s
        hit = r.json()[0]
        return float(hit['lat']), float(hit['lon'])
    except (IndexError, ValueError, KeyError, requests.RequestException):
        return None


def nominatim(endereco: str, municipio: str) -> tuple[tuple[float, float], str] | None:
    """Endereço completo primeiro; sem o número depois (cidades pequenas raramente
    têm numeração no OSM, e a rua certa vale mais que o centro do município)."""
    rua = re.split(r'\s[-–]\s|,\s*(?:Centro|Bairro)', endereco)[0]
    rua = re.sub(r',?\s*' + re.escape(municipio) + r'.*$', '', rua, flags=re.I).strip(' ,-')
    sem_numero = re.sub(r',?\s*(?:n[º°.]?\s*)?\d+[\w/-]*\s*$', '', rua).strip(' ,-')
    for q, rotulo in ((rua, 'endereço geocodificado (Nominatim)'),
                      (sem_numero, 'rua geocodificada sem o número (Nominatim)')):
        if not q:
            continue
        pt = _nominatim(f'{q}, {municipio}, Paraná, Brasil')
        if pt:
            return pt, rotulo
    return None


def localizar(u: dict, base: Base) -> tuple[float, float, str] | None:
    """(lon, lat, checagem). Município = o do nome do escritório."""
    mun = base.municipio(u['Nome'])
    if not mun:
        print(f'  ! município não reconhecido: {u["Nome"]!r}', file=sys.stderr)
        return None
    geom = base.geom[mun[0]].buffer(0.02)
    dentro = lambda p: geom.contains(Point(p[1], p[0]))  # noqa: E731
    u['Município'], u['ibge'] = mun[1], mun[0]
    href = resolver_curto(u.pop('_mapa', '') or '')
    pt = coord_do_link(href)
    if pt and dentro(pt):
        return pt[1], pt[0], OK
    if u.get('Endereço'):
        geo = nominatim(u['Endereço'], mun[1])
        if geo and dentro(geo[0]):
            return geo[0][1], geo[0][0], geo[1]
    vizinhanca = coord_do_link(href, busca=True)
    if vizinhanca and dentro(vizinhanca):
        return vizinhanca[1], vizinhanca[0], 'centro da busca do link do mapa (vizinhança)'
    c = geom.representative_point()
    motivo = 'link do mapa fora do município' if pt else 'sem coordenada no site'
    return c.x, c.y, f'{motivo}: ponto no centro do município'


def main() -> None:
    refresh = '--refresh' in sys.argv
    base = Base()
    feats = []
    for url in paginas_regionais(refresh):
        slug = url.rsplit('/', 1)[-1]
        regional = html.unescape(re.sub(r'^Escritorio-Regional-de-', '', slug)).replace('-', ' ')
        unidades = parse(baixar(url, slug, refresh), regional)
        reg = next((u for u in unidades if u['Tipo'] == 'Regional'), None)
        if reg:
            regional = reg['Nome']
        for u in unidades:
            u['Regional'] = regional
            loc = localizar(u, base)
            if not loc:
                continue
            lon, lat, chk = loc
            u['Checagem da coordenada'] = chk
            u['Fonte'] = url
            feats.append(feature(lon, lat, u))
        print(f'{regional}: {len(unidades)} unidades')
    OUT.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}, ensure_ascii=False,
                              separators=(',', ':')), encoding='utf-8')
    fora = [f for f in feats if f['properties']['Checagem da coordenada'] != OK]
    print(f'\n{OUT.name}: {len(feats)} unidades ({sum(1 for f in feats if f["properties"]["Tipo"] == "Regional")} regionais), '
          f'{len(fora)} sem ponto do site:')
    for f in fora:
        print(f'  - {f["properties"]["Nome"]}: {f["properties"]["Checagem da coordenada"]}')


def _demo() -> None:
    assert coord_do_link('https://www.google.com.br/maps/place/X/@-25.464096,-50.649749,17z/data=!3m1') == (-25.464096, -50.649749)
    assert coord_do_link('https://maps.google.com.br/maps?q=Rua&amp;ll=-25.724186,-50.790803&amp;sll=-25.2,-50.6') == (-25.724186, -50.790803)
    assert coord_do_link('https://maps.google.com.br/maps?q=Rua&amp;sll=-25.231226,-50.605302') is None
    pagina = ('<title>Escritório Regional de Irati | ADAPAR</title><h1 class="page-title"><span>Escritório Regional de Irati</span></h1><div class="field--name-field-texto"><h3>Escritório Regional de Irati</h3>'
              '<p><strong>Chefe de Escritório Regional Eng. Roberto<br/>Endereço: </strong>Rua A, 1 - Irati - PR - 📌 <a href="https://x/@-25.46,-50.64,17z">MAPA</a>'
              '<br><strong>CEP: </strong>84500-016<br>Fone/Fax: (42) 3422-4761</p><h3>Escritório Local de Imbituva</h3><p>'
              '<strong>Endereço: </strong>Rua B, 77, Imbituva - PR - <a href="https://x/?sll=-25.1,-50.2">MAPA</a><br>E-mail: a@b.c<br>'
              '<strong>Circunscrição:</strong> Guamiranga, Imbituva e Ivaí</p></article>')
    us = parse(pagina, 'Irati')
    assert [(u['Tipo'], u['Nome']) for u in us] == [('Regional', 'Irati'), ('Local', 'Imbituva')], us
    assert us[0]['Endereço'] == 'Rua A, 1 - Irati - PR' and us[0]['CEP'] == '84500-016' and us[0]['Chefe'] == 'Eng. Roberto', us[0]
    assert us[1]['Circunscrição'] == 'Guamiranga, Imbituva e Ivaí' and us[1]['E-mail'] == 'a@b.c', us[1]
    assert us[1]['_mapa'] == 'https://x/?sll=-25.1,-50.2' and coord_do_link(us[1]['_mapa'], busca=True) == (-25.1, -50.2)
    print('demo ok')


if __name__ == '__main__':
    _demo() if '--demo' in sys.argv else main()
