#!/usr/bin/env python3
"""Gera as camadas do grupo "Defesa Agropecuária" a partir dos cadastros da ADAPAR.

Fonte: CSVs exportados dos painéis da ADAPAR (UTF-8 com BOM, separador ';'),
uma pasta só (padrão: ~/Downloads/adapar; outra pasta como 1º argumento):
  - explorações+ativas.csv: propriedades com exploração pecuária ativa, uma
    linha por produtor x propriedade x DAP/CAF (333,8 mil linhas em out/2026).
  - comerciantes_veterinarios_ativos*.csv, comercio_de_animais_vivos_ativos.csv,
    comerciantes_agrotoxicos_ativos.csv, comerciantes_de_fertilizantes_ativos.csv,
    unidades_de_consolidação.csv e gipo_industrias_produtos_animais.csv:
    estabelecimentos registrados, uma linha por estabelecimento x
    produto/praga/processo/portaria. O export das indústrias de produtos de
    origem animal (out/2026) veio sem a longitude: todas ficam no centro do
    município até um export completo. Unidade de Consolidação (UC) é o
    local de beneficiamento, processamento, embalagem ou armazenamento de
    produtos vegetais vindos de uma ou mais unidades de produção.

Coordenada: 7 dígitos GGMMSSs sem sinal (2336081 = 23°36'08,1" S), conferida
contra o município declarado (99,7% das propriedades conferem). Estabelecimento
sem coordenada vai para o centro do município, aberto em anel para não
empilhar, e a checagem diz isso (nenhum deles tem coordenada em outro cadastro
da ADAPAR pelo mesmo CNPJ: conferido em out/2026). Propriedade sem coordenada
fica fora do mapa (só na contagem `sem_coordenada`).

Registro com Situação "Inativo" fica de fora (os arquivos de fertilizantes e
de UCs trazem também os inativos).

LGPD: produtor + coordenada da propriedade é dado pessoal; o CPF não sai no
arquivo (CPF de estabelecimento sai mascarado). O cadastro tem CPF digitado
dentro do nome do produtor, da propriedade e da razão social (MEI):
sem_documento() tira. Saída só em data/privado/
(bucket datageo-privado):
  adapar-exploracoes.json.gz         um ponto por propriedade (linhas compactas;
                                     gzip: 22 MB viram 6 MB, o front descomprime)
  adapar-<cadastro>-pr.geojson       um ponto por estabelecimento

Uso:
  py -3 scripts/build_adapar.py [pasta]
  SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/upload_privado.py adapar-
"""

import csv
import gzip
import html
import json
import math
import re
import sys
from datetime import date
from pathlib import Path

import numpy as np
import shapely

from build_urs_programas import OK, PRIV, Base, feature, write

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / 'Downloads' / 'adapar'
EXPLORACOES = 'explora*ativas*.csv'
GRUPOS_DAP = ['DAP/CAF ativa', 'DAP/CAF inativa', 'Sem DAP/CAF informada']
MAX_NOMES = 6
AREA_MAX_HA = 100_000  # acima disso é erro de digitação (há 9,5 trilhões de ha no cadastro)
APROXIMADO = 'sem coordenada no cadastro: ponto aproximado, no centro do município'

# arquivo de saída -> (glob do CSV, coluna do CNPJ, {prop: coluna fixa}, {prop: coluna que vira lista})
ESTABELECIMENTOS = {
    'adapar-veterinarios-pr.geojson': (
        'comerciantes_veterinarios*.csv', 'CnpjCpf',
        {'Categoria': 'Categoria Produtos', 'Validade do registro': 'Validade Registro'},
        {'Farmacêuticos': 'Farmacêutico', 'Produtos biológicos': 'Produto Biológico', 'Animais vivos': 'Espécie Animal'}),
    'adapar-animais-vivos-pr.geojson': (
        'comercio_de_animais_vivos*.csv', 'CNPJ', {}, {'Espécies': 'Espécie Animal'}),
    'adapar-agrotoxicos-pr.geojson': (
        'comerciantes_agrotoxicos*.csv', 'CnpjCpf', {'Validade do registro': 'Validade Registro'},
        {'Categorias': 'Categoria', 'Serviços': 'Subcategoria'}),
    'adapar-fertilizantes-pr.geojson': (
        'comerciantes_de_fertilizantes*.csv', 'CnpjCpf',
        {'Validade do registro': 'Validade Registro', 'Granel': 'Granel', 'Embalado': 'Embalado',
         'Armazenagem a céu aberto': 'Arm. Céu Aberto', 'Produto': 'Fertilizante'}, {}),
    'adapar-unidades-consolidacao-pr.geojson': (
        'unidades_de_consolida*.csv', 'CNPJ', {'Validade do registro': 'Validade'},
        {'Pragas': 'Praga', 'Responsáveis técnicos': 'Responsável Técnico'}),
    'adapar-industrias-poa-pr.geojson': (
        'gipo*industrias*.csv', 'CNPJ', {},
        {'Portarias': 'Portaria', 'Profissionais vinculados': 'Profissional Vinculado'}),
}


def dms(v: str) -> float | None:
    """'2336081' (GGMMSSs, sem sinal) -> 23.60225; None se vazio ou inválido."""
    v = (v or '').strip()
    if not re.fullmatch(r'\d{7}', v):
        return None
    g, m, s = int(v[:2]), int(v[2:4]), int(v[4:]) / 10
    return g + m / 60 + s / 3600 if m < 60 and s < 60 else None


def _utf8(m: re.Match) -> str:
    try:
        return m.group().encode('cp1252').decode('utf-8')
    except UnicodeError:
        return m.group()


def limpo(v: str | None) -> str:
    """Célula sem espaços nas pontas; '-' e 'N/A' são vazio.

    Conserta o que já vem quebrado da origem: 'CONCEIÃ§Ã&pound;O' (UTF-8 lido
    como cp1252, com entidade HTML) -> 'CONCEIçãO'.
    """
    s = re.sub(r'Ã[\x80-\xbf\u0152-\u2122]', _utf8, html.unescape(v or ''))
    s = re.sub(r'\s+', ' ', s).strip()
    return '' if s in ('-', 'N/A') else s


# CPF ou CNPJ digitado num campo de texto: pontuado (ou só com o traço) ou
# qualquer sequência de 8+ dígitos (CPF sem o zero à esquerda, matrícula: num
# nome, nada disso deve sair). Espaço não separa grupo: "LOTES 116 122 124 125"
# é lista de lotes.
DOCUMENTO = re.compile(r'\(?\s*(?:\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}|\d{8,})\s*\)?')


def sem_documento(v: str | None) -> str:
    """Nome sem o CPF/CNPJ que veio junto: 'FULANO 12345678901' -> 'FULANO'."""
    return limpo(DOCUMENTO.sub(' ', v or ''))


def documento(v: str) -> str:
    """CNPJ pontuado; CPF (pessoa física) mascarado, só os 6 dígitos do meio."""
    d = re.sub(r'\D', '', v or '')
    if len(d) == 14:
        return f'{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}'
    return f'***.{d[3:6]}.{d[6:9]}-**' if len(d) == 11 else ''


def validade(v: str) -> str:
    """'11/11/2025' como veio; data impossível ('01/12/4294966894') vira vazio."""
    m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4,})', limpo(v))
    return m.group(0) if m and 1990 <= int(m.group(3)) <= 2100 else ''


def area_ha(v: str) -> float | None:
    """'1.234,56' -> 1234.56; zero ou absurdo -> None."""
    try:
        a = float(limpo(v).replace('.', '').replace(',', '.'))
    except ValueError:
        return None
    return round(a, 2) if 0 < a <= AREA_MAX_HA else None


def nomes(lista: list[str]) -> str:
    """Até MAX_NOMES nomes; o resto vira 'e mais N'."""
    resto = len(lista) - MAX_NOMES
    return '; '.join(lista[:MAX_NOMES]) + (f' e mais {resto}' if resto > 0 else '')


def pragas(itens: list[str]) -> list[str]:
    """'X' e 'X - nome comum' são a mesma praga: fica 'X (nome comum)'; 'X - X' vira 'X'."""
    por_cientifico: dict[str, str] = {}
    for item in itens:
        cient, _, comum = item.partition(' - ')
        if cient not in por_cientifico or (comum and comum != cient):
            por_cientifico[cient] = f'{cient} ({comum})' if comum and comum != cient else cient
    return list(por_cientifico.values())


# Limpeza das colunas que viram lista e grafia de valores fixos.
LISTA_LIMPA = {
    'Pragas': pragas,
    'Categorias': lambda itens: [i.replace(' de Agrotóxico', '') for i in itens],
    'Portarias': lambda itens: [i for i in itens if i != '00/00'],
}
GRAFIA = {'CALCARIO': 'Calcário'}


def regional(v: str, base: Base) -> str:
    """'ER DE UNIÃO DA VITÓRIA' -> 'União da Vitória' (grafia do IBGE quando é município)."""
    nome = re.sub(r'^(ER|EL) DE ', '', limpo(v))
    mun = base.municipio(nome)
    return mun[1] if mun else nome.title()


def ler(padrao: str) -> tuple[Path, list[dict]]:
    """O CSV mais recente que casa com o padrão."""
    arqs = sorted(SRC.glob(padrao), key=lambda p: p.stat().st_mtime)
    if not arqs:
        sys.exit(f'falta {padrao} em {SRC}')
    with open(arqs[-1], encoding='utf-8-sig', newline='') as fh:
        return arqs[-1], list(csv.DictReader(fh, delimiter=';'))


def _demo() -> None:
    assert abs(dms('2336081') - 23.60225) < 1e-9 and abs(dms('5125236') - 51.42322) < 1e-5
    assert dms('-') is None and dms('       ') is None and dms('2361000') is None and dms('2336600') is None
    assert limpo('CONCEIÃ§Ã&pound;O') == 'CONCEIçãO' and limpo('SÃO JOÃO') == 'SÃO JOÃO'
    assert limpo(' - ') == '' and limpo('N/A') == '' and limpo('SÃO  JOSÉ ') == 'SÃO JOSÉ'
    assert sem_documento('FULANO DE TAL 12345678901') == 'FULANO DE TAL' and sem_documento('12345678901') == ''
    assert sem_documento('FULANA LTDA (123.456.789-01)') == 'FULANA LTDA' and sem_documento('LT 23D GL 4') == 'LT 23D GL 4'
    for caso in ('X 123456789-01', 'X 1234567890', 'X (78690136)', 'X 11.222.333/0001-81', 'X 11222333/0001-81'):
        assert sem_documento(caso) == 'X', caso
    assert sem_documento('LOTES 116 122 124 125 126 GL 1234567') == 'LOTES 116 122 124 125 126 GL 1234567'
    assert documento('11222333000181') == '11.222.333/0001-81'
    assert documento('12345678901') == '***.456.789-**' and documento('-') == ''
    assert validade('11/11/2025') == '11/11/2025' and validade('01/12/4294966894') == '' and validade('-') == ''
    assert area_ha('1.234,56') == 1234.56 and area_ha('0,00') is None and area_ha('9501730000000,00') is None
    assert pragas(['Sirex noctilio', 'Sirex noctilio - Vespa-da-madeira', 'A - A', 'B - b', 'B']) == [
        'Sirex noctilio (Vespa-da-madeira)', 'A', 'B (b)']
    assert nomes(['A', 'B']) == 'A; B' and nomes([str(i) for i in range(8)]).endswith('5 e mais 2')


# ------------------------------------------------------------ propriedades

def build_exploracoes(base: Base, ref: str) -> None:
    arq, linhas = ler(EXPLORACOES)
    props: dict[tuple, dict] = {}
    for r in linhas:
        k = (r['Município'], r['Propriedade'], r['Latitude'], r['Longitude'])
        p = props.setdefault(k, {'produtores': {}, 'dap': set(), 'area': None})
        p['area'] = p['area'] or area_ha(r['Area'])  # a primeira área válida das linhas da propriedade
        if sem_documento(r['Produtor']) and r['Produtor Situação'] == 'Ativo':
            p['produtores'][sem_documento(r['Produtor'])] = True
        p['dap'].add(r['pronaf situação'])

    ibges = {m: base.municipio(m) for m in {k[0] for k in props}}
    sem_mun = sorted(m for m, v in ibges.items() if not v)
    if sem_mun:
        sys.exit(f'municípios sem correspondência no IBGE: {sem_mun}')
    municipios = sorted({v for v in ibges.values()})
    idx = {cod: i for i, (cod, _) in enumerate(municipios)}

    por_mun: dict[str, list] = {}
    sem_coord = 0
    for (mun, nome, la, lo), p in props.items():
        lat, lon = dms(la), dms(lo)
        if lat is None or lon is None:
            sem_coord += 1
            continue
        grupo = 0 if 'Ativo' in p['dap'] else 1 if 'Inativo' in p['dap'] else 2
        prods = list(p['produtores'])
        por_mun.setdefault(ibges[mun][0], []).append(
            [round(-lon, 5), round(-lat, 5), grupo, p['area'], sem_documento(nome), len(prods), nomes(prods)])

    pontos, fora_pr = [], 0
    for cod in sorted(por_mun):
        rows = por_mun[cod]
        xs, ys = np.array([r[0] for r in rows]), np.array([r[1] for r in rows])
        no_mun = shapely.contains_xy(base.geom[cod].buffer(0.01), xs, ys)  # ~1 km de folga na divisa
        no_pr = shapely.contains_xy(base.pr, xs, ys)
        fora_pr += int((~no_pr).sum())
        pontos += [[r[0], r[1], idx[cod], r[2], int(not dentro), *r[3:]]
                   for r, dentro, pr in zip(rows, no_mun, no_pr) if pr]

    out = PRIV / 'adapar-exploracoes.json.gz'
    out.write_bytes(gzip.compress(json.dumps({
        'fonte': 'ADAPAR · propriedades com exploração pecuária ativa', 'referencia': ref,
        'grupos': GRUPOS_DAP, 'municipios': municipios,
        'campos': ['lon', 'lat', 'municipio', 'grupo', 'fora', 'ha', 'propriedade', 'n_produtores', 'produtores'],
        'sem_coordenada': sem_coord, 'p': pontos,
    }, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'), mtime=0))
    fora = sum(p[4] for p in pontos)
    por_grupo = [sum(1 for p in pontos if p[3] == g) for g in range(len(GRUPOS_DAP))]
    print(f'{out.name} ({arq.name}): {len(linhas)} linhas, {len(props)} propriedades, {len(pontos)} no mapa '
          f'({fora} fora do município declarado, {100 - fora * 100 / len(pontos):.1f}% conferem), '
          f'{sem_coord} sem coordenada, {fora_pr} fora do PR, grupos {dict(zip(GRUPOS_DAP, por_grupo))}, '
          f'{out.stat().st_size / 1e6:.1f} MB')


# -------------------------------------------------------- estabelecimentos

def espalha(feats: list[dict]) -> None:
    """Pontos no centro do mesmo município: anel de >= ~300 m, ~60 m entre vizinhos."""
    por_mun: dict[str, list] = {}
    for f in feats:
        if f['properties']['Checagem da coordenada'] == APROXIMADO:
            por_mun.setdefault(f['properties']['ibge'], []).append(f)
    for grupo in por_mun.values():
        if len(grupo) < 2:
            continue
        raio = max(0.003, len(grupo) * 0.0006 / (2 * math.pi))
        for i, f in enumerate(grupo):
            a = 2 * math.pi * i / len(grupo)
            x, y = f['geometry']['coordinates']
            f['geometry']['coordinates'] = [round(x + raio * math.cos(a), 5), round(y + raio * math.sin(a), 5)]


def build_estabelecimentos(base: Base) -> None:
    for saida, (padrao, col, fixos, listas) in ESTABELECIMENTOS.items():
        arq, linhas = ler(padrao)
        grupos: dict[tuple, list] = {}
        inativos = set()
        for r in linhas:
            if not limpo(r[col]):
                continue
            k = (r[col], r['Município'])
            # GIPOA: linhas de coordenada vêm sem situação e são do mesmo estabelecimento ativo.
            if limpo(r.get('Situação')).casefold().startswith('inativ'):
                inativos.add(k)
                continue
            grupos.setdefault(k, []).append(r)
        feats = []
        for (doc, mun), rows in grupos.items():
            r = rows[0]
            achado = next(((dms(x['Latitude']), dms(x['Longitude'])) for x in rows
                           if dms(x['Latitude']) is not None and dms(x['Longitude']) is not None), None)
            lat, lon = (f'{-achado[0]:.6f}', f'{-achado[1]:.6f}') if achado else ('', '')
            x, y, local = base.ponto(lat, lon, mun)
            if not achado:
                local['Checagem da coordenada'] = APROXIMADO
            endereco = ', '.join(v for v in (sem_documento(r.get('Logradouro')), limpo(r.get('Numero')),
                                             sem_documento(r.get('Complemento')), sem_documento(r.get('Bairro'))) if v)
            feats.append(feature(x, y, {
                'Razão social': sem_documento(r['Razão Social']), 'CNPJ': documento(doc), 'Estabelecimento': limpo(r.get('CE')),
                **local, 'Regional ADAPAR': regional(r['URS'], base), 'Unidade local': regional(r['ULSA'], base),
                'Endereço': endereco, 'Telefone': limpo(r.get('Telefone')), 'E-mail': limpo(r.get('Email')).lower(),
                **{p: (validade(r[c]) if p.startswith('Validade') else GRAFIA.get(limpo(r[c]), limpo(r[c])))
                   for p, c in fixos.items()},
                **{p: ' · '.join(LISTA_LIMPA.get(p, list)(list(dict.fromkeys(
                    sem_documento(x[c]) for x in rows if sem_documento(x[c]))))) for p, c in listas.items()},
            }))
        espalha(feats)
        aprox = sum(1 for f in feats if f['properties']['Checagem da coordenada'] == APROXIMADO)
        fora = sum(1 for f in feats if f['properties']['Checagem da coordenada'] not in (OK, APROXIMADO))
        print(f'  {arq.name}: {len(linhas)} linhas, {len(inativos - set(grupos))} estabelecimentos inativos fora, '
              f'{aprox} sem coordenada (centro do município), '
              f'{fora} fora do município declarado')
        write(saida, feats)


def main() -> None:
    _demo()
    PRIV.mkdir(parents=True, exist_ok=True)
    csvs = sorted(SRC.glob('*.csv'))
    if not csvs:
        sys.exit(f'nenhum CSV em {SRC}')
    usados = {a for p in [EXPLORACOES, *(s[0] for s in ESTABELECIMENTOS.values())] for a in SRC.glob(p)}
    for sobra in sorted(set(csvs) - usados):
        print(f'AVISO: {sobra.name} não tem camada (acrescentar em ESTABELECIMENTOS)')
    ref = date.fromtimestamp(max(p.stat().st_mtime for p in usados)).isoformat()
    base = Base()
    build_estabelecimentos(base)
    build_exploracoes(base, ref)


if __name__ == '__main__':
    main()
