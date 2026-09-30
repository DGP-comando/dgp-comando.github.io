"""Relação mensal de servidores do RH do IDR -> data/privado/servidores-rh.json.

Entrada: "NN- RELAÇÃO SERVIDORES DO IDR-PARANA -<MÊS>-<ANO>.xlsx", enviada pelo
RH todo mês, guardada FORA do repositório (datageo-command-dados-locais).

Saída: data/privado/servidores-rh.json (bucket privado, fora do git: subir com
scripts/upload_privado.py). A Edge Function datageo-servidores do c2 lê esse
arquivo e o usa como fonte de verdade sobre o SisPont: quem está no quadro,
município, vínculo, cessão e cargo. Sem ele a função segue só com SisPont+Portal.

LGPD: a planilha tem CPF, RG, e-mail, nascimento, sexo, aposentadoria e atos de
afastamento. Só saem matrícula, nome, lotação, município, cargo, vínculo,
órgão de cessão, área e admissão (o mesmo nível do Portal da Transparência).

    py -3 scripts/build_servidores_rh.py <planilha.xlsx>
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
MUN_GEOJSON = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
OUT = ROOT / 'data' / 'privado' / 'servidores-rh.json'
MINIMO = 1000  # abaixo disso a planilha veio cortada ou com layout novo

# Grafias da planilha que não batem com o nome oficial do IBGE.
ALIAS_MUN = {
    'KAROLE': 'Kaloré',
    'SANTA TEREZA DO ITAIPU': 'Santa Terezinha de Itaipu',
    'DIAMANTE DO OESTE': "Diamante D'Oeste",
    'TRES BARRAS': 'Três Barras do Paraná',
}

COLS = {
    'MATR.': 'id', 'NOME DO FUNCIONARIO': 'nome', 'LOTAÇÃO': 'lotacao', 'MUNICÍPIO': 'municipio',
    'OCUPACAO/PROFISSAO': 'ocupacao', 'CONV.': 'vinculo', 'ÓRGÃO/ONDE ESTÁ(CESSÃO/DISPOSIÇÃO)': 'cedido_para',
    'ÁREA': 'area', 'ADMISSAO': 'admissao', 'EXONERAÇÃO': 'exoneracao',
}


def norm(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().upper()
    return re.sub(r'\s+', ' ', re.sub(r'[^A-Z0-9 ]', ' ', s)).strip()


def texto(v):
    return '' if pd.isna(v) else re.sub(r'\s+', ' ', str(v)).strip()


def data_iso(v):
    return '' if pd.isna(v) else pd.Timestamp(v).date().isoformat()


def municipios_oficiais():
    feats = json.loads(MUN_GEOJSON.read_text(encoding='utf-8'))['features']
    return {norm(f['properties']['NM_MUN']): f['properties']['NM_MUN'] for f in feats}


def canon_municipio(nome, oficiais):
    """Nome oficial do município; '' se não reconhecido."""
    n = norm(nome)
    return oficiais.get(n) or ALIAS_MUN.get(n, '')


def le_planilha(caminho):
    bruto = pd.read_excel(caminho, header=None)
    linha = bruto.index[bruto[1].astype(str).str.strip() == 'MATR.']
    if not len(linha):
        sys.exit('cabeçalho "MATR." não encontrado: layout da planilha mudou')
    df = bruto.iloc[linha[0] + 1:].copy()
    df.columns = [texto(c) for c in bruto.iloc[linha[0]]]
    faltando = [c for c in COLS if c not in df.columns]
    if faltando:
        sys.exit(f'colunas ausentes: {faltando}')
    df = df[list(COLS)].rename(columns=COLS)
    df = df[df['id'].notna() & df['nome'].notna()]
    df['id'] = df['id'].map(lambda v: texto(v).removesuffix('.0'))
    return df


def build(df, oficiais):
    ativos, sem_mun = [], []
    for r in df[df['exoneracao'].isna()].itertuples():
        mun = canon_municipio(r.municipio, oficiais)
        if not mun:
            sem_mun.append(texto(r.municipio))
        ativos.append({
            'id': r.id, 'nome': texto(r.nome), 'municipio': mun, 'lotacao': texto(r.lotacao),
            'ocupacao': texto(r.ocupacao), 'vinculo': texto(r.vinculo), 'cedido_para': texto(r.cedido_para),
            'area': texto(r.area), 'admissao': data_iso(r.admissao),
        })
    ids_ativos = {a['id'] for a in ativos}
    # Desligado = exonerado sem outra linha ativa (readmitidos aparecem nas duas).
    desligados = sorted(set(df.loc[df['exoneracao'].notna(), 'id']) - ids_ativos)
    return ativos, desligados, sem_mun


def referencia(caminho):
    m = re.search(r'-\s*([A-ZÇ]+)-(\d{4})', Path(caminho).stem.upper())
    return f'{m[1].capitalize()}/{m[2]}' if m else ''


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    caminho = sys.argv[1]
    ativos, desligados, sem_mun = build(le_planilha(caminho), municipios_oficiais())
    if len(ativos) < MINIMO:
        sys.exit(f'só {len(ativos)} ativos (< {MINIMO}): planilha incompleta?')
    if len({a['id'] for a in ativos}) != len(ativos):
        sys.exit('matrícula repetida entre os ativos')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        'referencia': referencia(caminho),
        'fonte': 'Relação de Servidores do IDR-Paraná (RH)',
        'ativos': ativos,
        'desligados': desligados,
    }, ensure_ascii=False), encoding='utf-8')
    print(f'{OUT.name}: {len(ativos)} ativos, {len(desligados)} desligados; '
          f'sem município reconhecido: {sem_mun or "nenhum"}')


if __name__ == '__main__':
    main()
