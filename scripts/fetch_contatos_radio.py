#!/usr/bin/env python3
"""Completa contato e endereço das rádios que ainda não têm, lendo o site delas.

Para cada estação de data/privado/radios-pr.json com site e sem telefone,
WhatsApp ou endereço, lê a página inicial e até três páginas internas cujo
link fala de contato ("contato", "fale conosco", "quem somos", "sobre",
"expediente"). É nessas páginas que a rádio pequena publica o telefone do
estúdio e o endereço; a página inicial quase nunca traz.

Só entra o que a própria emissora publica. Telefone só com DDD do Paraná
(41 a 46), para não pegar o número da agência que fez o site; endereço só se
parecer endereço e a página citar o município da rádio.

Saída: data/radios/contatos-extra.json = {id da estação: {campo: valor}},
lido por build_radios.py por cima das outras fontes (nunca apaga o que já há).

Uso:
  py -3 scripts/fetch_contatos_radio.py
"""

import concurrent.futures as cf
import html
import json
import re
import subprocess
import unicodedata
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parent.parent
RADIOS = ROOT / 'data' / 'privado' / 'radios-pr.json'
OUT = ROOT / 'data' / 'radios' / 'contatos-extra.json'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
PHONE = re.compile(r'\(?\b(4[1-6])\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b')
WA = re.compile(r'(?:wa\.me/|api\.whatsapp\.com/send/?\?phone=|whatsapp\.com/send/?\?phone=)\+?(\d{10,13})')
MAIL = re.compile(r'[\w.+-]+@[\w-]+\.(?:com|org|net|br)(?:\.br)?', re.I)
ADDR = re.compile(r'\b(?:Rua|R\.|Avenida|Av\.|Travessa|Rodovia|Rod\.|Praça|Alameda|Estrada)\s[^<>\n|]{2,60}?,?\s*(?:n[º°o.]?\s*)?\d{1,5}\b[^<>\n|]{0,70}', re.I)
CONTACT_LINK = re.compile(r'''href=["']([^"'#]+)["'][^>]*>\s*(?:<[^>]+>\s*)*([^<]{0,40})''', re.I)
CONTACT_WORDS = ('contato', 'fale', 'contact', 'quem-somos', 'quem somos', 'sobre', 'expediente', 'endereco', 'endereço', 'localiza')


def norm(text: str) -> str:
    return unicodedata.normalize('NFKD', text or '').encode('ascii', 'ignore').decode().lower()


def curl(url: str, timeout: int = 15) -> str:
    try:
        out = subprocess.run(['curl', '-s', '-L', '-A', UA, '--max-time', str(timeout), url],
                             capture_output=True, timeout=timeout + 5).stdout
    except subprocess.TimeoutExpired:
        return ''
    return html.unescape(out.decode('utf-8', 'ignore'))


def plain(page: str) -> str:
    return re.sub(r'<[^>]+>', '\n', re.sub(r'<script.*?</script>|<style.*?</style>', ' ', page, flags=re.S | re.I))


def contact_pages(base: str, page: str) -> list[str]:
    host = urlparse(base).netloc
    found = []
    for href, label in CONTACT_LINK.findall(page):
        key = norm(href + ' ' + label)
        url = urljoin(base, href)
        if urlparse(url).netloc == host and any(w in key for w in CONTACT_WORDS) and url not in found:
            found.append(url)
    return found[:3]


def extract(pages: list[str], municipio: str) -> dict:
    out = {}
    for page in pages:
        text = plain(page)
        if 'telefone' not in out and (m := PHONE.search(text)):
            out['telefone'] = f'({m.group(1)}) {m.group(2)}-{m.group(3)}'
        if 'whatsapp' not in out and (m := WA.search(page)):
            out['whatsapp'] = m.group(1)
        if 'email' not in out:
            mails = [e for e in MAIL.findall(text) if not re.search(r'(sentry|example|wixpress|seudominio|dominio)', e, re.I)]
            if mails:
                out['email'] = mails[0]
        if 'endereco' not in out and norm(municipio) in norm(text):
            if m := ADDR.search(text):
                out['endereco'] = re.sub(r'\s+', ' ', m.group(0)).strip(' ,-')
    return out


def enrich(item: tuple[str, dict]) -> tuple[str, dict]:
    municipio, st = item
    home = curl(st['site'])
    if not home:
        return st['id'], {}
    pages = [home] + [curl(u) for u in contact_pages(st['site'], home)]
    found = extract(pages, municipio)
    # Só o que falta: nunca troca o que já veio de fonte melhor.
    return st['id'], {k: v for k, v in found.items() if not st.get(k)}


def main() -> None:
    data = json.loads(RADIOS.read_text(encoding='utf-8'))
    todo = [(p['nome'], s) for p in data['places'] for s in p['stations']
            if s.get('site') and not (s.get('telefone') and s.get('endereco'))]
    with cf.ThreadPoolExecutor(10) as ex:
        found = {sid: extra for sid, extra in ex.map(enrich, todo) if extra}
    previous = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
    merged = {**previous, **{k: {**previous.get(k, {}), **v} for k, v in found.items()}}
    OUT.write_text(json.dumps(merged, ensure_ascii=False, indent=1), encoding='utf-8')
    fields = [f for v in found.values() for f in v]
    print(f"{len(todo)} sites lidos; {len(found)} estações ganharam dado: "
          f"{fields.count('telefone')} telefones, {fields.count('whatsapp')} WhatsApp, "
          f"{fields.count('endereco')} endereços, {fields.count('email')} e-mails -> {OUT}")


if __name__ == '__main__':
    main()
