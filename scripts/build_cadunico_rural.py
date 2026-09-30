"""Famílias rurais do CadÚnico por município do PR (extração do IDR, mar/2023).

Entrada: planilha identificada do CadÚnico (uma linha por família com domicílio
rural), guardada FORA do repositório:
    H:\\IDR-PARANA\\PROMOÇÃO SOCIAL\\CadUnico_Rurais_02032023.xlsX

Saída: data/privado/cadunico-rural-pr.json (bucket privado, fora do git: subir
com scripts/upload_privado.py), SÓ contagens agregadas.

LGPD: a planilha tem nome, CPF, NIS, RG e endereço. O script lê apenas colunas
de código/indicador (usecols), não grava nada identificado, e publica contagens
agregadas por município; contagens de 1 a 4 saem como "<5" (supressão de
célula pequena), para não apontar famílias em municípios pequenos.

Dado estático (não entra no workflow semanal: a planilha não está no GitHub).

    py -3 scripts/build_cadunico_rural.py [caminho da planilha]
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import geopandas as gpd
import pandas as pd

ENTRADA = Path(r'H:\IDR-PARANA\PROMOÇÃO SOCIAL\CadUnico_Rurais_02032023.xlsX')
ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / 'public' / 'data'
MUN_GEOJSON = PUB / 'municipios-pr.geojson'
OUT = ROOT / 'data' / 'privado' / 'cadunico-rural-pr.json'
N_MUN = 399
MINIMO = 5  # abaixo disso (e acima de zero) a contagem sai como "<5"

# coluna da planilha -> (chave no JSON, valor que conta como "sim"); None = soma
INDICADORES = {
    'EXTREMA POBREZA': ('extrema_pobreza', '1'),
    'POBREZA': ('pobreza', '1'),
    'AUXILIO BRASIL': ('auxilio_brasil', '1'),
    'COD AGUA CANALIZADA FAM': ('sem_agua_canalizada', '2'),
    'COD BANHEIRO DOMIC FAM': ('sem_banheiro', '2'),
    'COD FAMILIA INDIGENA FAM': ('indigenas', '1'),
    # "FAMILIA QUILOMBOLA" repete a coluna indígena na extração; o código é o certo.
    'IND FAMILIA QUILOMBOLA FAM': ('quilombolas', '1'),
}


def suprime(n):
    n = int(n)
    return '<5' if 0 < n < MINIMO else n


def norm(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().upper()
    return re.sub(r'\s+', ' ', re.sub(r'[^A-Z0-9 ]', ' ', s)).strip()


def agrega(fam):
    """Contagens de um conjunto de famílias (com supressão); None se vazio."""
    if fam.empty:
        return None
    if len(fam) < MINIMO:  # território pequeno: nem pessoas nem indicadores
        return {'familias': '<5'}
    tot = {
        'familias': len(fam),
        'pessoas': int(pd.to_numeric(fam['QT PES'], errors='coerce').fillna(0).sum()),
        **{chave: int((fam[col] == sim).sum()) for col, (chave, sim) in INDICADORES.items()},
    }
    return {k: suprime(v) for k, v in tot.items() if v > 0}


# ------------------------------------------------------------- territórios
#
# O endereço rural não geocodifica (CEP genérico do município, "Estrada X,
# km 12"), mas costuma trazer o nome do assentamento ou da comunidade. O
# casamento é por NOME dentro do MESMO município do território. Nome genérico
# (santo, "Boa Vista"...) exige também um marcador no endereço, senão casa rua.
# Terra indígena e quilombo exigem a família marcada como indígena/quilombola
# OU o marcador ("ALDEIA", "QUILOMBO"...). É uma contagem mínima: família cujo
# endereço não cita o território fica de fora.

GENERICOS = re.compile(r'^(NOSSA SENHORA|SAO|SANTA|SANTO|BOA|BOM|NOVA|NOVO|BELA|SANTA MARIA|RIO|AGUA|SERRA|VILA)\b')
PREFIXO = re.compile(r'^(PA|PE|PDS|PCA|PAC|PRB|PAE|TI|FAZENDA)\s+')
MAX_RAZAO_INCRA = 3
MARCA_ASSENT = r'\bASSENT|\bP ?A\b|\bACAMP|\bPROJETO\b'
MARCA_QUILOMBO = r'QUILOMB|\bCOMUNIDADE\b'
MARCA_INDIGENA = r'\bALDEIA|\bINDIGENA|\bT ?I\b|\bRESERVA\b'


def nucleo(nome):
    s = norm(nome)
    while PREFIXO.match(s):
        s = PREFIXO.sub('', s)
    return s


def casa(fam, nome, marca, flag=None):
    """Máscara das famílias cujo endereço cita `nome` (regras acima)."""
    core = nucleo(nome)
    if len(core) < 4:
        return pd.Series(False, index=fam.index)
    m = fam['E'].str.contains(rf'\b{re.escape(core)}\b', regex=True)
    exige = fam['E'].str.contains(marca, regex=True)
    if flag is not None:
        exige |= fam[flag[0]] == flag[1]
    if flag is not None or GENERICOS.match(core) or len(core) < 8:
        m &= exige
    return m


def municipios_do_poligono(path):
    """nome do território -> nomes normalizados dos municípios que ele toca."""
    mun = gpd.read_file(MUN_GEOJSON)[['NM_MUN', 'geometry']]
    ter = gpd.read_file(path)
    if ter.crs != mun.crs:
        ter = ter.to_crs(mun.crs)
    j = gpd.sjoin(ter[['nome', 'geometry']], mun, predicate='intersects')
    return j.groupby('nome')['NM_MUN'].apply(lambda s: {norm(x) for x in s}).to_dict()


def territorios(df):
    out, stats = {}, {}
    por_mun = {m: g for m, g in df.groupby('M')}

    assent = json.loads((PUB / 'assentamentos-incra-pr.geojson').read_text(encoding='utf-8'))['features']
    res, razoes, descartados = {}, [], []
    for f in assent:
        p = f['properties']
        fam = por_mun.get(norm(p['municipio']))
        if fam is None:
            continue
        a = agrega(fam[casa(fam, p['nome'], MARCA_ASSENT)])
        if not a:
            continue
        incra = float(p.get('familias') or 0)
        if incra and isinstance(a['familias'], int):
            razao = a['familias'] / incra
            # Bem mais famílias que o INCRA assentou: o nome é também o da
            # localidade em volta, e a contagem não é do assentamento.
            if razao > MAX_RAZAO_INCRA:
                descartados.append(f"{p['nome']} ({a['familias']} x {int(incra)})")
                continue
            razoes.append((razao, p['nome'], a['familias'], int(incra)))
        res[p['codigo']] = a
    out['assentamentos'] = res
    stats['assentamentos'] = (len(res), len(assent), sorted(razoes, reverse=True)[:3])
    print('  descartados (razão CadÚnico/INCRA >', MAX_RAZAO_INCRA, '):', descartados)

    for chave, arq, marca, flag in (
        ('quilombos', 'quilombolas-pr.geojson', MARCA_QUILOMBO, ('IND FAMILIA QUILOMBOLA FAM', '1')),
        ('terras_indigenas', 'terras-indigenas-pr.geojson', MARCA_INDIGENA, ('COD FAMILIA INDIGENA FAM', '1')),
    ):
        muns = municipios_do_poligono(PUB / arq)
        res = {}
        for nome, ms in muns.items():
            fam = df[df['M'].isin(ms)]
            a = agrega(fam[casa(fam, nome, marca, flag)])
            if a:
                res[nome] = a
        out[chave] = res
        stats[chave] = (len(res), len(muns), None)
    return out, stats


def main():
    entrada = Path(sys.argv[1]) if len(sys.argv) > 1 else ENTRADA
    cols = ['COD IBGE', 'MUNICIPIO', 'ENDERECO', 'QT PES', 'LOCAL DOMICILIO', 'DATA CARGA', *INDICADORES]
    df = pd.read_excel(entrada, usecols=cols, dtype=str)
    assert (df['LOCAL DOMICILIO'] == 'Rurais').all(), 'planilha com domicílio não rural'
    ref = pd.to_datetime(df['DATA CARGA']).max().strftime('%Y%m')
    df['M'] = df['MUNICIPIO'].map(norm)
    df['E'] = df['ENDERECO'].fillna('').map(norm)

    municipios = {str(ibge): agrega(fam) for ibge, fam in sorted(df.groupby('COD IBGE'))}
    if len(municipios) != N_MUN:
        sys.exit(f'{len(municipios)} municípios na planilha (esperado {N_MUN})')
    ter, stats = territorios(df)

    out = {
        'fonte': 'CadÚnico · extração de famílias rurais do IDR-Paraná',
        'referencia': ref,
        'minimo': MINIMO,
        'municipios': municipios,
        **ter,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'ref {ref}: {len(df)} famílias rurais, {len(municipios)} municípios -> {OUT.name}')
    for k, (n, total, top) in stats.items():
        print(f'  {k}: {n} de {total} territórios com famílias casadas')
        for r in top or []:
            print(f'    maior razão CadÚnico/INCRA {r[0]:.1f}: {r[1]} ({r[2]} x {r[3]})')


if __name__ == '__main__':
    main()
