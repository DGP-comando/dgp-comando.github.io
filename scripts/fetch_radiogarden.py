#!/usr/bin/env python3
"""Baixa as estações do radio.garden no PR com o stream PRÓPRIO de cada emissora.

O radio.garden toca por um endereço dele (/listen/<id>/channel.mp3) que só
redireciona (302) para o servidor da emissora. Guardamos o destino desse
redirecionamento, isto é, o link que a própria rádio publica, e não o proxy
deles: o mapa toca direto da emissora. O stream é testado (Content-Type de
áudio ou cabeçalho icy-) e o site da emissora é lido para achar telefone do
estúdio, WhatsApp, e-mail e endereço.

O site do radio.garden fica atrás do Cloudflare e recusa cliente sem
user-agent de navegador; com ele, os endpoints JSON respondem normalmente.

Saída: data/radios/radiogarden-pr.json (lido por build_radios.py).

Uso:
  py -3 scripts/fetch_radiogarden.py
"""

import concurrent.futures as cf
import html
import json
import re
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'radios' / 'radiogarden-pr.json'
API = 'https://radio.garden/api/ara/content'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
PHONE = re.compile(r'\(?\b(4[1-6])\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b')  # DDDs do PR
WA = re.compile(r'(?:wa\.me/|api\.whatsapp\.com/send\?phone=|whatsapp\.com/send/?\?phone=)(\d{10,13})')
MAIL = re.compile(r'[\w.+-]+@[\w-]+\.(?:com|org|net|br)(?:\.br)?', re.I)
ADDR = re.compile(r'\b(?:Rua|R\.|Avenida|Av\.|Travessa|Rodovia|Praça|Alameda)\s[^<>\n|]{2,60}?,?\s*(?:n[º°o.]?\s*)?\d{1,5}\b[^<>\n|]{0,60}', re.I)
IG = re.compile(r'instagram\.com/([A-Za-z0-9_.]+)')
FB = re.compile(r'facebook\.com/([A-Za-z0-9_.-]+)')


def curl(args: list[str], timeout: int = 20) -> bytes:
    try:
        return subprocess.run(['curl', '-s', '-A', UA, '--max-time', str(timeout), *args],
                              capture_output=True, timeout=timeout + 5).stdout
    except subprocess.TimeoutExpired:
        return b''


def get(path: str) -> dict:
    return json.loads(curl([f'{API}/{path}']).decode('utf-8'))['data']


def redirect_target(channel_id: str) -> str:
    head = curl(['-I', f'{API}/listen/{channel_id}/channel.mp3']).decode('latin-1')
    return next((l.split(':', 1)[1].strip() for l in head.splitlines() if l.lower().startswith('location:')), '')


def stream_ok(url: str) -> bool:
    if not url:
        return False
    head = curl(['-L', '-r', '0-4000', '-D', '-', '-o', '/dev/null', url], 12).decode('latin-1').lower()
    return bool(re.search(r'content-type:\s*(audio/|application/ogg|application/(vnd\.apple\.|x-)mpegurl)', head)) or 'icy-' in head


def site_contact(url: str) -> dict:
    page = html.unescape(curl(['-L', url]).decode('utf-8', 'ignore'))
    plain = re.sub(r'<[^>]+>', '\n', re.sub(r'<script.*?</script>|<style.*?</style>', ' ', page, flags=re.S | re.I))
    ph, wa, em, ad = PHONE.search(plain), WA.search(page), MAIL.search(plain), ADDR.search(plain)
    ig, fb = IG.search(page), FB.search(page)
    return {
        'telefone': f'({ph.group(1)}) {ph.group(2)}-{ph.group(3)}' if ph else '',
        'whatsapp': wa.group(1) if wa else '',
        'email': em.group(0) if em else '',
        'endereco': re.sub(r'\s+', ' ', ad.group(0)).strip(' ,-') if ad else '',
        'instagram': f'https://instagram.com/{ig.group(1)}' if ig and ig.group(1) not in ('p', 'reel', 'explore') else '',
        'facebook': f'https://facebook.com/{fb.group(1)}' if fb and fb.group(1) not in ('sharer', 'share', 'plugins', 'tr', 'dialog') else '',
    }


def channels(place: dict) -> list[tuple[dict, dict]]:
    data = get(f"page/{place['id']}/channels")
    return [(place, it['page']) for sec in data['content'] for it in sec.get('items', [])
            if it.get('page', {}).get('type') == 'channel']


def station(pair: tuple[dict, dict]) -> dict:
    place, page = pair
    cid = page['url'].split('/')[-1]
    det = get(f'channel/{cid}')
    social = {s['platform']: s['url'] for s in det.get('social', [])}
    stream = redirect_target(cid)
    row = {'rg_id': cid, 'name': page['title'], 'city': place['title'][:-3],
           'lat': place['geo'][1], 'lon': place['geo'][0], 'website': det.get('website', ''),
           'stream': stream, 'stream_ok': stream_ok(stream)}
    found = site_contact(row['website']) if row['website'] else {}
    return {**row, **found,
            'instagram': social.get('instagram') or found.get('instagram', ''),
            'facebook': social.get('facebook') or found.get('facebook', '')}


def main() -> None:
    places = [p for p in get('places')['list'] if p['country'] == 'Brazil' and p['title'].endswith(' PR')]
    with cf.ThreadPoolExecutor(8) as ex:
        pairs = [pair for lst in ex.map(channels, places) for pair in lst]
    with cf.ThreadPoolExecutor(12) as ex:
        rows = list(ex.map(station, pairs))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"{len(places)} lugares, {len(rows)} estações, {sum(r['stream_ok'] for r in rows)} com stream no ar -> {OUT}")


if __name__ == '__main__':
    main()
