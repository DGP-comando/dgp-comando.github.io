#!/usr/bin/env python3
"""Atendimentos do SISATER/GETEC por família da CAF, lidos do banco (rede interna do IDR).

Saída: data/privado/getec-atendimentos/<ibge>.json, um por município da CAF, no
mesmo esquema de caf/<ibge>.json (o painel da família carrega só o do município;
o estado inteiro passa de 60 MB). Bucket privado: nome do técnico.
  {ibge, geradoEm, fonte, periodo:{de,ate}, nota,
   produtores: {<caf>: {n, horas, primeiro, ultimo, porAno:{<ano>:n},
        ultimos:[{data, metodo, acao, atividade, programa, tecnico}],
        nEventos, ultimoEvento}}}

Atendimento individual = linha de tb_saateind (a view `atendimento` do banco a
agrega por mês/município; aqui fica por cliente). Evento coletivo = presença do
cliente em tb_saeventocli (chave do evento: codorg + codmun + codeve) e é
contado à parte: não entra no nº de atendimentos nem nos últimos. A mesma
visita (data, método, ação, atividade, técnico) lançada para mais de um membro
da família conta uma vez, e um evento com dois membros também.

Ligação com a CAF: CPF dos membros das famílias (data/privado/caf/<ibge>.json,
de build_caf.py) == tb_sacadcli.cpfcli (só dígitos, com zeros à esquerda
repostos) -> codcli. Uma família soma os atendimentos de todos os membros.
CPF, codcli e a observação livre (observ) não são gravados.

Credenciais em .env: SISATER_DB_HOST, SISATER_DB_USUARIO, SISATER_DB_SENHA.
Uso: py -3 scripts/build_getec_atendimentos.py   (depois: build_getec_fichas.py
     e upload_privado.py getec-)
"""

import json
import os
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[1]
PRIV = ROOT / 'data' / 'privado'
SAIDA = PRIV / 'getec-atendimentos'

DATA_MIN = '2008-01-01'  # antes disso só há datas digitadas erradas (ano 25 etc.)
N_ULTIMOS = 3
LOTE = 50_000
NOTA = ('n = atendimentos individuais do SISATER (tb_saateind) da família da CAF '
        '(membros casados por CPF); a mesma visita lançada para dois membros conta '
        'uma vez. nEventos = eventos coletivos distintos com algum membro, à parte.')


def carregar_env():
    env = ROOT / '.env'
    if env.exists():
        for linha in env.read_text(encoding='utf-8').splitlines():
            m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$', linha)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip('"\'')


def conectar():
    faltam = [k for k in ('SISATER_DB_HOST', 'SISATER_DB_USUARIO', 'SISATER_DB_SENHA') if not os.environ.get(k)]
    if faltam:
        sys.exit(f'ausente no .env: {", ".join(faltam)}')
    try:
        con = psycopg2.connect(host=os.environ['SISATER_DB_HOST'], user=os.environ['SISATER_DB_USUARIO'],
                               password=os.environ['SISATER_DB_SENHA'], dbname='sisater', connect_timeout=15)
    except psycopg2.OperationalError as e:
        sys.exit(f'sem conexão com o banco do SISATER (rede do IDR?): {e}')
    con.set_client_encoding('UTF8')
    con.set_session(readonly=True)
    return con


def so_digitos_cpf(valor):
    d = re.sub(r'\D', '', valor or '')
    return d.zfill(11) if 8 <= len(d) <= 11 else None


def indice_caf():
    """(cpf 11 dígitos -> nº da CAF, nº da CAF -> ibge), dos membros das famílias."""
    idx, mun = {}, {}
    for arq in sorted((PRIV / 'caf').glob('*.json')):
        d = json.loads(arq.read_text(encoding='utf-8'))
        for fam in d.get('familias', {}).values():
            caf = fam.get('caf')
            if not caf:
                continue
            mun[str(caf)] = d['ibge']
            for m in fam.get('membros', []):
                cpf = re.sub(r'\D', '', m.get('cpf') or '')
                if len(cpf) == 11:
                    idx.setdefault(cpf, str(caf))
    return idx, mun


def clientes_por_caf(cur, idx_caf):
    """codcli -> caf, pelo CPF do cadastro de clientes do SISATER."""
    cur.execute('select codcli, cpfcli from tb_sacadcli where cpfcli is not null')
    out = {}
    for codcli, cpf in cur.fetchall():
        caf = idx_caf.get(so_digitos_cpf(cpf))
        if caf:
            out[codcli] = caf
    return out


def tabela(cur, sql):
    cur.execute(sql)
    return {k: (v or '').strip() for k, v in cur.fetchall()}


def dicionarios(cur):
    cur.execute('select s.codsub, s.nomsub, p.nompro from tb_sub s left join tb_pro p on p.codpro = s.codpro')
    sub = {k: ((a or '').strip(), (b or '').strip()) for k, a, b in cur.fetchall()}
    return {
        'mtd': tabela(cur, 'select codmtd, nommtd from tb_mtd'),
        'aca': tabela(cur, 'select codaca, nomaca from tb_aca'),
        'ext': tabela(cur, 'select codext, nomext from tb_ext'),
        'sub': sub,
    }


def novo():
    return {'n': 0, 'horas': 0.0, 'primeiro': None, 'ultimo': None, 'porAno': Counter(),
            'top': [], 'nEventos': 0, 'ultimoEvento': None, 'vistos': set(), 'eventos': set()}


def guardar_top(top, linha):
    """Mantém os N_ULTIMOS atendimentos mais recentes (lista curta, ordenada desc).

    A linha inteira é a chave de ordem: empate de data sai igual em toda rodada,
    seja qual for a ordem de leitura do banco (a query não tem ORDER BY).
    """
    chave = lambda t: (t[0], tuple(-1 if v is None else v for v in t[1:]))
    if len(top) < N_ULTIMOS or chave(linha) > chave(top[-1]):
        top.append(linha)
        top.sort(key=chave, reverse=True)
        del top[N_ULTIMOS:]


def ler_atendimentos(con, cli_caf, prod):
    cur = con.cursor(name='ateind')
    cur.itersize = LOTE
    cur.execute('select codcli, datate, codmtd, codaca, codsub, codext, horas from tb_saateind '
                'where datate between %s and current_date', (DATA_MIN,))
    lidas = 0
    for codcli, dt, mtd, aca, sub, ext, horas in cur:
        lidas += 1
        caf = cli_caf.get(codcli)
        if not caf:
            continue
        p = prod.setdefault(caf, novo())
        visita = (dt, mtd, aca, sub, ext)
        if visita in p['vistos']:
            continue  # mesma visita lançada para outro membro (ou cadastro duplicado)
        p['vistos'].add(visita)
        p['n'] += 1
        p['horas'] += float(horas or 0)
        p['porAno'][dt.year] += 1
        p['primeiro'] = dt if p['primeiro'] is None or dt < p['primeiro'] else p['primeiro']
        p['ultimo'] = dt if p['ultimo'] is None or dt > p['ultimo'] else p['ultimo']
        guardar_top(p['top'], visita)
    cur.close()
    return lidas


def ler_eventos(con, cli_caf, prod):
    cur = con.cursor(name='evecli')
    cur.itersize = LOTE
    cur.execute('select ec.codcli, e.codorg, e.codmun, e.codeve, e.dateve from tb_saeventocli ec join tb_saevento e '
                'on e.codorg = ec.codorg and e.codmun = ec.codmun and e.codeve = ec.codeve '
                'where e.dateve between %s and current_date', (DATA_MIN,))
    for codcli, org, mun, eve, dt in cur:
        caf = cli_caf.get(codcli)
        if not caf:
            continue
        p = prod.setdefault(caf, novo())
        if (org, mun, eve) in p['eventos']:
            continue  # dois membros da família no mesmo evento
        p['eventos'].add((org, mun, eve))
        p['nEventos'] += 1
        p['ultimoEvento'] = dt if p['ultimoEvento'] is None or dt > p['ultimoEvento'] else p['ultimoEvento']
    cur.close()


def finalizar(p, dic):
    iso = lambda d: d.isoformat() if d else None
    ultimos = []
    for dt, mtd, aca, sub, ext in p['top']:
        atividade, programa = dic['sub'].get(sub, ('', ''))
        ultimos.append({'data': iso(dt), 'metodo': dic['mtd'].get(mtd, ''), 'acao': dic['aca'].get(aca, ''),
                        'atividade': atividade, 'programa': programa, 'tecnico': dic['ext'].get(ext, '')})
    return {'n': p['n'], 'horas': round(p['horas'], 1), 'primeiro': iso(p['primeiro']), 'ultimo': iso(p['ultimo']),
            'porAno': {str(a): k for a, k in sorted(p['porAno'].items())}, 'ultimos': ultimos,
            'nEventos': p['nEventos'], 'ultimoEvento': iso(p['ultimoEvento'])}


def main():
    carregar_env()
    idx_caf, caf_ibge = indice_caf()
    print(f'{len(idx_caf)} CPFs na CAF', flush=True)
    con = conectar()
    try:
        cur = con.cursor()
        cli_caf = clientes_por_caf(cur, idx_caf)
        print(f'{len(cli_caf)} clientes do SISATER casados com família da CAF', flush=True)
        dic = dicionarios(cur)
        cur.close()
        prod = {}
        lidas = ler_atendimentos(con, cli_caf, prod)
        print(f'{lidas} atendimentos lidos', flush=True)
        ler_eventos(con, cli_caf, prod)
    finally:
        con.close()

    if not cli_caf or not prod:
        sys.exit('nenhum cliente/atendimento casado com a CAF: nada gravado (arquivos anteriores mantidos)')
    saida = {caf: finalizar(p, dic) for caf, p in prod.items()}
    datas = [p['ultimo'] for p in saida.values() if p['ultimo']]
    cab = {'geradoEm': date.today().isoformat(),
           'fonte': 'IDR-Paraná · SISATER/GETEC (banco, tb_saateind e tb_saeventocli)',
           'periodo': {'de': DATA_MIN, 'ate': max(datas) if datas else None}, 'nota': NOTA}
    gravar_por_municipio(saida, caf_ibge, cab)
    com_ate = sum(1 for p in saida.values() if p['n'])
    print(f'famílias com atendimento: {com_ate} · só evento: {len(saida) - com_ate}')


def gravar_por_municipio(saida, caf_ibge, cab):
    por_mun = {}
    for caf in sorted(saida, key=lambda c: (len(c), c)):
        por_mun.setdefault(caf_ibge[caf], {})[caf] = saida[caf]
    SAIDA.mkdir(parents=True, exist_ok=True)
    total = 0
    for ibge, produtores in sorted(por_mun.items()):
        arq = SAIDA / f'{ibge}.json'
        tmp = arq.with_suffix('.json.tmp')
        tmp.write_text(json.dumps({'ibge': ibge, **cab, 'produtores': produtores},
                                  ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        os.replace(tmp, arq)  # arquivo do município nunca fica pela metade
        total += arq.stat().st_size
    # Só depois de gravar tudo: município que saiu da CAF perde o arquivo local
    # (no bucket fica até ser apagado à mão).
    removidos = sorted(v.stem for v in SAIDA.glob('*.json') if v.stem not in por_mun)
    for ibge in removidos:
        (SAIDA / f'{ibge}.json').unlink()
    print(f'{len(por_mun)} municípios -> {SAIDA.relative_to(ROOT)}/<ibge>.json ({total // 1024} KB no total)'
          + (f'; removidos localmente (apagar no bucket): {", ".join(removidos)}' if removidos else ''))

if __name__ == '__main__':
    main()
