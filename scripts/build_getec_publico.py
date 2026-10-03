#!/usr/bin/env python3
"""Acompanhamento do GETEC (SISATER) por município, das páginas públicas do painel.

Saída: public/data/getec-acomp-municipios.json
  {geradoEm, fonte, ano, regionais: {codigo_getec: nome},
   municipios: {ibge: {regional, publico: {existente, programado, pct_programado,
                                            atendido, pct_executado},
                       extensionistas: {n, equivalente},
                       publico_por_extensionista, publico_por_equivalente,
                       entidades_atendidas,
                       organizacoes: [{tipo, existente, programado, pct_programado,
                                       atendido, pct_executado, extensionistas,
                                       equivalente}]}}}

Fonte: http://www.idrgetec.idr.pr.gov.br/paginas/acomp_regiao.php (menu Gráficos,
sem login). Uma chamada a lista/lista_acomp_regiao.php?id=<regional> por regional;
a tabela é do ano corrente (o painel não rotula o ano). Só agregados por
município: sem dado pessoal.

Uso: py -3 scripts/build_getec_publico.py
"""

import json
import re
import sys
import unicodedata
from datetime import date
from html import unescape
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
PUB = ROOT / 'public' / 'data'
BASE = 'http://www.idrgetec.idr.pr.gov.br/'
SAIDA = PUB / 'getec-acomp-municipios.json'

CAMPOS_PRODUTOR = ['existente', 'programado', 'pct_programado', 'atendido', 'pct_executado',
                   'ext_n', 'ext_equivalente', 'publico_por_extensionista',
                   'publico_por_equivalente', 'entidades_atendidas']
CAMPOS_ORG = ['existente', 'programado', 'pct_programado', 'atendido', 'pct_executado',
              'extensionistas', 'equivalente', 'publico_por_extensionista',
              'publico_por_equivalente']


def norm(nome):
    s = unicodedata.normalize('NFKD', str(nome)).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]', '', s)


def baixar(caminho):
    with urlopen(BASE + caminho, timeout=60) as r:
        raw = r.read()
        charset = r.headers.get_content_charset()
    for enc in ([charset] if charset else []) + ['utf-8', 'latin-1']:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise RuntimeError(f'{caminho}: codificação desconhecida')


def numero(txt):
    """'1.234' -> 1234; '54,2' -> 54.2; '' -> None."""
    t = txt.strip().replace('.', '').replace(',', '.')
    if not t:
        return None
    v = float(t)
    return int(v) if v.is_integer() and ',' not in txt else v


def linhas(html):
    out = []
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.S):
        cels = [unescape(re.sub(r'<[^>]+>', '', c)).strip()
                for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', tr, re.S)]
        if cels:
            out.append(cels)
    return out


def regionais():
    html = baixar('paginas/acomp_regiao.php')
    sel = re.search(r'<select id=1[^>]*>(.*?)</select>', html, re.S)
    if not sel:
        sys.exit('acomp_regiao.php: select das regionais não encontrado')
    pares = re.findall(r'<option value="?(-?\d+)"?[^>]*>\s*([^<]+)', sel.group(1))
    return {cod: unescape(nome).strip() for cod, nome in pares if cod != '-1'}


def municipios_ibge():
    g = json.loads((PUB / 'municipios-pr.geojson').read_text(encoding='utf-8'))
    return {norm(f['properties']['NM_MUN']): str(f['properties']['CD_MUN']) for f in g['features']}


def ler_regional(cod, nome, idx):
    """Devolve {ibge: registro} de uma regional; falha em nome que não casa."""
    out = {}
    bloco_org = False  # as duas tabelas têm 11 colunas; só o cabeçalho as separa
    for cels in linhas(baixar(f'lista/lista_acomp_regiao.php?id={cod}')):
        if 'Tipo de Organização' in cels:
            bloco_org = True
        if norm(cels[0]) in ('municipios', 'existente'):
            continue
        ibge = idx.get(norm(cels[0]))
        if ibge is None:
            sys.exit(f'{nome}: município sem IBGE: {cels[0]!r}')
        reg = out.setdefault(ibge, {'regional': nome, 'organizacoes': []})
        if not bloco_org and len(cels) == 1 + len(CAMPOS_PRODUTOR):
            vals = dict(zip(CAMPOS_PRODUTOR, map(numero, cels[1:])))
            reg.update({
                'publico': {k: vals[k] for k in CAMPOS_PRODUTOR[:5]},
                'extensionistas': {'n': vals['ext_n'], 'equivalente': vals['ext_equivalente']},
                'publico_por_extensionista': vals['publico_por_extensionista'],
                'publico_por_equivalente': vals['publico_por_equivalente'],
                'entidades_atendidas': vals['entidades_atendidas'],
            })
        elif bloco_org and len(cels) == 2 + len(CAMPOS_ORG):
            reg['organizacoes'].append({'tipo': cels[1], **dict(zip(CAMPOS_ORG, map(numero, cels[2:])))})
        else:
            sys.exit(f'{nome}: linha com {len(cels)} colunas: {cels}')
    return out


def avisar_divergencia_regional(municipios):
    """O GETEC e o mapa das regionais (regionais-idr-pr.geojson) podem discordar
    sobre a regional de um município (Porto Amazonas em 2026); só avisa."""
    g = json.loads((PUB / 'regionais-idr-pr.geojson').read_text(encoding='utf-8'))
    mapa = {str(m): f['properties']['regional'] for f in g['features'] for m in f['properties']['municipios']}
    dif = [(ibge, mapa.get(ibge), r['regional']) for ibge, r in municipios.items()
           if norm(mapa.get(ibge, '')) != norm(r['regional'])]
    for ibge, mapa_reg, getec_reg in dif:
        print(f'AVISO regional divergente {ibge}: mapa={mapa_reg!r} getec={getec_reg!r}')


def main():
    regs = regionais()
    idx = municipios_ibge()
    municipios = {}
    for cod, nome in regs.items():
        parte = ler_regional(cod, nome, idx)
        print(f'{nome:28s} {len(parte):3d} municípios')
        municipios.update(parte)
    sem_publico = [m for m, r in municipios.items() if 'publico' not in r]
    if sem_publico:
        sys.exit(f'municípios só com organizações, sem linha de produtores: {sem_publico}')
    avisar_divergencia_regional(municipios)
    saida = {
        'geradoEm': date.today().isoformat(),
        'fonte': 'IDR GETEC, painel Gráficos > Organizações (acompanhamento por região)',
        'ano': date.today().year,
        'regionais': regs,
        'municipios': dict(sorted(municipios.items())),
    }
    SAIDA.write_text(json.dumps(saida, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(municipios)} municípios -> {SAIDA.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
