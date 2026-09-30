"""Indicadores de proteção social por município do PR (MDS · MI Social).

Fonte: API aberta do MI Social (SAGI/MDS), a mesma do VIS DATA 3 e do
Relatório de Informações. Sem autenticação. Só agregados municipais.

    aplicacoes.mds.gov.br/sagi/servicos/misocial?fq=sigla_uf:PR&fq=anomes_s:AAAAMM

Saída: public/data/protecao-social-pr.json
    {fonte, periodos: {grupo: 'AAAAMM'}, municipios: {ibge7: {campo: valor}}}

Cada grupo usa o mês mais recente com os 399 municípios. O PAA é acumulado
no ano: usa o último dezembro (o ano corrente fica parcial até fechar).
A API traz o código IBGE com 6 dígitos; o de 7 vem de municipios-pr.geojson.

    py -3 scripts/build_protecao_social.py
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://aplicacoes.mds.gov.br/sagi/servicos/misocial'
ROOT = Path(__file__).resolve().parent.parent
MUN = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT = ROOT / 'public' / 'data' / 'protecao-social-pr.json'
N_MUN = 399

# grupo -> (campo da API -> chave curta no JSON). O 1º campo decide o período.
GRUPOS = {
    'cadunico': {
        'cadun_qtd_familias_cadastradas_i': 'cad_familias',
        'cadun_qtd_pessoas_cadastradas_i': 'cad_pessoas',
        'cadun_qtd_familias_cadastradas_pobreza_pbf_i': 'cad_familias_pobreza',
        'populacao_estimada_ibge_ano_i': 'populacao',
    },
    'bolsa_familia': {
        'qtd_familias_beneficiarias_bolsa_familia_i': 'pbf_familias',
    },
    # Recorte por povo sai com um mês de atraso: período próprio.
    'bolsa_familia_povos': {
        'pbf_qtd_familias_indigenas_benef_i': 'pbf_indigenas',
        'pbf_qtd_familias_quilombolas_benef_i': 'pbf_quilombolas',
    },
    'fomento': {
        'formento_qtd_familias_beneficiarias_acumulado_i': 'fomento_familias',
    },
    'paa': {
        'agricultores_fornec_paa_i': 'paa_agricultores',
        'recur_pagos_agricul_paa_f': 'paa_valor',
    },
}


def get(params):
    q = urllib.parse.urlencode({'q': '*:*', 'wt': 'json', **params}, doseq=True)
    req = urllib.request.Request(f'{API}?{q}', headers={'User-Agent': 'datageo-command/1.0 (build script)'})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def periodo(grupo, campo):
    """Mês mais recente com os 399 municípios (PAA: último dezembro)."""
    d = get({'fq': ['sigla_uf:PR', f'{campo}:*'], 'rows': 0, 'facet': 'true',
             'facet.field': 'anomes_s', 'facet.mincount': 1, 'facet.limit': -1})
    v = d['facet_counts']['facet_fields']['anomes_s']
    meses = sorted(zip(v[::2], v[1::2]))
    if grupo == 'paa':
        ok = [m for m, _ in meses if m.endswith('12')]
    else:
        ok = [m for m, n in meses if n >= N_MUN]
    if not ok:
        sys.exit(f'{grupo}: nenhum período completo para {campo}')
    return ok[-1]


def ibge7_por_6():
    gj = json.loads(MUN.read_text(encoding='utf-8'))
    return {str(f['properties']['CD_MUN'])[:6]: str(f['properties']['CD_MUN']) for f in gj['features']}


def numero(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return int(n) if n.is_integer() else round(n, 2)


def main():
    cod7 = ibge7_por_6()
    municipios, periodos = {}, {}
    for grupo, campos in GRUPOS.items():
        per = periodo(grupo, next(iter(campos)))
        periodos[grupo] = per
        docs = get({'fq': ['sigla_uf:PR', f'anomes_s:{per}'], 'rows': 1000,
                    'fl': ','.join(['codigo_ibge', *campos])})['response']['docs']
        n = 0
        for d in docs:
            ibge = cod7.get(str(d.get('codigo_ibge')))
            if not ibge:
                continue
            vals = {chave: numero(d.get(campo)) for campo, chave in campos.items()}
            vals = {k: v for k, v in vals.items() if v is not None}
            if vals:
                municipios.setdefault(ibge, {}).update(vals)
                n += 1
        print(f'{grupo:14} {per}: {n} municípios')
    if len(municipios) < N_MUN:
        sys.exit(f'só {len(municipios)} municípios: API mudou? arquivo não sobrescrito')
    out = {
        'fonte': 'MDS · MI Social (SAGI)',
        'periodos': periodos,
        'municipios': dict(sorted(municipios.items())),
    }
    if OUT.exists() and json.loads(OUT.read_text(encoding='utf-8')) == out:
        print(f'sem mudança em {OUT.name}')
        return
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(municipios)} municípios -> {OUT.name}')


if __name__ == '__main__':
    main()
