#!/usr/bin/env python3
"""Gera public/data/municipios-info.json — dados do tooltip municipal.

Fontes (todas publicas, sem chave):
  1. Prefeito eleito 2024 + partido: JSONs oficiais de resultados do TSE
     (resultados.tse.jus.br, eleicao 619 = 1o turno; 620 = 2o turno para os
     municipios que tiveram). Mapeamento cod TSE <-> IBGE do repo
     betafcc/Municipios-Brasileiros-TSE.
  2. VBP por municipio: SEAB/DERAL via o projeto vbp-parana do Avner
     (dashboard/public/data/detailed_municipio_<ano>.json, R$ correntes),
     comparando 2024 -> 2025 (ultima informacao disponivel, igual ao
     avnergomes.github.io/vbp-parana).
  3. Cadeia lider: maior soma de valor por cadeia produtiva (26 cadeias
     SEAB, inclui pecuaria — mais completo que a PAM/IBGE) em 2025.

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
GH = Path('C:/Users/avner/OneDrive/Documentos/GitHub')
VBP_PARANA_DATA = GH / 'vbp-parana/dashboard/public/data'
VBP_ANO_A, VBP_ANO_B = 2024, 2025
# Bases do ecossistema DataGeo fora do c2 (repos irmaos, dados publicos):
SEGURANCA_CRIM = GH / 'seguranca-parana/data/processed/criminalidade.json'  # SINESP 2018-2022
POPULACAO = GH / 'saude-parana/data/raw/populacao_anos_pr.json'             # SIDRA estimativas ate 2025
NASCIDOS = GH / 'saude-parana/data/raw/nascidos_municipios_pr.json'         # SIDRA ate 2024
OBITOS = GH / 'saude-parana/data/raw/obitos_municipios_pr.json'             # SIDRA ate 2024


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

def load_vbp_local():
    """VBP SEAB/DERAL do repo vbp-parana: total por municipio nos 2 anos e
    cadeia lider (soma por cadeia) no ano mais recente. Valores em R$."""
    vbp = {}
    top = {}
    top_prod = {}
    for ano in (VBP_ANO_A, VBP_ANO_B):
        path = VBP_PARANA_DATA / f'detailed_municipio_{ano}.json'
        rows = json.loads(path.read_text(encoding='utf-8'))
        cadeia_sum = {}
        produto_sum = {}
        for row in rows:
            ibge = str(row.get('cod') or '')
            val = float(row.get('v') or 0)
            if not ibge or not val:
                continue
            vbp.setdefault(ibge, {})
            vbp[ibge][str(ano)] = vbp[ibge].get(str(ano), 0.0) + val
            if ano == VBP_ANO_B:
                key = (ibge, row.get('c') or '?')
                cadeia_sum[key] = cadeia_sum.get(key, 0.0) + val
                pkey = (ibge, row.get('n') or '?')
                produto_sum[pkey] = produto_sum.get(pkey, 0.0) + val
        if ano == VBP_ANO_B:
            por_mun = {}
            for (ibge, cadeia), total in cadeia_sum.items():
                por_mun.setdefault(ibge, []).append((cadeia, total))
            for ibge, cadeias in por_mun.items():
                cadeias.sort(key=lambda x: x[1], reverse=True)
                top[ibge] = cadeias[:1]  # cadeia lider (tooltip)
            por_mun_p = {}
            for (ibge, produto), total in produto_sum.items():
                por_mun_p.setdefault(ibge, []).append((produto, total))
            for ibge, produtos in por_mun_p.items():
                produtos.sort(key=lambda x: x[1], reverse=True)
                top_prod[ibge] = produtos[:3]  # top-3 PRODUTOS (ficha)
    return vbp, str(VBP_ANO_A), str(VBP_ANO_B), top, top_prod


def _sidra_latest(path):
    # Ultimo ano com valor por municipio num JSON estilo SIDRA (D1C/V/D3N).
    rows = json.loads(path.read_text(encoding='utf-8'))[1:]
    out = {}
    for r in rows:
        ibge = r.get('D1C')
        ano = r.get('D3N', '')
        val = r.get('V')
        if not ibge or not str(ano).isdigit() or val in ('...', '..', '-', 'X', None):
            continue
        cur = out.get(ibge)
        if cur is None or ano > cur[0]:
            out[ibge] = (ano, int(float(val)))
    return out


def load_ecossistema():
    # Bases dos repos irmaos: populacao, nascidos, obitos, seguranca.
    pop = _sidra_latest(POPULACAO)
    nasc = _sidra_latest(NASCIDOS)
    obit = _sidra_latest(OBITOS)

    crim = json.loads(SEGURANCA_CRIM.read_text(encoding='utf-8'))
    por_ano = {}
    for r in crim:
        ibge = str(r.get('cod_ibge') or '')
        ano = r.get('ano')
        if not ibge or ano is None:
            continue
        por_ano.setdefault(ibge, {})
        por_ano[ibge][ano] = por_ano[ibge].get(ano, 0) + int(r.get('vitimas') or 0)
    seguranca = {}
    for ibge, anos in por_ano.items():
        ultimo = max(anos)
        seguranca[ibge] = {
            'ano': ultimo,
            'vitimas': anos[ultimo],
            'vitimasPrev': anos.get(ultimo - 1),
        }
    return pop, nasc, obit, seguranca


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

    print('3/3 VBP SEAB/DERAL (vbp-parana local)...')
    vbp, y_prev, y_last, top, top_prod = load_vbp_local()
    pop, nasc, obit, seguranca = load_ecossistema()
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
                'valA': a, 'valB': b,  # R$ correntes
                'deltaPct': round((b - a) / a * 100, 1),
            }
        if ibge in top:
            entry['cadeia'] = top[ibge][0][0]
            entry['cadeiaValor'] = top[ibge][0][1]
        if ibge in top_prod:
            entry['produtos'] = [
                {'nome': c, 'valor': round(v, 2)} for c, v in top_prod[ibge]
            ]
        if ibge in pop:
            entry['pop'] = {'ano': pop[ibge][0], 'valor': pop[ibge][1]}
        if ibge in nasc:
            entry['nascidos'] = {'ano': nasc[ibge][0], 'valor': nasc[ibge][1]}
        if ibge in obit:
            entry['obitos'] = {'ano': obit[ibge][0], 'valor': obit[ibge][1]}
        if ibge in seguranca:
            seg = dict(seguranca[ibge])
            if ibge in pop and pop[ibge][1]:
                seg['taxa100k'] = round(seg['vitimas'] / pop[ibge][1] * 100000, 1)
            entry['seguranca'] = seg
        info[ibge] = entry

    payload = {
        'geradoEm': time.strftime('%Y-%m-%d'),
        'fontes': {
            'prefeito': 'TSE resultados oficiais 2024 (mandato 2025-2028)',
            'vbp': f'SEAB/DERAL via vbp-parana ({y_prev}->{y_last}, R$ correntes)',
            'cadeia': f'SEAB/DERAL — cadeia produtiva de maior valor em {y_last}',
            'produtos': f'SEAB/DERAL — top-3 produtos por valor em {y_last}',
            'pop': 'IBGE — populacao residente estimada (ultimo ano disponivel)',
            'vitais': 'IBGE registro civil — nascidos vivos e obitos (ultimo ano)',
            'seguranca': 'SINESP — vitimas totais por municipio (serie 2018-2022)',
        },
        'municipios': info,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'OK: {OUT} ({OUT.stat().st_size / 1024:.0f} KB, {len(info)} municipios)')


if __name__ == '__main__':
    main()
