#!/usr/bin/env python3
"""CNPJs ligados ao agro no PR, geolocalizados, com todos os campos da Receita.

Fontes (fora do repositorio):
  - F:/gestaodeater/dados-cnpj/cnpj-ater-pr-geo.csv: 85.888 estabelecimentos
    ativos do PR em CNAEs de ATER/apoio/pecuaria (scripts/scrape-cnpj-ater.py e
    geocode_cnpj_bdgeo.py de la), com lat/lon e precisao (rua, cep, municipio).
    Aqui ficam os 35,2 mil com CNAE agro (divisoes 01, 02, 03 ou credito rural
    6424703) como principal OU secundaria; os de consultoria/servico generico e
    as veterinarias sem CNAE agro ficam de fora.
  - Dados Abertos do CNPJ (Receita, jul/2026) na mesma pasta: Estabelecimentos*,
    Empresas*, Cnaes, Municipios; Naturezas, Motivos, Qualificacoes e Simples
    em RF_AUX (baixados a parte).

Pontos no mesmo lugar (centro do municipio, mesmo CEP) sao espalhados numa
espiral de girassol em volta da posicao original, so para dar clique em cada
um; a propriedade `prec` diz quao aproximada e a posicao.

Saida: data/privado/cnpj-agro-pr.json.gz (bucket datageo-privado). Dado
completo, CPF de MEI na razao social inclusive: autorizado, plataforma com
login e termo de responsabilidade.

Uso: py -3 scripts/build_cnpj_agro.py   (GESTAO_CNPJ e RF_AUX sobrescrevem)
     SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/upload_privado.py cnpj-agro
"""

import csv
import gzip
import io
import json
import math
import os
import zipfile
from collections import defaultdict
from pathlib import Path

FONTE = Path(os.environ.get('GESTAO_CNPJ', 'F:/gestaodeater/dados-cnpj'))
AUX = Path(os.environ.get('RF_AUX', FONTE))
OUT = Path(__file__).resolve().parent.parent / 'data' / 'privado' / 'cnpj-agro-pr.json.gz'

SITUACAO = {'01': 'Nula', '02': 'Ativa', '03': 'Suspensa', '04': 'Inapta', '08': 'Baixada'}
PORTE = {'00': 'Não informado', '01': 'Micro (ME)', '03': 'Pequeno (EPP)', '05': 'Demais'}
PRECISAO = ['rua', 'cep', 'municipio']

# Classe (cor no mapa) pela atividade principal.
CLASSES = [
    'Lavouras', 'Pecuária', 'Serviços de apoio agropecuário', 'Produção florestal',
    'Pesca e aquicultura', 'Crédito rural', 'Outra atividade principal (CNAE agro secundário)',
]


def eh_agro(cnae: str) -> bool:
    return cnae[:2] in ('01', '02', '03') or cnae == '6424703'


def classe(cnae: str) -> int:
    if cnae == '6424703':
        return 5
    if cnae[:2] == '02':
        return 3
    if cnae[:2] == '03':
        return 4
    if cnae[:3] == '015':
        return 1
    if cnae[:3] == '016':
        return 2
    if cnae[:2] == '01':
        return 0
    return 6


def linhas(zip_path: Path):
    """Linhas (listas) de todos os CSV do .zip da Receita (latin-1, ';')."""
    with zipfile.ZipFile(zip_path) as z:
        for nome in z.namelist():
            with z.open(nome) as fh:
                yield from csv.reader(io.TextIOWrapper(fh, encoding='latin-1', newline=''), delimiter=';')


def tabela(nome: str) -> dict[str, str]:
    p = AUX / nome if (AUX / nome).exists() else FONTE / nome
    return {r[0]: r[1].strip() for r in linhas(p) if len(r) >= 2}


def data_br(v: str) -> str:
    v = (v or '').strip()
    return f'{v[6:8]}/{v[4:6]}/{v[:4]}' if len(v) == 8 and v.isdigit() and v != '00000000' else ''


def fone(ddd: str, num: str) -> str:
    ddd, num = (ddd or '').strip(), (num or '').strip()
    # A Receita preenche telefone ausente com zeros: '(0000) 00000000'.
    if not num.strip('0'):
        return ''
    return f'({ddd}) {num}' if ddd.strip('0') else num


def capital(v: str) -> float | None:
    try:
        return float((v or '').replace('.', '').replace(',', '.'))
    except ValueError:
        return None


def girassol(lon: float, lat: float, n: int, passo_m: float = 60.0):
    """n posicoes em espiral de girassol em volta de (lon, lat); a 1a e o centro."""
    ouro = math.pi * (3 - math.sqrt(5))
    kx = 1 / (111_320 * math.cos(math.radians(lat)))
    ky = 1 / 110_540
    for i in range(n):
        r, a = passo_m * math.sqrt(i), i * ouro
        yield lon + r * math.cos(a) * kx, lat + r * math.sin(a) * ky


def main() -> None:
    geo = {}
    with open(FONTE / 'cnpj-ater-pr-geo.csv', encoding='utf-8-sig', newline='') as fh:
        for r in csv.DictReader(fh):
            sec = [c for c in (r['cnae_secundarias_alvo'] or '').split(';') if c]
            if eh_agro(r['cnae_principal']) or any(eh_agro(c) for c in sec):
                geo[r['cnpj']] = (float(r['lon']), float(r['lat']), PRECISAO.index(r['precisao']))
    print(f'{len(geo)} CNPJs agro no geocodificado')
    basicos = {c[:8] for c in geo}

    cnaes, muns = tabela('Cnaes.zip'), tabela('Municipios.zip')
    naturezas, motivos, quals = tabela('Naturezas.zip'), tabela('Motivos.zip'), tabela('Qualificacoes.zip')

    estab = {}
    for zp in sorted(FONTE.glob('Estabelecimentos*.zip')):
        for r in linhas(zp):
            if len(r) < 30 or r[19] != 'PR':
                continue
            cnpj = r[0] + r[1] + r[2]
            if cnpj in geo:
                estab[cnpj] = r
        print(f'  {zp.name}: {len(estab)} achados')
    faltam = set(geo) - set(estab)
    if faltam:
        print(f'AVISO: {len(faltam)} CNPJs do geocodificado sem estabelecimento na Receita (ficam de fora)')

    emp = {}
    for zp in sorted(FONTE.glob('Empresas*.zip')):
        for r in linhas(zp):
            if r and r[0] in basicos:
                emp[r[0]] = r
    simples = {}
    sp = AUX / 'Simples.zip'
    if sp.exists():
        for r in linhas(sp):
            if r and r[0] in basicos:
                simples[r[0]] = r
    else:
        print('AVISO: sem Simples.zip, opção pelo Simples/MEI fica vazia')

    # Pontos empilhados: mesmo lugar -> espiral.
    grupos = defaultdict(list)
    for cnpj in estab:
        lon, lat, _ = geo[cnpj]
        grupos[(round(lon, 5), round(lat, 5))].append(cnpj)
    pos = {}
    for (lon, lat), cs in grupos.items():
        for cnpj, xy in zip(sorted(cs), girassol(lon, lat, len(cs))):
            pos[cnpj] = (xy, len(cs) > 1)

    usados = set()
    p = []
    for cnpj, r in sorted(estab.items()):
        e = emp.get(r[0], [])
        s = simples.get(r[0], [])
        sec = [c for c in r[12].split(',') if c]
        usados.update([r[11], *sec])
        (lon, lat), espalhado = pos[cnpj]
        p.append({
            'x': round(lon, 6), 'y': round(lat, 6), 'prec': geo[cnpj][2], 'esp': int(espalhado), 'c': classe(r[11]),
            'cnpj': cnpj, 'razao': (e[1] if len(e) > 1 else '').strip(), 'fantasia': r[4].strip(),
            'mf': 'Matriz' if r[3] == '1' else 'Filial',
            'situacao': SITUACAO.get(r[5], r[5]), 'dtSituacao': data_br(r[6]), 'motivo': motivos.get(r[7], '') if r[7] not in ('', '00') else '',
            'inicio': data_br(r[10]), 'cnae': r[11], 'sec': sec,
            'end': ' '.join(x for x in (r[13].strip(), r[14].strip()) if x) + (f', {r[15].strip()}' if r[15].strip() else ''),
            'compl': ' '.join(r[16].split()), 'bairro': r[17].strip(), 'cep': r[18].strip(),
            'mun': muns.get(r[20], r[20]),
            'tel': [t for t in (fone(r[21], r[22]), fone(r[23], r[24])) if t], 'fax': fone(r[25], r[26]),
            'email': r[27].strip().lower(),
            'sitEspecial': r[28].strip(), 'dtSitEspecial': data_br(r[29]),
            'natureza': naturezas.get(e[2], e[2]) if len(e) > 2 else '', 'qualResp': quals.get(e[3], '') if len(e) > 3 else '',
            'capital': capital(e[4]) if len(e) > 4 else None, 'porte': PORTE.get(e[5], '') if len(e) > 5 else '',
            'enteFed': e[6].strip() if len(e) > 6 else '',
            'simples': (s[1] == 'S') if len(s) > 1 and s[1] in 'SN' and s[1] else None,
            'dtSimples': data_br(s[2]) if len(s) > 2 else '', 'dtSimplesExcl': data_br(s[3]) if len(s) > 3 else '',
            'mei': (s[4] == 'S') if len(s) > 4 and s[4] in 'SN' and s[4] else None,
            'dtMei': data_br(s[5]) if len(s) > 5 else '', 'dtMeiExcl': data_br(s[6]) if len(s) > 6 else '',
        })

    doc = {
        'fonte': 'Receita Federal · Dados Abertos do CNPJ (jul/2026) · geocodificação gestaodeater (BDGEO/CEP/município)',
        'classes': CLASSES, 'precisao': PRECISAO,
        'cnaes': {c: cnaes.get(c, '') for c in sorted(usados)},
        'p': p,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUT, 'wt', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(p)} pontos ({sum(x["esp"] for x in p)} espalhados) -> {OUT.name} {OUT.stat().st_size / 1e6:.1f} MB')


def _testes() -> None:
    assert data_br('20250710') == '10/07/2025' and data_br('00000000') == '' and data_br('') == ''
    assert fone('41', '33851125') == '(41) 33851125' and fone('41', '') == ''
    assert fone('0000', '00000000') == '' and fone('', '33851125') == '33851125'
    assert capital('120000000000,00') == 120_000_000_000.0 and capital('') is None
    assert classe('0151201') == 1 and classe('0161003') == 2 and classe('0111301') == 0
    assert classe('0230600') == 3 and classe('0322107') == 4 and classe('6424703') == 5 and classe('4623108') == 6
    pts = list(girassol(-50.0, -25.0, 3))
    assert pts[0] == (-50.0, -25.0) and all(abs(x + 50) < 0.01 and abs(y + 25) < 0.01 for x, y in pts)


if __name__ == '__main__':
    _testes()
    main()
