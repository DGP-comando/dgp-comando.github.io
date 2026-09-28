#!/usr/bin/env python3
"""Gera public/data/modulos-fiscais-pr.json — modulo fiscal dos 399 municipios.

Fontes (INCRA, publicas, sem chave):
  1. Indices Basicos do SNCR de 2013 (PDF, todos os municipios): modulo
     fiscal (MF), fracao minima de parcelamento (FMP) e limite de aquisicao
     por estrangeiro (LIM EST = 3 modulos de exploracao indefinida).
  2. Instrucao Especial INCRA n. 5/2022 (planilha dos municipios alterados):
     nova FMP e novo limite para estrangeiro. O MF NAO mudou em 2022; o script
     confere MF identico nas duas fontes e aborta se divergir.

Por municipio sai:
  mf   modulo fiscal (ha) — base da classe de porte (Lei 8.629/1993) e do CAR
  mei  modulo rural de exploracao indefinida (ha) = LIM EST / 3
  fmp  fracao minima de parcelamento (ha)
  ie2022  true quando FMP/limite vem da IE 5/2022

A consulta interativa oficial (PGT/INCRA) tem captcha; por isso os arquivos.

Uso:  py -3 scripts/build_modulos_fiscais.py
Requer: pdfplumber, pandas, xlrd.
Rodar de novo quando: o INCRA publicar nova instrucao especial de indices.
"""

import io
import json
import re
import urllib.request
from pathlib import Path

import pandas as pd
import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'modulos-fiscais-pr.json'
INFO = ROOT / 'public' / 'data' / 'municipios-info.json'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36'}

# gov.br serve a pagina HTML no endereco do arquivo; o binario fica em /@@download/file.
PDF_2013 = ('https://www.gov.br/incra/pt-br/acesso-a-informacao/'
            'indices_basicos_2013_por_municipio.pdf/@@download/file')
XLS_2022 = ('https://www.gov.br/incra/pt-br/assuntos/noticias/'
            'reclassificacao-de-imoveis-rurais-beneficia-produtores-de-todo-o-pais/'
            'tabela-fmp_alterado.xls/@@download/file')

# 4106902 CURITIBA 037 1 5 A1-1 2 15 605 3.580,0 435,0 M, C
#  codigo  nome     MRG ZP MF ZTM FMP LIM ...
LINHA = re.compile(r'^(41\d{5}) (.+?) (\d{3}) (\d) (\d+(?:,\d+)?) (\S+) (\d+(?:,\d+)?) (\d+(?:,\d+)?) ')


def baixar(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as resp:
        dados = resp.read()
    if dados[:15].lstrip().lower().startswith(b'<!doctype') or dados[:5] == b'<html':
        raise RuntimeError(f'{url}: veio HTML, nao o arquivo')
    return dados


def num(texto):
    return float(str(texto).replace('.', '').replace(',', '.'))


def ler_2013(pdf_bytes):
    muni = {}
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for pagina in pdf.pages:
            for linha in (pagina.extract_text() or '').splitlines():
                m = LINHA.match(linha)
                if m:
                    muni[m.group(1)] = {
                        'mf': num(m.group(5)),
                        'fmp': num(m.group(7)),
                        'limEst': num(m.group(8)),
                    }
    return muni


def ler_2022(xls_bytes):
    tab = pd.read_excel(io.BytesIO(xls_bytes), header=0)
    tab = tab[tab['UF'].astype(str).str.strip() == 'PR']
    return {
        str(int(r['COD_MUN'])): {
            'mf': float(r['MF']),
            'fmp': float(r['NOVA FMP']),
            'limEst': float(r['NOVO L.E.']),
        }
        for _, r in tab.iterrows()
    }


def arred(v):
    return int(v) if float(v).is_integer() else round(v, 2)


def main():
    base = ler_2013(baixar(PDF_2013))
    novos = ler_2022(baixar(XLS_2022))
    esperados = set(json.loads(INFO.read_text(encoding='utf-8'))['municipios'])

    if set(base) != esperados:
        raise SystemExit(f'PDF 2013: {len(base)} municipios; faltam {sorted(esperados - set(base))[:5]}, '
                         f'sobram {sorted(set(base) - esperados)[:5]}')
    divergem = [c for c, n in novos.items() if base.get(c, {}).get('mf') != n['mf']]
    if divergem:
        raise SystemExit(f'MF diverge entre 2013 e IE 5/2022 em {divergem[:10]}: revisar antes de publicar')

    municipios = {}
    for codigo in sorted(base):
        atual = novos.get(codigo, base[codigo])
        municipios[codigo] = {
            'mf': arred(base[codigo]['mf']),
            'mei': arred(atual['limEst'] / 3),
            'fmp': arred(atual['fmp']),
            'ie2022': codigo in novos,
        }

    OUT.write_text(json.dumps({
        'fonte': 'INCRA · Índices Básicos do SNCR 2013 + Instrução Especial nº 5/2022',
        'unidade': 'ha',
        'municipios': municipios,
    }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    mfs = sorted(m['mf'] for m in municipios.values())
    print(f'{OUT.name}: {len(municipios)} municipios, {len(novos)} com FMP/limite da IE 5/2022, '
          f'MF {mfs[0]}–{mfs[-1]} ha (mediana {mfs[len(mfs) // 2]})')


if __name__ == '__main__':
    main()
