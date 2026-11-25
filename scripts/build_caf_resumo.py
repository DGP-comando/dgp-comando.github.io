"""Resumo da CAF para a ficha (produtos, posse, área, mão de obra, perfil) a
partir do que JÁ está no bucket privado, sem as extrações do MDA.

Lê `caf-municipios.json` e os cadastros `caf/<ibge>.json` (gerados por
scripts/build_caf.py), calcula os campos abaixo por município, regional e
estado e grava de volta só o `caf-municipios.json`. Os demais campos do
arquivo (contagens, séries, renda, painel) ficam como estão.

    produtos, n_produtos, com_producao   produtos por nº de famílias
    posse                                condição de posse (imóvel principal) e ha
    area, local_area                     média, mediana, total, faixas, localização
                                         (sem as declarações acima de HA_TETO)
    mo                                   mão de obra familiar e contratada
    escolaridade, idade_faixas           declarante

Mesmas regras de `agrega` em build_caf.py (que importa daqui as constantes e
`produto`); a área do cadastro vem com 2 casas, então a soma pode diferir do
build na casa decimal. Só biblioteca padrão: roda em qualquer máquina com a
chave do Supabase.

    SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/build_caf_resumo.py            # bucket -> bucket
    SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/build_caf_resumo.py --sem-subir
    py -3 scripts/build_caf_resumo.py --local                                  # data/privado -> data/privado

O resultado também fica em data/privado/caf-municipios.json (gitignored).
LGPD: os cadastros lidos são dado pessoal; nada deles é gravado em disco, só
os agregados.
"""
import json
import os
import re
import statistics
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SUPABASE_URL = os.environ.get('DATAGEO_SUPABASE_URL', 'https://fialxjcsgywvvuxjxcly.supabase.co')
BUCKET = 'datageo-privado'
PRIV = Path(__file__).resolve().parent.parent / 'data' / 'privado'
ARQ = 'caf-municipios.json'

# Faixas da ficha: área total da família (ha) e idade do declarante (anos); (lo, hi].
HA_FAIXAS = [('Sem área', None, 0), ('Até 5 ha', 0, 5), ('5 a 10 ha', 5, 10), ('10 a 20 ha', 10, 20),
             ('20 a 50 ha', 20, 50), ('Mais de 50 ha', 50, None)]
IDADE_FAIXAS = [('Até 29', None, 29), ('30 a 44', 29, 44), ('45 a 59', 44, 59), ('60 ou mais', 59, None)]
N_PRODUTOS = 15      # produtos listados na ficha (por nº de famílias)
# Área acima disto não é de uma família: ~0,5% das CAFs (quase todas de assentados)
# declaram o assentamento inteiro (até 68 mil ha) e somavam 83% da área do estado.
# Entre 110 e 1.000 ha quase não há declaração; a agricultura familiar vai a 4
# módulos fiscais (120 ha no PR). Essas famílias contam em `area.acima` e ficam
# fora da média, da mediana, do total, das faixas e dos hectares por posse.
HA_TETO = 500
SEM_INFO = 'Não informado'
CAMPOS = ('produtos', 'n_produtos', 'com_producao', 'posse', 'area', 'local_area', 'mo', 'escolaridade', 'idade_faixas')

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


# ------------------------------------------------------------ resumo

def _faixas(valores, cortes):
    return [{'f': nome, 'n': sum(1 for v in valores if (lo is None or v > lo) and (hi is None or v <= hi))}
            for nome, lo, hi in cortes]


def _contagem(c):
    return {k: n for k, n in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))}


def _txt(v):
    return str(v or '').strip() or SEM_INFO


def linha(fam):
    """O que o resumo usa de uma família do cadastro; None se a CAF não está ativa."""
    if fam.get('situacao') != 'ATIVA':
        return None
    areas = [(_txt(a.get('dominio')), float(a.get('area') or 0) if a.get('unidade') == 'ha' else 0.0, a)
             for a in fam.get('areas') or []]
    prin = next((a for _, _, a in areas if a.get('principal')), None)
    decl = next((m for m in fam.get('membros') or []
                 if str(m.get('parentesco') or '').startswith('Pessoa responsável')), None)
    prods = defaultdict(float)
    for p in fam.get('producao') or []:
        if p.get('dentro'):
            prods[produto(p.get('produto'))] += float(p.get('auferida') or 0)
    return {
        'prods': dict(prods),
        'dominio': _txt(prin.get('dominio')) if prin else SEM_INFO,
        'local': _txt(prin.get('localizacao')) if prin else SEM_INFO,
        'cond_ha': [(c, ha) for c, ha, _ in areas],
        'ha': sum(ha for _, ha, _ in areas),
        'acima': any(ha > HA_TETO for _, ha, _ in areas),
        'n_areas': len(areas),
        'mo_fam': float(fam.get('mo_familiar') or 0), 'mo_contr': float(fam.get('mo_contratada') or 0),
        'escol': _txt(decl.get('escolaridade')) if decl else SEM_INFO,
        'idade': decl.get('idade') if decl else None,
    }


def resumo(linhas):
    """Campos novos do agregado para as famílias ativas `linhas` (saídas de `linha`)."""
    v, n = Counter(), Counter()
    for f in linhas:
        for p, val in f['prods'].items():
            v[p] += val
            n[p] += 1
    por_n = sorted(n, key=lambda p: (-n[p], -v[p], p))
    dom, ha_cond = Counter(f['dominio'] for f in linhas), Counter()
    ok = [f for f in linhas if not f['acima']]
    for f in ok:
        for c, ha in f['cond_ha']:
            ha_cond[c] += ha
    chaves = sorted(set(dom) | {c for c, ha in ha_cond.items() if ha > 0}, key=lambda k: (-dom.get(k, 0), k))
    has = [f['ha'] for f in ok]
    com_ha = [h for h in has if h > 0]
    return {
        'produtos': [{'p': p, 'v': round(v[p]), 'n': n[p]} for p in por_n[:N_PRODUTOS]],
        'n_produtos': len(n),
        'com_producao': sum(1 for f in linhas if f['prods']),
        'posse': {'por': [{'c': k, 'n': dom.get(k, 0), 'ha': round(ha_cond.get(k, 0), 1)} for k in chaves],
                  'mista': sum(1 for f in linhas if len({c for c, _ in f['cond_ha']}) > 1)},
        'area': {'media': round(statistics.fmean(com_ha), 2) if com_ha else None,
                 'mediana': round(statistics.median(com_ha), 2) if com_ha else None,
                 'total': round(sum(has), 1), 'faixas': _faixas(has, HA_FAIXAS),
                 'multi': sum(1 for f in linhas if f['n_areas'] > 1),
                 'acima': len(linhas) - len(ok), 'teto': HA_TETO},
        'local_area': _contagem(Counter(f['local'] for f in linhas)),
        'mo': {'familiar': int(sum(f['mo_fam'] for f in linhas)), 'contratada': int(sum(f['mo_contr'] for f in linhas)),
               'com_contratada': sum(1 for f in linhas if f['mo_contr'] > 0)},
        'escolaridade': _contagem(Counter(f['escol'] for f in linhas)),
        'idade_faixas': _faixas([f['idade'] for f in linhas if f['idade'] is not None], IDADE_FAIXAS),
    }


def aplica(dados, por_ibge):
    """Grava os campos novos em cada município, regional e no estado de `dados` (caf-municipios)."""
    de = lambda ibges: [f for c in ibges for f in por_ibge.get(str(c), [])]
    for c, a in dados['municipios'].items():
        a.update(resumo(de([c])))
    for a in dados.get('regionais', {}).values():
        a.update(resumo(de(a['municipios'])))
    dados['estado'].update(resumo(de(dados['municipios'])))
    return dados


def confere(dados):
    """Ativas do cadastro x contagem já publicada: diferença indica arquivos de datas diferentes."""
    return [(c, a['caf'].get('2025-10'), sum(x['n'] for x in a['posse']['por']))
            for c, a in dados['municipios'].items()
            if a['caf'].get('2025-10') != sum(x['n'] for x in a['posse']['por'])]


# ------------------------------------------------------------ bucket / disco

def _req(caminho, key, dados=None):
    return urllib.request.Request(
        f'{SUPABASE_URL}/storage/v1/object/{BUCKET}/{caminho}', data=dados, method='POST' if dados else 'GET',
        headers={'apikey': key, 'Authorization': f'Bearer {key}',
                 **({'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'max-age=300'} if dados else {})})


def baixa(caminho, key):
    """JSON do bucket; None se o arquivo não existe (município sem família)."""
    try:
        with urllib.request.urlopen(_req(caminho, key), timeout=180) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (400, 404):
            return None
        raise


def _demo():
    assert produto('Soja em Grão - Kg') == produto('Soja') == 'Soja'
    fam = lambda **k: {'situacao': 'ATIVA', 'areas': [], 'membros': [], 'producao': [], **k}
    fs = [
        fam(areas=[{'dominio': 'Proprietário', 'area': 10, 'unidade': 'ha', 'principal': True, 'localizacao': 'Rural'},
                   {'dominio': 'Arrendatário', 'area': 4, 'unidade': 'ha', 'principal': False}],
            membros=[{'parentesco': 'Filho', 'idade': 20}, {'parentesco': 'Pessoa responsável pela UFPA', 'idade': 60, 'escolaridade': 'Analfabeto'}],
            producao=[{'dentro': True, 'produto': 'Soja em Grão - Kg', 'auferida': 1000}, {'dentro': True, 'produto': 'Soja', 'auferida': 5},
                      {'dentro': False, 'produto': 'APOSENTADORIA', 'auferida': 9}], mo_familiar=2, mo_contratada=1),
        fam(areas=[{'dominio': 'Arrendatário', 'area': 3, 'unidade': 'm²', 'principal': True, 'localizacao': ''}],
            producao=[{'dentro': True, 'produto': 'Milho', 'auferida': None}]),
        fam(areas=[{'dominio': 'Assentado', 'area': 40000, 'unidade': 'ha', 'principal': True, 'localizacao': 'Rural'}]),
        fam(situacao='INATIVA', areas=[{'dominio': 'Posseiro', 'area': 99, 'unidade': 'ha', 'principal': True}]),
    ]
    linhas = [x for x in map(linha, fs) if x]
    r = resumo(linhas)
    assert len(linhas) == 3 and r['produtos'] == [{'p': 'Soja', 'v': 1005, 'n': 1}, {'p': 'Milho', 'v': 0, 'n': 1}]
    assert r['com_producao'] == 2 and r['n_produtos'] == 2
    assert r['posse'] == {'por': [{'c': 'Arrendatário', 'n': 1, 'ha': 4.0}, {'c': 'Assentado', 'n': 1, 'ha': 0},
                                  {'c': 'Proprietário', 'n': 1, 'ha': 10.0}], 'mista': 1}
    assert r['area']['media'] == 14.0 and r['area']['total'] == 14.0 and r['area']['multi'] == 1
    assert r['area']['acima'] == 1 and r['area']['teto'] == HA_TETO  # o assentamento inteiro fica de fora
    assert [x['n'] for x in r['area']['faixas']] == [1, 0, 0, 1, 0, 0]
    assert r['local_area'] == {'Rural': 2, 'Não informado': 1} and r['mo'] == {'familiar': 2, 'contratada': 1, 'com_contratada': 1}
    assert r['escolaridade'] == {'Não informado': 2, 'Analfabeto': 1} and [x['n'] for x in r['idade_faixas']] == [0, 0, 0, 1]


def main():
    _demo()
    local, sem_subir = '--local' in sys.argv, '--sem-subir' in sys.argv
    key = None if local else (os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or sys.exit('SUPABASE_SERVICE_ROLE_KEY ausente (ou use --local)'))
    le = (lambda c: json.loads((PRIV / c).read_text(encoding='utf-8')) if (PRIV / c).exists() else None) if local \
        else (lambda c: baixa(c, key))
    dados = le(ARQ) or sys.exit(f'{ARQ} não encontrado')
    ibges = sorted(dados['municipios'])
    print(f'lendo o cadastro de {len(ibges)} municípios ({"data/privado" if local else "bucket"})...')

    def do_municipio(c):
        d = le(f'caf/{c}.json')
        return c, [x for x in map(linha, (d or {}).get('familias', {}).values()) if x], d is not None
    with ThreadPoolExecutor(8) as ex:
        lidos = list(ex.map(do_municipio, ibges))
    por_ibge = {c: linhas for c, linhas, _ in lidos}
    print(f'  {sum(1 for *_, ok in lidos if ok)} arquivos, {sum(map(len, por_ibge.values()))} famílias ativas')

    aplica(dados, por_ibge)
    dif = confere(dados)
    if dif:
        print(f'  ATENÇÃO: {len(dif)} municípios com nº de ativas diferente do publicado (ibge, publicado, cadastro): {dif[:8]}')
    e = dados['estado']
    print(f'  posse {e["posse"]}')
    print(f'  área {e["area"]} · mão de obra {e["mo"]}')
    print(f'  produtos ({e["n_produtos"]}): {[(t["p"], t["n"]) for t in e["produtos"]]}')

    corpo = json.dumps(dados, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    PRIV.mkdir(parents=True, exist_ok=True)
    (PRIV / ARQ).write_bytes(corpo)
    print(f'gravado data/privado/{ARQ} ({len(corpo) // 1024} KB)')
    if local or sem_subir:
        print('não subiu ao bucket' + ('' if local else ' (--sem-subir)') + f'; para subir: py -3 scripts/upload_privado.py {ARQ}')
        return
    with urllib.request.urlopen(_req(ARQ, key, corpo), timeout=180) as r:
        print(f'{ARQ} -> bucket, HTTP {r.status}')


if __name__ == '__main__':
    main()
