#!/usr/bin/env python3
"""Grupos de assistidos do GETEC (SISATER) por extensionista, com o ponto da família no CAF.

Saída: data/privado/getec-grupos.json (bucket privado: nomes de produtores)
  {geradoEm, ano, fonte,
   extensionistas: {<id SisPont>: {nome, grupos: [{nome, projeto,
        clientes: [{nome, ibge, municipio, categoria, ativo, caf, lon, lat}]}]}}}

Fonte: relatório "Lista de assistidos por extensionista" do GETEC (PDF, um por
extensionista, ano corrente), com login. O CPF do relatório só serve para casar
com os membros das famílias da CAF (data/privado/caf/<ibge>.json, de
build_caf.py) e trazer nº da CAF e coordenada; não é gravado. Cliente sem CAF
fica na lista sem ponto. A chave do extensionista é o código do GETEC, que é o
`id` do SisPont em servidores-idr.json.

Credenciais em .env: GETEC_USUARIO (matrícula) e GETEC_SENHA.
Uso: py -3 scripts/build_getec_grupos.py [--limite N]   (depois: upload_privado.py getec-)
"""

import io
import json
import os
import re
import sys
import time
import unicodedata
from datetime import date
from html import unescape
from pathlib import Path

import requests
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
PUB = ROOT / 'public' / 'data'
PRIV = ROOT / 'data' / 'privado'
SAIDA = PRIV / 'getec-grupos.json'
BASE = 'http://www.idrgetec.idr.pr.gov.br/'

RE_GRUPO = re.compile(r'^Grupo (.+?)\s+Projeto (.+?)\s*$')
RE_CLIENTE = re.compile(r'^(\d+) (.+?)\s{2,}(.+?)\s{2,}(\d{3}\.\d{3}\.\d{3}-\d{2}) (Ativo|Inativo)\s*$')
RE_ANO = re.compile(r'no ano de (\d{4})')


def norm(nome):
    s = unicodedata.normalize('NFKD', str(nome)).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]', '', s)


def carregar_env():
    env = ROOT / '.env'
    if env.exists():
        for linha in env.read_text(encoding='utf-8').splitlines():
            m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$', linha)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip('"\'')


def entrar():
    usuario = os.environ.get('GETEC_USUARIO') or sys.exit('GETEC_USUARIO ausente no .env')
    senha = os.environ.get('GETEC_SENHA') or sys.exit('GETEC_SENHA ausente no .env')
    # Mesmo caminho do login.php: autentica.php valida (0 = ok) e o form vai
    # para seglogin.php, que é quem abre a sessão.
    s = requests.Session()
    s.get(BASE + 'login.php', timeout=60)
    r = s.get(BASE + 'autentica.php', params={'id': f'{usuario},{senha},,0'}, timeout=60)
    if r.text.strip() not in ('0', '15'):
        sys.exit(f'login no GETEC recusado (código {r.text.strip()}): 1 usuário, 2 senha, 9 trocar senha')
    s.post(BASE + 'seglogin.php', data={'usuario': usuario, 'pass': senha, 'pass1': '', 'pass2': '', 'Nova': '0'}, timeout=60)
    return s


def extensionistas(s):
    """{codigo: nome} do select do relatório de grupos."""
    r = s.get(BASE + 'principal.php', params={'content': 'rel_prog_grupo.php'}, timeout=60)
    r.encoding = 'utf-8'  # a página é UTF-8; sem isto requests assume latin1 e mojibaca acentos (José -> JosÃ©)
    html = r.text
    sel = re.search(r'<select[^>]*name="codext"[^>]*>(.*?)</select>', html, re.S)
    if not sel:
        sys.exit('rel_prog_grupo.php: select de extensionistas não encontrado (sessão caiu?)')
    pares = re.findall(r'<option value="?(-?\d+)"?[^>]*>\s*([^<]+)', sel.group(1))
    return {cod: unescape(nome).strip() for cod, nome in pares if cod != '-1'}


def municipios_ibge():
    g = json.loads((PUB / 'municipios-pr.geojson').read_text(encoding='utf-8'))
    return {norm(f['properties']['NM_MUN']): (str(f['properties']['CD_MUN']), f['properties']['NM_MUN'])
            for f in g['features']}


def indice_caf():
    """cpf (dígitos) -> {ibge, caf, lon, lat} a partir das famílias da CAF."""
    idx = {}
    for arq in sorted((PRIV / 'caf').glob('*.json')):
        d = json.loads(arq.read_text(encoding='utf-8'))
        for fam in d.get('familias', {}).values():
            loc = fam.get('local') or {}
            ponto = {'ibge': d['ibge'], 'caf': fam.get('caf'),
                     'lon': loc.get('lon'), 'lat': loc.get('lat')}
            for m in fam.get('membros', []):
                cpf = re.sub(r'\D', '', m.get('cpf') or '')
                if len(cpf) == 11:
                    idx.setdefault(cpf, ponto)
    return idx


def separar_nome_municipio(texto, idx_mun):
    """'Adão Krupa Araucária' -> ('Adão Krupa', ibge, 'Araucária'): maior sufixo que é município."""
    palavras = texto.split()
    for i in range(1, min(6, len(palavras))):
        cand = ' '.join(palavras[-i:])
        hit = idx_mun.get(norm(cand))
        if hit:
            return ' '.join(palavras[:-i]), hit[0], hit[1]
    return texto, None, None


def ler_pdf(pdf_bytes, idx_mun, idx_caf):
    """[{nome, projeto, clientes}] de um relatório; ([] se o extensionista não tem grupos)."""
    try:
        texto = '\n'.join(p.extract_text() for p in PdfReader(io.BytesIO(pdf_bytes)).pages)
    except Exception as err:  # relatório vazio vem como aviso do PHP, não PDF
        if pdf_bytes[:5] != b'%PDF-':
            return [], None
        raise RuntimeError(f'PDF ilegível: {err}') from err
    grupos, atual, ano = [], None, None
    for linha in texto.splitlines():
        if ano is None:
            m = RE_ANO.search(linha)
            if m:
                ano = int(m.group(1))
        m = RE_GRUPO.match(linha)
        if m:
            atual = {'nome': m.group(1).strip(), 'projeto': m.group(2).strip(), 'clientes': []}
            grupos.append(atual)
            continue
        m = RE_CLIENTE.match(linha)
        if m and atual is not None:
            nome, ibge, municipio = separar_nome_municipio(m.group(2).strip(), idx_mun)
            cpf = re.sub(r'\D', '', m.group(4))
            ponto = idx_caf.get(cpf) or {}
            atual['clientes'].append({
                'nome': nome, 'ibge': ibge, 'municipio': municipio,
                'categoria': m.group(3).strip(), 'ativo': m.group(5) == 'Ativo',
                'caf': ponto.get('caf'), 'lon': ponto.get('lon'), 'lat': ponto.get('lat'),
            })
    return grupos, ano


def main():
    limite = int(sys.argv[sys.argv.index('--limite') + 1]) if '--limite' in sys.argv else None
    carregar_env()
    s = entrar()
    exts = extensionistas(s)
    idx_mun = municipios_ibge()
    print(f'{len(exts)} extensionistas; indexando CAF…', flush=True)
    idx_caf = indice_caf()
    print(f'{len(idx_caf)} CPFs na CAF', flush=True)
    ano_corrente = date.today().year
    form = {'ano': str(ano_corrente), 'codreg': '-1', 'codmun': '-1', 'codgru': '-1', 'CodPro': '-1',
            'Categoria': '-1', 'mes1': '1', 'mes2': '12', 'codorg': '1'}
    saida, ano_rel, n_cli, n_pt = {}, None, 0, 0
    for i, (cod, nome) in enumerate(list(exts.items())[:limite], 1):
        r = s.post(BASE + 'relatorios/rel_gru_ext_lista.php', data={**form, 'codext': cod}, timeout=120)
        grupos, ano = ler_pdf(r.content, idx_mun, idx_caf)
        ano_rel = ano_rel or ano
        if grupos:
            saida[cod] = {'nome': nome, 'grupos': grupos}
            cli = [c for g in grupos for c in g['clientes']]
            n_cli += len(cli)
            n_pt += sum(1 for c in cli if c['lon'] is not None)
        if i % 50 == 0:
            print(f'{i}/{len(exts)}: {len(saida)} com grupos, {n_cli} clientes, {n_pt} com ponto', flush=True)
        time.sleep(0.2)
    sem_mun = sum(1 for e in saida.values() for g in e['grupos'] for c in g['clientes'] if c['ibge'] is None)
    PRIV.mkdir(parents=True, exist_ok=True)
    SAIDA.write_text(json.dumps({
        'geradoEm': date.today().isoformat(),
        'ano': ano_rel or ano_corrente,
        'fonte': 'IDR GETEC, Lista de assistidos por extensionista',
        'extensionistas': saida,
    }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(saida)} extensionistas com grupos, {n_cli} clientes ({n_pt} com ponto na CAF, '
          f'{sem_mun} sem município reconhecido) -> {SAIDA.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
