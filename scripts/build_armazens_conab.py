#!/usr/bin/env python3
"""Gera public/data/armazens-conab-pr.geojson direto do cadastro da CONAB.

Fonte: CONAB, Cadastro Nacional de Unidades Armazenadoras (SICARM),
  https://portaldeinformacoes.conab.gov.br/downloads/arquivos/ArmazensCadastrados.txt
  Texto ';' em Latin-1 (cp1252), Brasil inteiro; aqui fica só UF=PR.
  Coordenada (latitude/longitude) em graus decimais, WGS84/SIRGAS 2000 (lon/lat).

LGPD (minimização em dado aberto; o arquivo vai para o site público):
  - Saem SÓ as chaves de CAMPOS: kind, nome, municipio, tipo, entidade, cap_t.
    Endereço, e-mail, telefone e o código do armazém nunca saem, de ninguém.
  - Armazenador PESSOA FÍSICA (dsc_tipo_pessoa): o nome vira o rótulo genérico
    ROTULO_PF, qualquer que seja o texto do cadastro. Ficam tipo, capacidade,
    município e entidade.
  - PJ, cooperativa e oficial: fica a razão social (nome_armazenador).
  - A coordenada sai como está no cadastro (a CONAB a publica aberta); sem nome,
    endereço nem contato, o ponto não identifica o armazenador.
  checar() aborta sem gravar se alguma dessas regras for violada.

O Porto de Paranaguá não está no cadastro e entra fixo (legenda "Porto").

Uso: py -3 scripts/build_armazens_conab.py [--txt arquivo_local.txt]
"""

import argparse
import csv
import io
import json
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'armazens-conab-pr.geojson'
MUNICIPIOS = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
URL = 'https://portaldeinformacoes.conab.gov.br/downloads/arquivos/ArmazensCadastrados.txt'

ROTULO_PF = 'Armazém de pessoa física'
CAMPOS = {'kind', 'nome', 'municipio', 'tipo', 'entidade', 'cap_t'}
MIN_PR = 2000  # abaixo disso a fonte veio truncada: não grava

PORTO = {'kind': 'porto', 'nome': 'Porto de Paranaguá (D. Pedro II)', 'municipio': 'Paranaguá',
         'tipo': 'porto graneleiro', 'cap_t': None}
PORTO_LONLAT = (-48.5148, -25.5021)

TIPOS = {
    'BATERIA DE SILOS': 'Bateria de silos', 'GRANELEIRO': 'Graneleiro', 'CONVENCIONAL': 'Convencional',
    'SILO': 'Silo', 'CHAPÉU CHINES': 'Chapéu chinês', 'DEPÓSITO': 'Depósito', 'ESTRUTURAL': 'Estrutural',
    'INFLÁVEL': 'Inflável', 'GRANELEIRO EM V': 'Graneleiro em V',
}
ENTIDADES = {'PRIVADA': 'Privada', 'COOPERATIVA': 'Cooperativa', 'OFICIAL': 'Oficial'}

SMALL = {'de', 'da', 'do', 'das', 'dos', 'e', 'em'}
SIGLAS = {'ltda', 'me', 'epp', 'eireli', 's/a', 'sa', 's.a.', 'cia', 'ss'}


def norm(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]', '', s.lower())


def title_pt(name):
    out = []
    for i, w in enumerate(str(name or '').lower().split()):
        if w in SIGLAS:
            out.append(w.upper())
        elif i > 0 and w in SMALL:
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:])
    return ' '.join(out)


def baixar(tentativas=4):
    for n in range(1, tentativas + 1):
        try:
            req = urllib.request.Request(URL, headers={'User-Agent': 'datageo-command/1.0 (build script)'})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - qualquer falha de rede vale retry
            print(f'  tentativa {n}/{tentativas} falhou: {e}')
            if n == tentativas:
                raise
            time.sleep(10 * n)


def num(s):
    s = (s or '').strip()
    if not s:
        return None
    # Capacidade vem como "41060,0" (vírgula decimal, sem milhar).
    return float(s.replace('.', '').replace(',', '.') if ',' in s else s)


def municipios():
    g = json.loads(MUNICIPIOS.read_text(encoding='utf-8'))
    nomes = {str(f['properties']['CD_MUN']): f['properties']['NM_MUN'] for f in g['features']}
    pr = unary_union([shape(f['geometry']) for f in g['features']]).buffer(0.02)  # malha simplificada
    return nomes, pr


def build(raw):
    nomes, pr = municipios()
    txt = raw.decode('latin-1')  # Latin-1 legítimo da CONAB, não é corrupção
    linhas = csv.reader(io.StringIO(txt, newline=''), delimiter=';')
    cab = [c.strip() for c in next(linhas)]
    feats, fora, tipos_novos, n_pr = [], [], set(), 0
    for cols in linhas:
        r = dict(zip(cab, (c.strip() for c in cols)))
        if r.get('uf') != 'PR':
            continue
        n_pr += 1
        lat, lon = num(r.get('latitude')), num(r.get('longitude'))
        if lat is None or lon is None or not pr.contains(Point(lon, lat)):
            fora.append((r.get('nom_municipio'), lat, lon))
            continue
        pf = norm(r['dsc_tipo_pessoa']) == 'pessoafisica'
        tipo = r['dsc_tipo_armazem']
        if tipo not in TIPOS:
            tipos_novos.add(tipo)
        cap = num(r.get('qtd_capacidade_estatica(t)'))
        feats.append({'type': 'Feature', 'properties': {
            'kind': 'armazem_conab',
            'nome': ROTULO_PF if pf else title_pt(r['nome_armazenador']),
            'municipio': nomes.get(r['cod_ibge']) or title_pt(re.sub(r'-PR$', '', r['nom_municipio'])),
            'tipo': TIPOS.get(tipo, tipo.capitalize()),
            'entidade': ENTIDADES.get(r['dsc_tipo_entidade'], r['dsc_tipo_entidade'].capitalize()),
            'cap_t': round(cap) if cap else None,
        }, 'geometry': {'type': 'Point', 'coordinates': [round(lon, 5), round(lat, 5)]}})
    feats.append({'type': 'Feature', 'properties': PORTO,
                  'geometry': {'type': 'Point', 'coordinates': list(PORTO_LONLAT)}})
    return feats, n_pr, fora, tipos_novos


CPF_RE = re.compile(r'\d{3}\.?\d{3}\.?\d{3}-?\d{2}')
MOJIBAKE_RE = re.compile(r'\ufffd|\u00c3[\u0080-\u00bf]')  # U+FFFD ou UTF-8 lido como Latin-1


def checar(feats, n_pr):
    """Regras de LGPD e volume; qualquer falha aborta antes de gravar."""
    assert n_pr >= MIN_PR, f'só {n_pr} armazéns PR na fonte (mínimo {MIN_PR})'
    for f in feats:
        p = f['properties']
        assert set(p) <= CAMPOS, f'chave fora da lista: {set(p) - CAMPOS}'
        texto = json.dumps(p, ensure_ascii=False)
        assert '@' not in texto, f'e-mail no dado público: {texto}'
        assert not CPF_RE.search(texto), f'CPF no dado público: {texto}'
        assert not MOJIBAKE_RE.search(texto), f'acento quebrado: {texto}'
    assert title_pt('COOPERATIVA AGROINDUSTRIAL DE SÃO JOÃO LTDA') == 'Cooperativa Agroindustrial de São João LTDA'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--txt', help='ArmazensCadastrados.txt já baixado (senão baixa da CONAB)')
    a = ap.parse_args()
    raw = Path(a.txt).read_bytes() if a.txt else baixar()
    feats, n_pr, fora, tipos_novos = build(raw)
    checar(feats, n_pr)
    armz = [f['properties'] for f in feats if f['properties']['kind'] == 'armazem_conab']
    cap = sum(p['cap_t'] or 0 for p in armz)
    pf = sum(p['nome'] == ROTULO_PF for p in armz)
    OUT.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'armazéns PR no cadastro: {n_pr}; no mapa: {len(armz)} ({pf} de pessoa física) + porto; '
          f'{cap / 1e6:.2f} Mt; {OUT.stat().st_size / 1024:.0f} KB')
    if fora:
        print(f'  {len(fora)} sem coordenada ou fora do PR (descartados): {fora[:10]}')
    if tipos_novos:
        print(f'  tipos sem rótulo fixo (capitalizados): {sorted(tipos_novos)}', file=sys.stderr)


if __name__ == '__main__':
    main()
