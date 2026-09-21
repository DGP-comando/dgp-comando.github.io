#!/usr/bin/env python3
"""Busca contato (e nome no ar) das rádios que ainda não têm, via DuckDuckGo.

Para cada estação sem telefone nem WhatsApp em public/data/radios-pr.json,
pesquisa no DuckDuckGo (versão HTML) pelo nome da rádio, ou, se ela só é
conhecida como "Comunitária 87,9 FM", pela frequência e município. Dos
resultados, só valem os que citam o município. Deles se aproveita:

  - página da estação no Ache Rádios: JSON-LD com nome, telefone e site,
    aceita só se a frequência bater com a da estação;
  - site próprio da rádio: página inicial e páginas de contato, lidas com a
    mesma extração de scripts/fetch_contatos_radio.py;
  - telefone no próprio trecho do resultado, se o trecho citar o município e
    a frequência ou o nome da rádio.

Uma consulta a cada ~2 s, em série: é um serviço de terceiros, e é o que o
mantém respondendo. Grava em data/radios/contatos-extra.json (mesmo formato
de fetch_contatos_radio.py; só acrescenta, nunca apaga).

Uso:
  py -3 scripts/buscar_contatos_radio.py
"""

import json
import random
import re
import time
import urllib.parse

from fetch_contatos_radio import OUT, PHONE, RADIOS, contact_pages, curl, extract, norm

DDG = 'https://html.duckduckgo.com/html/?q='
AGREGADORES = ('radios.com.br', 'radiosaovivo', 'ouviraovivo', 'mytuner', 'onlineradiobox', 'radio.garden',
               'streema', 'tunein', 'facebook.', 'instagram.', 'youtube.', 'rankeador', 'tudoradio', 'radioonline',
               'radiosnet', 'guiamais', 'apontador', 'cnpj', 'econodata', 'wikipedia', 'play.google', 'apple.com',
               'x.com', 'twitter', 'tiktok', 'linkedin', 'gov.br', 'jusbrasil', 'zeno.fm', 'radioplayer', 'radio-browser')


def buscar(query: str) -> list[dict]:
    page = curl(DDG + urllib.parse.quote(query), 20)
    out = []
    for block in page.split('class="result ')[1:]:
        a = re.search(r'class="result__a" href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not a:
            continue
        href = a.group(1)
        uddg = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get('uddg')
        snip = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', block, re.S)
        out.append({'url': uddg[0] if uddg else href,
                    'title': re.sub(r'<[^>]+>', '', a.group(2)),
                    'snippet': re.sub(r'<[^>]+>', '', snip.group(1)) if snip else ''})
    return out


def freq_digits(freq: str) -> str:
    return re.sub(r'\D', '', freq or '')


def ache_station(url: str, municipio: str, freq: str) -> dict:
    page = curl(url)
    # Trilha Estado > Cidade: há municípios homônimos (Inajá-PR e Inajá-PE).
    if '"position":2,"name":"Paraná"' not in page:
        return {}
    crumb = re.search(r'"position":3,"name":"([^"]+)"', page)
    desc = re.search(r'"description":"([^"]+)"', page)
    if not crumb or norm(crumb.group(1)) != norm(municipio):
        return {}
    if freq and freq_digits(freq) not in re.sub(r'\D', '', desc.group(1) if desc else ''):
        return {}
    out = {}
    if m := re.search(r'"@type":"RadioStation","name":"([^"]+)"', page):
        out['name'] = m.group(1)
    if m := re.search(r'"telephone":"([^"]+)"', page):
        out['telefone'] = m.group(1)
    if m := re.search(r'"sameAs":\["(https?://[^"]+)"', page):
        out['site'] = m.group(1)
    return out


def estacao(municipio: str, st: dict) -> dict:
    generic = st['name'].startswith('Comunitária ')
    freq = st.get('freq', '').replace(' FM', '')
    query = f'rádio {freq} FM {municipio} PR' if generic else f'"{st["name"]}" {municipio} PR'
    results = [r for r in buscar(query) if norm(municipio) in norm(r['title'] + ' ' + r['snippet'])]
    found = {}
    for r in results:
        text = r['title'] + ' ' + r['snippet']
        ligado = freq_digits(freq) and freq_digits(freq) in re.sub(r'\D', '', text) or (not generic and norm(st['name'])[:12] in norm(text))
        if 'telefone' not in found and ligado and (m := PHONE.search(text)):
            found['telefone'] = f'({m.group(1)}) {m.group(2)}-{m.group(3)}'
        host = urllib.parse.urlparse(r['url']).netloc.lower()
        if 'acheradios.com.br' in host and not found.get('_ache'):
            ache = ache_station(r['url'], municipio, st.get('freq', ''))
            found = {**ache, **found, '_ache': True}
        elif not any(a in host for a in AGREGADORES) and 'site' not in found and ligado:
            found['site'] = r['url']
    site = found.get('site') or st.get('site')
    if site and not (found.get('telefone') and found.get('endereco')):
        home = curl(site)
        if home:
            extra = extract([home] + [curl(u) for u in contact_pages(site, home)], municipio)
            found = {**extra, **found}
    found.pop('_ache', None)
    if not generic:
        found.pop('name', None)
    return {k: v for k, v in found.items() if v and not st.get(k)}


def main() -> None:
    data = json.loads(RADIOS.read_text(encoding='utf-8'))
    todo = [(p['nome'], s) for p in data['places'] for s in p['stations']
            if not (s.get('telefone') or s.get('whatsapp'))]
    extras = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
    ganhos = 0
    for n, (municipio, st) in enumerate(todo, 1):
        if extras.get(st['id'], {}).get('_buscado'):
            continue  # retomada: já pesquisada numa rodada anterior
        try:
            found = estacao(municipio, st)
        except Exception as err:  # uma estação ruim não derruba a varredura
            print(f'  erro em {st["id"]}: {err}')
            found = {}
        extras[st['id']] = {**extras.get(st['id'], {}), **found, '_buscado': True}
        ganhos += bool(found)
        if n % 20 == 0 or n == len(todo):
            OUT.write_text(json.dumps(extras, ensure_ascii=False, indent=1), encoding='utf-8')
            print(f'  {n}/{len(todo)} pesquisadas, {ganhos} com dado novo', flush=True)
        time.sleep(1.5 + random.random())
    OUT.write_text(json.dumps(extras, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
