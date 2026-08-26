#!/usr/bin/env python3
"""Gera public/data/municipios-info.json — dados do tooltip municipal.

Fontes (todas publicas, sem chave):
  1. Prefeito eleito 2024 + partido: JSONs oficiais de resultados do TSE
     (resultados.tse.jus.br, eleicao 619 = 1o turno; 620 = 2o turno para os
     municipios que tiveram). Mapeamento cod TSE <-> IBGE do repo
     betafcc/Municipios-Brasileiros-TSE.
  2. VBP de lavouras por municipio: IBGE SIDRA tabela 5457, v215 (Valor da
     producao, Mil Reais), ultimos 2 anos DISPONIVEIS (hoje 2023 e 2024 —
     a PAM de um ano sai em setembro do ano seguinte).
  3. Principal lavoura: mesma tabela, produto (c782) de maior valor no
     ultimo ano disponivel.

Uso:  py -3 scripts/build_municipios_info.py
Saida: public/data/municipios-info.json ({ibge: {...}}, ~399 entradas).
Rodar de novo quando: TSE atualizar (cassacoes/substituicoes) ou sair nova PAM.
"""

import json
import time
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'municipios-info.json'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36'}

TSE_MAP_URL = (
    'https://raw.githubusercontent.com/betafcc/Municipios-Brasileiros-TSE/'
    'master/municipios_brasileiros_tse.csv'
)
TSE_RESULT = 'https://resultados.tse.jus.br/oficial/ele2024/{ele}/dados/pr/pr{cod}-c0011-e000{ele}-u.json'
SIDRA_TOTAL = (
    'https://apisidra.ibge.gov.br/values/t/5457/n6/in%20n3%2041/v/215/p/last%202/c782/0?formato=json'
)
SIDRA_PROD = (
    'https://apisidra.ibge.gov.br/values/t/5457/n6/in%20n3%2041/v/215/p/last%201/c782/all?formato=json'
)


def fetch(url, timeout=60, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def norm(name):
    text = unicodedata.normalize('NFD', str(name or '').lower().strip())
    return ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')


def title_pt(name):
    """ALL CAPS do TSE -> Title Case com conectivos minusculos."""
    small = {'de', 'da', 'do', 'das', 'dos', 'e', 'd'}
    words = str(name or '').lower().split()
    out = []
    for i, w in enumerate(words):
        out.append(w if (i > 0 and w in small) else w.capitalize())
    return ' '.join(out)


# ---------------------------------------------------------------------------
# 1. Prefeitos (TSE)
# ---------------------------------------------------------------------------

def load_tse_ibge_map():
    raw = fetch(TSE_MAP_URL).decode('utf-8')
    lines = raw.strip().split('\n')
    header = [h.strip() for h in lines[0].split(',')]
    i_uf = header.index('uf')
    i_tse = header.index('codigo_tse')
    i_ibge = header.index('codigo_ibge')
    out = {}
    for line in lines[1:]:
        parts = line.split(',')
        if parts[i_uf].strip().upper() != 'PR':
            continue
        out[parts[i_tse].strip().zfill(5)] = parts[i_ibge].strip()
    return out


def elected_from_result(data):
    """Extrai (nome_urna, partido) do candidato com st 'Eleito', ou None."""
    for carg in data.get('carg', []):
        for agr in carg.get('agr', []):
            for par in agr.get('par', []):
                for cand in par.get('cand', []):
                    if 'eleito' == norm(cand.get('st', '')):
                        return title_pt(cand.get('nmu')), par.get('sg', '')
    return None


def fetch_mayor(cod_tse):
    try:
        data = json.loads(fetch(TSE_RESULT.format(ele=619, cod=cod_tse), timeout=30))
        winner = elected_from_result(data)
        if winner:
            return winner
        # Sem eleito no 1o turno -> municipio teve 2o turno (eleicao 620)
        data = json.loads(fetch(TSE_RESULT.format(ele=620, cod=cod_tse), timeout=30))
        return elected_from_result(data)
    except Exception as e:
        print(f'  TSE {cod_tse}: {e}')
        return None


# ---------------------------------------------------------------------------
# 2 & 3. VBP + principal lavoura (SIDRA)
# ---------------------------------------------------------------------------

def load_sidra():
    total = json.loads(fetch(SIDRA_TOTAL, timeout=120).decode('utf-8'))[1:]
    vbp = {}
    years = set()
    for row in total:
        ibge = row['D1C']
        year = row['D3N']
        years.add(year)
        val = row['V']
        entry = vbp.setdefault(ibge, {})
        entry[year] = None if val in ('...', '..', '-', 'X') else float(val)
    y_prev, y_last = sorted(years)[-2:]

    prod = json.loads(fetch(SIDRA_PROD, timeout=180).decode('utf-8'))[1:]
    top = {}
    for row in prod:
        if row['D4C'] == '0':  # Total — ja coberto acima
            continue
        val = row['V']
        if val in ('...', '..', '-', 'X'):
            continue
        ibge = row['D1C']
        value = float(val)
        if value > top.get(ibge, (None, 0.0))[1]:
            # Nome do produto vem com sufixos tipo " (Tonelada)" as vezes — nao na 5457
            top[ibge] = (row['D4N'], value)
    return vbp, y_prev, y_last, top


# ---------------------------------------------------------------------------

def main():
    print('1/3 mapeamento TSE<->IBGE...')
    tse_map = load_tse_ibge_map()
    print(f'  {len(tse_map)} municipios PR')

    print('2/3 prefeitos eleitos 2024 (TSE)...')
    mayors = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_mayor, cod): ibge for cod, ibge in tse_map.items()}
        for fut, ibge in futures.items():
            result = fut.result()
            if result:
                mayors[ibge] = result
    print(f'  {len(mayors)} prefeitos resolvidos')

    print('3/3 SIDRA (VBP + principal lavoura)...')
    vbp, y_prev, y_last, top = load_sidra()
    print(f'  anos: {y_prev} -> {y_last}; {len(vbp)} municipios; top-produto p/ {len(top)}')

    info = {}
    for ibge in set(list(vbp.keys()) + list(mayors.keys())):
        entry = {}
        if ibge in mayors:
            entry['prefeito'], entry['partido'] = mayors[ibge]
        v = vbp.get(ibge, {})
        a, b = v.get(y_prev), v.get(y_last)
        if a and b:
            entry['vbp'] = {
                'anoA': y_prev, 'anoB': y_last,
                'valA': a, 'valB': b,  # Mil Reais
                'deltaPct': round((b - a) / a * 100, 1),
            }
        if ibge in top:
            entry['cadeia'] = top[ibge][0]
            entry['cadeiaValor'] = top[ibge][1]
        info[ibge] = entry

    payload = {
        'geradoEm': time.strftime('%Y-%m-%d'),
        'fontes': {
            'prefeito': 'TSE resultados oficiais 2024 (mandato 2025-2028)',
            'vbp': f'IBGE/SIDRA PAM t5457 v215 (valor da producao de lavouras, {y_prev}->{y_last})',
            'cadeia': f'IBGE/SIDRA PAM t5457 — lavoura de maior valor em {y_last}',
        },
        'municipios': info,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'OK: {OUT} ({OUT.stat().st_size / 1024:.0f} KB, {len(info)} municipios)')


if __name__ == '__main__':
    main()
