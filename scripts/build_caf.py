"""CAF (Cadastro Nacional da Agricultura Familiar) do PR: famílias, produção e renda.

Entradas (FORA do repositório, extrações do MDA entregues ao IDR):
    H:\\IDR-PARANA\\INTEL\\MDA\\2025\\...\\CAFS - PF\\ARQUIVOS   (08/10/2025, 7 CSVs)
    H:\\IDR-PARANA\\INTEL\\MDA\\CAF_DAP_2024\\IDR-PR              (23/07/2024)
    H:\\IDR-PARANA\\INTEL\\MDA\\DAP-CAF 2023                      (21/11/2023, DAP e CAF)
    H:\\IDR-PARANA\\INTEL\\MDA\\Dados CAF_DAP\\20250106.xlsx      (contagens MDA, jan/2025)

Saídas (data/privado/, gitignored, bucket privado via scripts/upload_privado.py):
    caf-pontos.json        um ponto por família (imóvel principal), leve
    caf/<ibge>.json        o cadastro COMPLETO de cada família do município (clique)
    caf-municipios.json    agregados por município, regional IDR e estado (ficha)

LGPD: o cadastro completo (CPF, nome, contato, endereço) é dado pessoal. O
usuário autorizou em 2026-10-01 o detalhe integral para o técnico localizar e
conferir o cadastro dos seus produtores; por isso SÓ vai ao bucket privado
(login + app_metadata.datageo), nunca a public/.

Comparações temporais:
  - contagem: CAF (nov/23, jul/24, jan/25, out/25) e DAP (nov/23, ago/24,
    jan/25, out/25). A alta da CAF é em grande parte migração DAP -> CAF: as
    DAPs foram prorrogadas (a validade gravada em nov/23 não vale) e, pelo
    calendário do MDA de jan/25, todas venceram até set/25. "famílias" = CAF +
    DAP cujo titular (CPF) não tinha CAF, sem dupla contagem, em nov/23 e out/25.
  - renda: jul/24 x out/25 por MEDIANA (há declarações extremas), corrigida
    pelo IPCA (variação real), no recorte inteiro e nas mesmas famílias.

Coordenadas: ~18% dos imóveis vêm fora do PR (ponto decimal perdido, sinal
trocado, lat/lon invertidas, UTM). `candidatos` tenta os consertos e fica com
o primeiro que cai no município declarado da área; sem conserto, a família
fica fora do mapa mas entra nas contagens.

    py -3 scripts/build_caf.py
"""
import json
import re
import shutil
import sys
import unicodedata
from datetime import date
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer

MDA = Path(r'H:\IDR-PARANA\INTEL\MDA')
E25 = MDA / '2025' / 'OneDrive_2025-10-08' / 'IDRPR - 55000.0099172024-47' / 'CAFS - PF' / 'ARQUIVOS'
E24 = MDA / 'CAF_DAP_2024' / 'IDR-PR'
DAP23 = MDA / 'DAP-CAF 2023' / 'DAPS ATIVAS PR 21-11-2023.xlsx'
CAF23 = MDA / 'DAP-CAF 2023' / 'CAFS ATIVOS PR 21-11-2023.xlsx'
MDA_JAN25 = MDA / 'Dados CAF_DAP' / '20250106.xlsx'

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / 'public' / 'data'
PRIV = ROOT / 'data' / 'privado'
OUT_DIR = PRIV / 'caf'
N_MUN = 399
IDR_CNPJ = '75234757000149'

REF = {'2023-11': '2023-11-21', '2024-07': '2024-07-23', '2025-01': '2025-01-06', '2025-10': '2025-10-08'}
MDA_AGO24 = MDA / 'Dados CAF_DAP' / '20240801.xlsx'
# IPCA mensal (IBGE, série SGS 433 do BCB) de ago/2024 a set/2025: leva a renda
# declarada até jul/24 ao nível de preços de out/25.
IPCA_AGO24_SET25 = [-0.02, 0.44, 0.56, 0.39, 0.52, 0.16, 1.31, 0.56, 0.43, 0.26, 0.24, 0.26, -0.11, 0.48]
IPCA = float(np.prod([1 + v / 100 for v in IPCA_AGO24_SET25]))
VENCE_DIAS = 182

# Produto principal da família (maior renda dentro do estabelecimento) -> cor no mapa.
GRUPOS = ['Soja', 'Milho', 'Leite', 'Bovinos de corte', 'Fumo', 'Hortaliças e frutas',
          'Aves e suínos', 'Outras atividades', 'Só renda de fora']
HORTI_FRUTA = {'Horticultura', 'Lavouras Permanentes', 'Floricultura'}

LAT = (22.4, 26.8)   # |lat| do PR
LON = (48.0, 54.7)   # |lon| do PR


def norm(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().upper()
    return re.sub(r'\s+', ' ', re.sub(r'[^A-Z0-9 ]', ' ', s)).strip()


def cpf(s):
    d = re.sub(r'\D', '', str(s or '')).lstrip('0')
    return d.zfill(11) if d else ''


ALIAS = {'Feijão Preto': 'Feijão', 'Feijão de Cor': 'Feijão', 'Café Arábica': 'Café',
         'Café Canephora, Robusta ou Conilon': 'Café', 'Suinocultura Não Integrada': 'Suínos',
         'Suínos - Integração': 'Suínos', 'Suinocultura Integrada Carne': 'Suínos'}


def produto(nome):
    """Catálogos antigo e novo do CAF juntos: 'Soja em Grão - Kg' == 'Soja'."""
    s = str(nome or '').strip()
    s = re.sub(r'\s*-\s*(Kg|M³|M3|Pés|Litro|Unidade|Fruto|Carne|Safrinha)$', '', s)
    s = re.sub(r'\s*\([^)]*\)', '', s)
    s = re.sub(r'\s+em (Grão|Casca|Folha Seca)\b.*$', '', s).strip()
    return ALIAS.get(s, s)


# ------------------------------------------------------------ coordenadas

def _escala(v, faixa):
    """|v| com a vírgula no lugar (perdida na digitação) e sinal sul/oeste, ou None."""
    a = abs(v)
    if not np.isfinite(a) or a == 0:
        return None
    while a >= 100:
        a /= 10
    return -a if faixa[0] <= a <= faixa[1] else None


_UTM = {z: Transformer.from_crs(f'EPSG:{z}', 'EPSG:4674', always_xy=True) for z in (31982, 31981)}


def candidatos(lat, lon):
    """(lon, lat, conserto) em ordem de preferência; o 1o é o dado como veio."""
    out = [(lon, lat, None)]
    for a, b, nome in ((lat, lon, 'escala/sinal'), (lon, lat, 'lat/lon invertidas')):
        y, x = _escala(a, LAT), _escala(b, LON)
        if y is not None and x is not None:
            out.append((x, y, nome))
    for n, e in ((lat, lon), (lon, lat)):
        if 7.0e6 <= n <= 7.6e6 and 1.0e5 <= e <= 9.0e5:
            for z, t in _UTM.items():
                x, y = t.transform(e, n)
                out.append((x, y, f'UTM {z}'))
    return out


def localiza(areas, mun_geom, pr_geom):
    """Ponto de cada família: imóvel principal primeiro, depois os demais.

    status: ok | corrigida | fora_municipio | sem_local. `conserto` diz o que
    foi feito para a família conferir.
    """
    res = {}
    areas = areas.sort_values(['nr_caf', 'principal'], ascending=[True, False])
    for caf, g in areas.groupby('nr_caf', sort=False):
        melhor = None
        for r in g.itertuples(index=False):
            poly = mun_geom.get(r.cd_municipio)
            for x, y, conserto in candidatos(r.lat, r.lon):
                if poly is not None and shapely.contains_xy(poly, x, y):
                    melhor = (x, y, 'ok' if conserto is None else 'corrigida', conserto, r.cd_municipio)
                    break
                if melhor is None and shapely.contains_xy(pr_geom, x, y):
                    melhor = (x, y, 'fora_municipio', conserto, r.cd_municipio)
            if melhor and melhor[2] != 'fora_municipio':
                break
        res[caf] = melhor or (None, None, 'sem_local', None, g.cd_municipio.iloc[0])
    return res


def _demo():
    assert _escala(-5425451619809735, LON) == -54.25451619809735
    assert _escala(25.24, LAT) == -25.24 and _escala(-15.79, LAT) is None
    c = candidatos(-53.4, -25.1)  # invertidas
    assert any(abs(x + 53.4) < 1e-9 and abs(y + 25.1) < 1e-9 for x, y, _ in c)
    x, y, _ = [k for k in candidatos(7329213.12, 270769.05) if k[2] == 'UTM 31982'][0]
    assert -54 < x < -48 and -27 < y < -22
    assert produto('Soja em Grão - Kg') == produto('Soja') == 'Soja'
    assert produto('Feijão Preto em Grão - Kg') == 'Feijão'
    assert produto('Erva-Mate (Folha Verde) - Kg') == 'Erva-Mate'
    assert cpf('1992884960') == '01992884960' and cpf('01992884960')[3:9] == '928849'


# ------------------------------------------------------------ leitura

def ler25():
    r = lambda n: pd.read_csv(E25 / n, dtype=str, keep_default_na=False, encoding='utf-8')
    dados = r('01 - DADOS_CAF.csv')
    pronaf = dados.groupby('nr_caf').ds_tipo_enquadramento_renda.apply(
        lambda s: sorted({v for v in s if v}))
    dados = dados.drop_duplicates('nr_caf').set_index('nr_caf')
    dados['pronaf'] = pronaf
    membros = r('02 - MEMBROS_FAMILIARES.csv')
    esp = r('03 - ESPECIFICACAO.csv').drop_duplicates('nr_caf').set_index('nr_caf')
    end = r('04 - ENDERECO.csv').drop_duplicates('nr_caf').set_index('nr_caf')
    areas = r('05 - AREA.csv')
    mo = r('06 - MAO_DE_OBRA.csv').drop_duplicates('nr_caf').set_index('nr_caf')
    prod = r('07 - PRODUCAO.csv')
    areas['ha'] = pd.to_numeric(areas.nr_area, errors='coerce').where(areas.ds_tipo_unidade_medida == 'ha', 0).fillna(0)
    areas['lat'] = pd.to_numeric(areas.nr_latitude, errors='coerce')
    areas['lon'] = pd.to_numeric(areas.nr_longitude, errors='coerce')
    areas['principal'] = areas.st_imovel_principal == 'true'
    for c in ('vl_renda_auferida', 'vl_renda_estimada'):
        prod[c] = pd.to_numeric(prod[c], errors='coerce').fillna(0)
    prod['dentro'] = prod.categoria_renda.str.startswith('RENDA DO')
    prod['produto'] = prod.ds_produto.map(produto)
    return dados, membros, esp, end, areas, mo, prod


def ler24():
    """jul/24: renda e área por CAF (o id longo termina no mesmo nr_caf de 2025)."""
    a = pd.read_csv(E24 / 'CAF_AREA.csv', sep=';', dtype=str, encoding='utf-8-sig')
    num = lambda s: pd.to_numeric(s.str.replace(',', '.'), errors='coerce').fillna(0)
    a['rt'], a['rd'], a['ha'] = num(a.RENDA_TOTAL), num(a.RENDA_DENTRO), num(a.TAMANHO_AREA)
    a['nr_caf'] = a.CAF.str.extract(r'(\d+)CAF$')[0].astype(int).astype(str)
    f = a.groupby('nr_caf').agg(rt=('rt', 'first'), rd=('rd', 'first'), ha=('ha', 'sum'))
    c = pd.read_csv(E24 / 'CARACTERIZAÇÃO_UFPA.csv', sep=';', dtype=str, encoding='utf-8-sig')
    c['nr_caf'] = c.CAF.str.extract(r'(\d+)CAF$')[0].astype(int).astype(str)
    f['ativa'] = c.drop_duplicates('nr_caf').set_index('nr_caf').SITUACAO_CAF.eq('ATIVO').reindex(f.index, fill_value=False)
    # Município: o do mesmo CAF em 2025; senão o ponto já cruzado com o município em 2024.
    ir = pd.read_csv(MDA / 'CAF_DAP_2024' / 'csv' / 'intersection_result.csv', dtype=str, usecols=['CAF_AREA_CAF', 'CodIbge'])
    ir['nr_caf'] = ir.CAF_AREA_CAF.str.extract(r'(\d+)CAF$')[0].astype(int).astype(str)
    f['ibge_ponto'] = ir.drop_duplicates('nr_caf').set_index('nr_caf').CodIbge
    return f


def ler_dap():
    """DAPs ativas em nov/23 (com os CPFs dos titulares, para tirar quem já tinha CAF)."""
    d = pd.read_excel(DAP23, header=2, usecols=['CPF_T1', 'CPF_T2', 'CD_MUNICIPIO'], dtype=str)
    # O MDA mascara o CPF da DAP ('***.207.919-**'): sobram os 6 dígitos do meio.
    meio = lambda s: m.group(1) + m.group(2) if (m := re.search(r'(\d{3})\.(\d{3})', str(s))) else ''
    return pd.DataFrame({'ibge': d.CD_MUNICIPIO.str[:7], 'c1': d.CPF_T1.map(meio), 'c2': d.CPF_T2.map(meio)})


def ler_dap_mda():
    """DAPs PF por município (MDA): ago/24, jan/25 e out/25 (jan/25 menos o que venceu até set/25)."""
    def pr(arq, aba):
        x = pd.read_excel(arq, sheet_name=aba, header=None)
        return x[x[0] == 'PR']
    serie = lambda df, col: pd.Series(pd.to_numeric(df[col], errors='coerce').fillna(0).astype(int).values, index=df[1].astype(str))
    ago = serie(pr(MDA_AGO24, 'DAP'), 3)
    jan = serie(pr(MDA_JAN25, 'QTD DAP PF PJ'), 3)
    v = pd.read_excel(MDA_JAN25, sheet_name='DAPS PF A VENCER', header=None)
    v = v[(v[1] == 'PR') & (v[0].astype(str) == '2025')]
    ate_set = pd.Series(v.iloc[:, 4:13].apply(pd.to_numeric, errors='coerce').fillna(0).sum(axis=1).astype(int).values,
                        index=v[2].astype(str))
    out = (jan - ate_set.reindex(jan.index, fill_value=0)).clip(lower=0)
    return pd.DataFrame({'2024-08': ago, '2025-01': jan, '2025-10': out}).fillna(0).astype(int)


def ler_caf23(nome_ibge):
    r = pd.read_excel(CAF23, sheet_name='Resumo', usecols=[1, 2])
    r.columns = ['m', 'n']
    r = r.dropna()
    s = pd.Series(r.n.astype(int).values, index=r.m.map(norm).map(nome_ibge))
    if s.index.isna().any():
        sys.exit(f'CAF nov/23: municípios sem IBGE {list(r.m[s.index.isna()])}')
    return s


def ler_mda_jan25():
    x = pd.read_excel(MDA_JAN25, sheet_name='QTD CAF PF PJ', header=None)
    pr = x[x[0] == 'PR']
    return pd.Series(pd.to_numeric(pr[6], errors='coerce').fillna(0).astype(int).values, index=pr[1].astype(str))


# ------------------------------------------------------------ família

def idade(nasc, ref):
    try:
        y, m, d = map(int, str(nasc)[:10].split('-'))
        return ref.year - y - ((ref.month, ref.day) < (m, d))
    except ValueError:
        return None


def familias(dados, membros, esp, areas, prod, ref):
    """Tabela de uma linha por família (2025), com o que os agregados usam."""
    f = pd.DataFrame(index=dados.index)
    f['ativa'] = dados.ds_situacao_unidade_familiar.eq('ATIVA')
    f['validade'] = pd.to_datetime(dados.dt_validade, errors='coerce')
    f['pronaf'] = dados.pronaf.map(lambda g: 'A' if 'A' in g else 'B' if 'B' in g else 'V' if 'V' in g else '')
    f['idr'] = dados.nr_cnpj.eq(IDR_CNPJ)
    f['caract'] = esp.nm_caracterizacao_area.reindex(f.index, fill_value='')
    f['terreno'] = esp.nm_tipo_terreno_ufpr.reindex(f.index, fill_value='')
    rd = prod[prod.dentro].groupby('nr_caf').vl_renda_auferida.sum()
    rf = prod[~prod.dentro].groupby('nr_caf').vl_renda_auferida.sum()
    f['rd'] = rd.reindex(f.index, fill_value=0)
    f['rf'] = rf.reindex(f.index, fill_value=0)
    f['rt'] = f.rd + f.rf
    f['ha'] = areas.groupby('nr_caf').ha.sum().reindex(f.index, fill_value=0)
    f['rha'] = (f.rd / f.ha).where(f.ha > 0)
    pd_ = prod[prod.dentro & (prod.vl_renda_auferida > 0)]
    f['n_prod'] = pd_.groupby('nr_caf').produto.nunique().reindex(f.index, fill_value=0)
    fora = prod[~prod.dentro]
    f['aposent'] = f.index.isin(fora[fora.ds_produto.str.contains('APOSENT|PENS', case=False)].nr_caf)
    f['bolsa'] = f.index.isin(fora[fora.ds_produto.str.contains('Bolsa Fam', case=False)].nr_caf)
    prin = areas[areas.principal].drop_duplicates('nr_caf').set_index('nr_caf')
    f['nao_prop'] = prin.ds_condicao_dominio.reindex(f.index).fillna('').ne('Proprietário')
    decl = membros[membros.nm_tipo_membro_familiar.str.startswith('Pessoa responsável')].drop_duplicates('nr_caf').set_index('nr_caf')
    f['mulher'] = decl.nm_sexo.reindex(f.index).eq('Feminino')
    f['idade'] = decl.dt_nascimento.reindex(f.index).map(lambda v: idade(v, ref))
    f['escol_baixa'] = decl.ds_tipo_escolaridade.reindex(f.index).isin(['Analfabeto', 'Até 5º Ano Incompleto'])
    f['nome'] = decl.nm_pessoa_fisica.reindex(f.index).fillna('')
    idades = membros.dt_nascimento.map(lambda v: idade(v, ref))
    f['jovens'] = membros[idades.between(16, 29)].groupby('nr_caf').size().reindex(f.index, fill_value=0)
    f['n_membros'] = membros.groupby('nr_caf').size().reindex(f.index, fill_value=0)
    # Produto principal (maior renda dentro) -> grupo de cor.
    top = pd_.sort_values('vl_renda_auferida', ascending=False).drop_duplicates('nr_caf').set_index('nr_caf')
    f['grupo'] = [grupo_de(top.loc[c] if c in top.index else None) for c in f.index]
    return f


def grupo_de(r):
    if r is None:
        return GRUPOS.index('Só renda de fora')
    p, t = r['produto'], r['ds_tipo_renda']
    for nome, chave in (('Soja', 'Soja'), ('Milho', 'Milho'), ('Fumo', 'Fumo')):
        if p == chave:
            return GRUPOS.index(nome)
    if p == 'Bovinos - Leite' or p.startswith('Leite'):
        return GRUPOS.index('Leite')
    if p == 'Bovinos - Corte':
        return GRUPOS.index('Bovinos de corte')
    if t in ('Avicultura', 'Suinocultura') or p.startswith(('Avicultura', 'Suín', 'Ovos')):
        return GRUPOS.index('Aves e suínos')
    if t in HORTI_FRUTA or 'Olericola' in p or 'frutas' in p.lower():
        return GRUPOS.index('Hortaliças e frutas')
    return GRUPOS.index('Outras atividades')


# ------------------------------------------------------------ agregados

def med(s):
    s = pd.Series(s).dropna()
    return round(float(s.median()), 2) if len(s) else None


def var(a, b):
    return round((b / a - 1) * 100, 1) if a and b is not None else None


def agrega(f, f24, prod, serie_caf, serie_dap):
    """Agregado de um recorte (município, regional ou estado). `f`/`f24`: famílias do recorte."""
    at = f[f.ativa]
    at24 = f24[f24.ativa]
    ref = pd.Timestamp(REF['2025-10'])
    renda = {
        'rt': med(at.rt), 'rd': med(at.rd), 'rha': med(at.rha), 'ha': med(at.ha),
        'rt24': med(at24.rt * IPCA), 'rd24': med(at24.rd * IPCA), 'rha24': med((at24.rd / at24.ha).where(at24.ha > 0) * IPCA),
    }
    pan = at.join(at24[['rt', 'rd', 'ha']], rsuffix='24', how='inner')
    painel = {
        'n': len(pan),
        'rt': med(pan.rt), 'rt24': med(pan.rt24 * IPCA),
        'rha': med(pan.rha), 'rha24': med((pan.rd24 / pan.ha24).where(pan.ha24 > 0) * IPCA),
    }
    for d in (renda, painel):
        d['var_rt'] = var(d.get('rt24'), d.get('rt'))
        d['var_rha'] = var(d.get('rha24'), d.get('rha'))
    renda['var_rd'] = var(renda['rd24'], renda['rd'])
    pd_ = prod[prod.nr_caf.isin(at.index) & prod.dentro]
    top = pd_.groupby('produto').agg(v=('vl_renda_auferida', 'sum'), n=('nr_caf', 'nunique')).sort_values('v', ascending=False)
    tot = float(at.rt.sum())
    n = len(at)
    cnt = lambda m: int(m.sum())
    return {
        'caf': {**serie_caf, '2024-07': len(at24), '2025-10': n},
        'dap': serie_dap,
        'inativas': int((~f.ativa).sum()),
        'vencer': cnt(at.validade.between(ref, ref + pd.Timedelta(days=VENCE_DIAS))),
        'vencidas': cnt(at.validade < ref),
        'renda': renda,
        'painel': painel,
        'fora_pct': round(float(at.rf.sum()) / tot * 100, 1) if tot else None,
        'aposent': cnt(at.aposent), 'bolsa': cnt(at.bolsa),
        'n_prod': med(at.n_prod),
        'top': [{'p': p, 'v': round(float(r.v)), 'n': int(r.n)} for p, r in top.head(5).iterrows()],
        'pronaf': {k: cnt(at.pronaf == k) for k in ('A', 'B', 'V')},
        'publico': {k: cnt(at.caract == v) for k, v in (
            ('assentados', 'Assentamento da Reforma Agrária'), ('quilombolas', 'Quilombo'),
            ('indigenas', 'Terra Indígena'), ('pncf', 'Adquirida com Crédito fundiário (PNCF)'),
            ('tradicionais', 'Demais Povos e Comunidades Tradicionais'))},
        'atividade': {k: cnt(at.terreno == v) for k, v in (
            ('pescadores', 'Pescador Artesanal'), ('extrativistas', 'Extrativista'),
            ('aquicultores', 'Aquicultor'), ('silvicultores', 'Silvicultor'))},
        'mulheres': cnt(at.mulher), 'jovens': int(at.jovens.sum()), 'membros': int(at.n_membros.sum()),
        'idade': med(at.idade), 'escol_baixa': cnt(at.escol_baixa), 'nao_prop': cnt(at.nao_prop),
        'idr': cnt(at.idr),
        'grupos': [cnt(at.grupo == i) for i in range(len(GRUPOS))],
    }


def com_familias(a, dap23):
    """CAF + DAP de titular sem CAF (sem dupla contagem). Em out/25 não há DAP PF vigente."""
    a['familias'] = {
        '2023-11': a['caf']['2023-11'] + int(dap23.sem_caf.sum()),
        '2025-10': a['caf']['2025-10'] + a['dap']['2025-10'],
    }
    return a


# ------------------------------------------------------------ cadastro completo

def num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return int(x) if x.is_integer() else round(x, 2)


def ficha_familias(ids, dados, membros, esp, end, areas, mo, prod, f, f24, loc, p99_rha):
    """Cadastro completo das famílias `ids` (um arquivo por município)."""
    ids = set(ids)
    sel = lambda df: df[df.nr_caf.isin(ids)].groupby('nr_caf')
    gm, ga, gp = sel(membros), sel(areas), sel(prod)
    ref = pd.Timestamp(REF['2025-10']).date()
    out = {}
    for caf in sorted(ids, key=int):
        d, fam = dados.loc[caf], f.loc[caf]
        e = end.loc[caf] if caf in end.index else None
        x, y, status, conserto, _ = loc.get(caf, (None, None, 'sem_local', None, None))
        alertas = []
        if status == 'corrigida':
            alertas.append(f'Coordenada corrigida automaticamente ({conserto}); conferir no cadastro')
        elif status == 'fora_municipio':
            alertas.append('Coordenada fora do município declarado da área')
        elif status == 'sem_local':
            alertas.append('Coordenada inválida no cadastro; família fora do mapa')
        if pd.notna(fam.validade):
            dias = (fam.validade.date() - ref).days
            if dias < 0:
                alertas.append('CAF vencida')
            elif dias <= VENCE_DIAS:
                alertas.append(f'CAF vence em {dias} dias')
        if fam.ha <= 0:
            alertas.append('Área total zero')
        elif pd.notna(fam.rha) and fam.rha > p99_rha:
            alertas.append('Renda por hectare muito acima do usual (conferir área e renda)')
        r24 = f24.loc[caf] if caf in f24.index else None
        out[caf] = {
            'caf': caf,
            'situacao': d.ds_situacao_unidade_familiar,
            'criacao': d.dt_criacao, 'atualizacao': d.dt_atualizacao[:10], 'validade': d.dt_validade,
            'pronaf': d.pronaf,
            'emissor': d.nm_razao_social, 'emissor_cnpj': d.nr_cnpj, 'cadastrador': d.nm_usuario,
            'terreno': fam.terreno, 'caracterizacao': fam.caract,
            'mo_familiar': num(mo.loc[caf].iloc[0]) if caf in mo.index else None,
            'mo_contratada': num(mo.loc[caf].iloc[1]) if caf in mo.index else None,
            'endereco': None if e is None else {
                'cep': e.nr_cep, 'logradouro': e.ds_logradouro, 'numero': e.nr_logradouro,
                'complemento': e.ds_complemento, 'referencia': e.ds_referencia, 'municipio': e.nm_municipio,
            },
            'membros': [] if caf not in gm.groups else [{
                'nome': m.nm_pessoa_fisica, 'nome_social': m.nm_social, 'cpf': m.nr_cpf,
                'nascimento': m.dt_nascimento, 'idade': idade(m.dt_nascimento, ref), 'sexo': m.nm_sexo,
                'parentesco': m.nm_tipo_membro_familiar, 'escolaridade': m.ds_tipo_escolaridade,
                'estado_civil': m.nm_tipo_estado_civil, 'etnia': m.nm_tipo_etnia, 'nacionalidade': m.nm_nacionalidade,
                'naturalidade': f'{m.nm_municipio}/{m.sg_uf}' if m.nm_municipio else '',
                'mae': m.nm_mae, 'documento': f'{m.nr_documento} {m.nm_emissor_orgao}/{m["sg_uf.1"]}'.strip(' /'),
                'trabalha_ufpa': m.st_trabalha_ufpr == 'true',
                'telefone': m.nr_telefone, 'tipo_telefone': m.ds_tipo_telefone,
                'email': '' if m.ds_email == 'naopossui@mail.com' else m.ds_email,
            } for _, m in gm.get_group(caf).iterrows()],
            'areas': [] if caf not in ga.groups else [{
                'tipo': a.ds_tipo_area, 'area': num(a.nr_area), 'unidade': a.ds_tipo_unidade_medida,
                'municipio': a.nm_municipio, 'localizacao': a.ds_tipo_localizacao_area,
                'dominio': a.ds_condicao_dominio, 'principal': bool(a.principal),
                'responsavel': a.nm_pessoa_fisica, 'cpf': a.nr_cpf,
                'lat': a.lat if pd.notna(a.lat) else None, 'lon': a.lon if pd.notna(a.lon) else None,
            } for _, a in ga.get_group(caf).iterrows()],
            'producao': [] if caf not in gp.groups else [{
                'dentro': bool(p.dentro), 'tipo': p.ds_tipo_renda, 'produto': p.ds_produto,
                'auferida': num(p.vl_renda_auferida), 'estimada': num(p.vl_renda_estimada),
            } for _, p in gp.get_group(caf).sort_values('vl_renda_auferida', ascending=False).iterrows()],
            'renda': {'dentro': num(fam.rd), 'fora': num(fam.rf), 'total': num(fam.rt),
                      'ha': num(fam.ha), 'por_ha': num(fam.rha) if pd.notna(fam.rha) else None},
            'renda_2024': None if r24 is None else {'total': num(r24.rt), 'dentro': num(r24.rd), 'ha': num(r24.ha)},
            'local': {'status': status, 'conserto': conserto,
                      'lon': None if x is None else round(x, 6), 'lat': None if y is None else round(y, 6)},
            'alertas': alertas,
        }
    return out


# ------------------------------------------------------------ main

def main():
    _demo()
    ref = date.fromisoformat(REF['2025-10'])
    mun = gpd.read_file(PUB / 'municipios-pr.geojson').to_crs('EPSG:4674')
    mun_geom = {str(r.CD_MUN): r.geometry.buffer(0.01) for r in mun.itertuples()}  # ~1 km de folga na divisa
    for g in mun_geom.values():
        shapely.prepare(g)
    pr_geom = shapely.union_all(list(mun_geom.values()))
    shapely.prepare(pr_geom)
    nome_ibge = {norm(r.NM_MUN): str(r.CD_MUN) for r in mun.itertuples()}
    regionais = json.loads((PUB / 'regionais-idr-pr.geojson').read_text(encoding='utf-8'))['features']

    print('lendo 2025...')
    dados, membros, esp, end, areas, mo, prod = ler25()
    print('lendo 2024, DAP e séries MDA...')
    f24 = ler24()
    dap23, dap_mda = ler_dap(), ler_dap_mda()
    caf23, caf25jan = ler_caf23(nome_ibge), ler_mda_jan25()

    print('localizando imóveis...')
    loc = localiza(areas[['nr_caf', 'principal', 'cd_municipio', 'lat', 'lon']], mun_geom, pr_geom)
    st = pd.Series({k: v[2] for k, v in loc.items()}).value_counts()
    print('  ', st.to_dict())

    f = familias(dados, membros, esp, areas, prod, ref)
    # Município da família: o da área usada no ponto (principal); sem área, o do endereço.
    f['ibge'] = pd.Series({k: v[4] for k, v in loc.items()}).reindex(f.index)
    f['ibge'] = f.ibge.fillna(end.cd_municipio.reindex(f.index))
    if f.ibge.isna().any():  # sem área nem endereço: não há onde contar nem pôr no mapa
        print(f'  {int(f.ibge.isna().sum())} famílias sem município ficam de fora')
        f = f[f.ibge.notna()]
    f24['ibge'] = f.ibge.reindex(f24.index).fillna(f24.ibge_ponto)

    # Titulares de DAP em nov/23 que já tinham CAF (criada até a data) contam uma
    # vez só. Chave: município + 6 dígitos do meio do CPF (o que a DAP mostra);
    # o miolo sozinho colidiria em ~10% dos casos, com o município é desprezível.
    ja = membros[membros.nr_caf.isin(dados.index[dados.dt_criacao <= REF['2023-11']])]
    miolo = ja.nr_cpf.map(cpf).str[3:9]
    chaves = set((ja.nr_caf.map(f.ibge) + ':' + miolo)[miolo.str.len() == 6])  # membro sem CPF não casa
    casa = lambda c: (c != '') & (dap23.ibge + ':' + c).isin(chaves)
    dap23['sem_caf'] = ~(casa(dap23.c1) | casa(dap23.c2))
    print(f'  DAP nov/23: {len(dap23)}, {int((~dap23.sem_caf).sum())} titulares já com CAF; '
          f'DAP MDA {dap_mda.sum().to_dict()}')

    def recorte(ibges):
        ibges = set(ibges)
        ff, ff24, dd = f[f.ibge.isin(ibges)], f24[f24.ibge.isin(ibges)], dap23[dap23.ibge.isin(ibges)]
        soma = lambda s: int(s.reindex(list(ibges)).fillna(0).sum())
        serie_caf = {'2023-11': soma(caf23), '2025-01': soma(caf25jan)}
        serie_dap = {'2023-11': len(dd), **{k: soma(dap_mda[k]) for k in dap_mda}}
        a = agrega(ff, ff24, prod[prod.nr_caf.isin(ff.index)], serie_caf, serie_dap)
        return com_familias(a, dd)

    print('agregando...')
    municipios = {c: recorte([c]) for c in sorted(mun_geom)}
    if len(municipios) != N_MUN:
        sys.exit(f'{len(municipios)} municípios (esperado {N_MUN})')
    regs = {r['properties']['regional']: {'municipios': sorted(r['properties']['municipios']),
                                          **recorte(r['properties']['municipios'])} for r in regionais}
    estado = recorte(mun_geom)

    PRIV.mkdir(parents=True, exist_ok=True)
    meta = {'fonte': 'MDA · CAF, extração entregue ao IDR-Paraná', 'referencia': REF['2025-10'],
            'anterior': REF['2024-07'], 'ipca': round(IPCA, 4), 'vence_dias': VENCE_DIAS, 'grupos': GRUPOS}
    dump = lambda p, o: p.write_text(json.dumps(o, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    dump(PRIV / 'caf-municipios.json', {**meta, 'estado': estado, 'municipios': municipios, 'regionais': regs})

    status_idx = ['ok', 'corrigida', 'fora_municipio']
    pontos = []
    for caf, (x, y, status, _, _) in loc.items():
        if x is None or caf not in f.index:
            continue
        r = f.loc[caf]
        pontos.append([round(x, 5), round(y, 5), int(caf), r.ibge, int(r.grupo), r.nome,
                       round(float(r.rt)), round(float(r.ha), 2), status_idx.index(status), int(not r.ativa)])
    dump(PRIV / 'caf-pontos.json', {**meta, 'status': status_idx,
                                    'campos': ['lon', 'lat', 'caf', 'ibge', 'grupo', 'nome', 'renda', 'ha', 'local', 'inativa'],
                                    'p': pontos})

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir()
    p99 = float(f.rha.quantile(0.99))
    for ibge, g in f.groupby('ibge'):
        fam = ficha_familias(g.index, dados, membros, esp, end, areas, mo, prod, f, f24, loc, p99)
        dump(OUT_DIR / f'{ibge}.json', {'ibge': ibge, 'referencia': REF['2025-10'], 'familias': fam})

    e = estado
    print(f'ref {REF["2025-10"]}: {int(f.ativa.sum())} CAFs ativas, {len(pontos)} pontos, '
          f'{len(list(OUT_DIR.iterdir()))} arquivos de município')
    print(f'  série CAF {e["caf"]} · DAP {e["dap"]} · famílias {e["familias"]}')
    print(f'  renda mediana {e["renda"]} · painel {e["painel"]}')
    print(f'  IPCA ago/24-set/25 {IPCA:.4f} · vencem em {VENCE_DIAS} d: {e["vencer"]}')


if __name__ == '__main__':
    main()
