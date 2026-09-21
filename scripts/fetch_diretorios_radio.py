#!/usr/bin/env python3
"""Varre dois diretórios de rádio por município do PR: Ache Rádios e Rankeador.

Os dois têm uma página por cidade, e é isso que faz deles o complemento da
lista da Anatel: a rádio comunitária pequena, que não aparece em busca, está
listada ali com o nome no ar.

  - Ache Rádios (acheradios.com.br/radios/pr/<cidade>-pr/): nome, frequência
    e segmento (inclusive "Comunitária") no cartão; na página da estação, o
    JSON-LD traz telefone e site próprio.
  - Rankeador (rankeador.com.br/radios/pr/<cidade>): a página da estação traz
    o endereço do stream.

Só entra estação com frequência de dial (FM/AM): web rádio sem dial não é a
rádio local que se procura aqui. Cada stream é testado (Content-Type de
áudio ou cabeçalho icy-) antes de ser gravado.

Saída: data/radios/diretorios-pr.json (lido por build_radios.py).

Uso:
  py -3 scripts/fetch_diretorios_radio.py
"""

import concurrent.futures as cf
import html
import json
import re
import subprocess
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEOJSON = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT = ROOT / 'data' / 'radios' / 'diretorios-pr.json'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
ACHE = 'https://www.acheradios.com.br'
RANK = 'https://www.rankeador.com.br'
FREQ = re.compile(r'(?<![\d.,])((?:8[7-9]|9\d|10[0-8])[.,]\d)\s*(?:FM|MHz)?|(?<!\d)(\d{3,4})\s*(?:AM|kHz)', re.I)
STREAM = re.compile(r'''https?://[^\s"'<>()\\]+?(?::\d{2,5}(?:/[^\s"'<>()\\]*)?|/live\b[^\s"'<>()\\]*|/stream\b[^\s"'<>()\\]*|\.(?:mp3|aac|m3u8)\b[^\s"'<>()\\]*|stream\.zeno\.fm/[^\s"'<>()\\]+)''', re.I)


_PAGES: dict[str, str] = {}


def cached(url: str) -> str:
    """Página de estação: a mesma rádio aparece em várias cidades (e a lista
    genérica de cidade sem cadastro repete as mesmas nacionais)."""
    if url not in _PAGES:
        _PAGES[url] = curl(url)
    return _PAGES[url]


def curl(url: str, extra: tuple = (), timeout: int = 20) -> str:
    try:
        out = subprocess.run(['curl', '-s', '-L', '-A', UA, '--max-time', str(timeout), *extra, url],
                             capture_output=True, timeout=timeout + 5).stdout
    except subprocess.TimeoutExpired:
        return ''
    return html.unescape(out.decode('utf-8', 'ignore'))


def slug(nome: str) -> str:
    ascii_ = unicodedata.normalize('NFKD', nome).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', ascii_.replace("'", '')).strip('-')


def norm(text: str) -> str:
    return unicodedata.normalize('NFKD', text or '').encode('ascii', 'ignore').decode().lower()


def freq_text(text: str) -> str:
    m = FREQ.search(text or '')
    if not m:
        return ''
    return f"{m.group(1).replace('.', ',')} FM" if m.group(1) else f'{m.group(2)} AM'


def stream_ok(url: str) -> bool:
    head = curl(url, ('-r', '0-4000', '-D', '-', '-o', '/dev/null'), 12).lower()
    return bool(re.search(r'content-type:\s*(audio/|application/ogg|application/(vnd\.apple\.|x-)mpegurl)', head)) or 'icy-' in head


def ache_city(municipio: str) -> list[dict]:
    page = curl(f'{ACHE}/radios/pr/{slug(municipio)}-pr/')
    rows = []
    for href, name, info in re.findall(
            r'class=radio-card-link href=(/[^ >]+/)>.*?class=radio-card-name>([^<]+)</h3>\s*<p[^>]*>(.*?)</p>', page, re.S):
        text = re.sub(r'<[^>]+>', ' ', info)
        freq = freq_text(text)
        if not freq:
            continue
        station = cached(ACHE + href)
        # Cidade sem rádio cadastrada devolve uma lista de rádios nacionais:
        # só vale a estação cuja trilha de navegação passa pelo município.
        crumb = re.search(r'"position":3,"name":"([^"]+)"', station)
        if not crumb or norm(crumb.group(1)) != norm(municipio):
            continue
        ld = re.search(r'"@type":"RadioStation".*?(?=\}\]\}|$)', station, re.S)
        ld = ld.group(0) if ld else ''
        tel = re.search(r'"telephone":"([^"]+)"', ld)
        site = re.search(r'"sameAs":\["(https?://[^"]+)"', ld)
        rows.append({'municipio': municipio, 'name': name.strip(), 'freq': freq,
                     'comunitaria': 'comunit' in text.lower(), 'telefone': tel.group(1) if tel else '',
                     'site': site.group(1) if site else '', 'fonte': ACHE + href})
    return rows


def rank_city(municipio: str) -> list[dict]:
    # Só a lista da cidade: a barra "Top Rádios" repete as nacionais em toda página.
    page = curl(f'{RANK}/radios/pr/{slug(municipio)}').split('Top Rádios')[0]
    rows = []
    for href, name in dict.fromkeys(re.findall(r'href="(/radio/[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{3,80})<', page)):
        freq = freq_text(name)
        if not freq:
            continue
        station = cached(RANK + href).replace('\\/', '/')
        # Mesma armadilha da lista genérica: a página da estação tem de citar a cidade.
        title = re.search(r'<title>(.*?)</title>', station, re.S)
        if not title or norm(municipio) not in norm(title.group(1) + ' ' + station[:20000]):
            continue
        stream = next((s for s in list(dict.fromkeys(STREAM.findall(station)))[:3] if stream_ok(s)), '')
        rows.append({'municipio': municipio, 'name': name.strip(), 'freq': freq, 'stream': stream, 'fonte': RANK + href})
    return rows


def city(municipio: str) -> list[dict]:
    rows = ache_city(municipio)
    for r in rank_city(municipio):
        twin = next((a for a in rows if a['freq'] == r['freq']), None)
        if twin:
            twin['stream'] = twin.get('stream') or r['stream']
        else:
            rows.append({**r, 'comunitaria': False, 'telefone': '', 'site': ''})
    return rows


def main() -> None:
    fc = json.loads(GEOJSON.read_text(encoding='utf-8'))
    municipios = sorted(f['properties']['NM_MUN'] for f in fc['features'])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    with cf.ThreadPoolExecutor(6) as ex:
        for n, lst in enumerate(ex.map(city, municipios), 1):
            rows.extend(lst)
            if n % 25 == 0 or n == len(municipios):
                OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding='utf-8')
                print(f'  {n}/{len(municipios)} municípios, {len(rows)} estações', flush=True)
    print(f"{len(rows)} estações de dial em {len({r['municipio'] for r in rows})} municípios; "
          f"{sum(bool(r.get('stream')) for r in rows)} com stream no ar; "
          f"{sum(r['comunitaria'] for r in rows)} comunitárias -> {OUT}")


if __name__ == '__main__':
    main()
