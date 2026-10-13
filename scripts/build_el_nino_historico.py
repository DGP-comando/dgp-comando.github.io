#!/usr/bin/env python3
"""Sinal historico do El Nino no PR, por celula de 0,1 grau e mes (Earth Engine).

Base da camada "Perspectiva El Nino" (datageo-el-nino): o que o ENSO costuma
fazer em cada lugar do Parana, medido em 45 anos-safra observados. A previsao
mensal (build_el_nino_previsao.py) le este arquivo para converter anomalias de
modelo em milimetros e tercis locais.

Fontes (Earth Engine):
  chuva        CHIRPS v2 diario, 0,05 grau (UCSB-CHG/CHIRPS/DAILY), CC BY 4.0
  temperatura  ERA5-Land mensal, 0,1 grau (ECMWF/ERA5_LAND/MONTHLY_AGGR),
               licenca Copernicus (CC BY 4.0)
  indice       ONI da NOAA CPC (oni.ascii.txt), dominio publico

Ano-safra s = julho de s a junho de s+1 (45 anos: 1981-82 a 2025-26). O ENSO
de cada ano-safra e o ONI de OND de s, o trimestre de pico e o que a previsao
ja enxerga. Por celula e mes (julho a junho) o script grava:
  normal de chuva e tercis 1991-2020, correlacao e inclinacao chuva x ONI,
  mediana e quartis da anomalia nos El Ninos moderados/fortes (ONI de OND >= 1,0), fracao
  desses anos no tercil superior, dias com chuva >= 50 mm (normal e forte) e o
  mesmo para a temperatura.

O calculo pesado (somas diarias) roda no Earth Engine, um ano-safra por chamada
(36 bandas x ~2.900 celulas, abaixo do limite do sampleRectangle); a estatistica
roda aqui. Cache por ano-safra em .gev-cache/el-nino/ (apagar para recalcular).

Saida: public/data/el-nino-historico-pr.json (contrato em docs/EL_NINO.md).
Uso: set EE_PROJECT=<projeto> && py -3 scripts/build_el_nino_historico.py
Re-rodar uma vez por ano (setembro), quando o ano-safra anterior fecha no CHIRPS.
"""

from __future__ import annotations

import json
import math
import os
import statistics as st
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data' / 'el-nino-historico-pr.json'
CACHE = ROOT / '.gev-cache' / 'el-nino'
ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt'

PASSO = 0.1
# Centros das celulas extremas. A previsao usa a MESMA grade.
BOUNDS = {'west': -54.6, 'east': -48.0, 'south': -26.7, 'north': -22.5}
W = round((BOUNDS['east'] - BOUNDS['west']) / PASSO) + 1   # 67
H = round((BOUNDS['north'] - BOUNDS['south']) / PASSO) + 1  # 43

MESES = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6]   # ordem do ano-safra
SAFRA_INICIO = 1981                                 # CHIRPS comeca em 1981
# Ultimo ano-safra fechado (junho) com folga para a defasagem de ~6 semanas do
# CHIRPS: a partir de setembro entra o ano-safra que terminou em junho.
_hoje = date.today()
SAFRA_FIM = _hoje.year - 1 if _hoje.month >= 9 else _hoje.year - 2
NORMAL = (1991, 2020)                               # anos-safra da normal
# Composicao: El Nino moderado ou forte (ONI de OND >= 1,0). Com >= 1,5 sobram
# 4 eventos (1982, 1997, 2015, 2023), pouco para quartis; a intensidade de um
# evento muito forte entra pela regressao (inclinacao x ONI previsto).
LIMIAR_FORTE = 1.0
LIMIAR_CHUVA_FORTE = 50.0                           # mm/dia


# ---------------------------------------------------------------- ONI

def ler_oni(texto: str) -> dict[int, float]:
    """ONI de OND por ano, a partir do oni.ascii.txt (SEAS YR TOTAL ANOM)."""
    oni = {}
    for linha in texto.splitlines():
        partes = linha.split()
        if len(partes) == 4 and partes[0] == 'OND':
            oni[int(partes[1])] = float(partes[3])
    return oni


def baixar(url: str) -> str:
    req = urllib.request.Request(url, headers={'User-Agent': 'datageo-parana/1.0'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode('utf-8')


# ---------------------------------------------------------------- Earth Engine

def iniciar_ee():
    import ee
    chave = os.environ.get('EE_SERVICE_ACCOUNT_KEY')
    if chave:
        info = json.loads(chave)
        cred = ee.ServiceAccountCredentials(info['client_email'], key_data=chave)
        ee.Initialize(cred, project=os.environ.get('EE_PROJECT') or info['project_id'])
    else:
        ee.Initialize(project=os.environ.get('EE_PROJECT'))
    return ee


def com_retentativa(fn, tentativas=4):
    for i in range(tentativas):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            if i == tentativas - 1:
                raise
            print(f'  EE falhou ({str(exc)[:120]}), nova tentativa em {10 * (i + 1)}s')
            time.sleep(10 * (i + 1))


def meses_da_safra(s: int) -> list[tuple[int, int]]:
    return [(s if m >= 7 else s + 1, m) for m in MESES]


def amostrar_safra(ee, s: int) -> dict[str, list]:
    """36 bandas (pr, h50, t) x 12 meses do ano-safra s, linha 0 = sul."""
    proj = ee.Projection('EPSG:4326', [PASSO, 0, BOUNDS['west'] - PASSO / 2, 0, -PASSO, BOUNDS['north'] + PASSO / 2])
    chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY').select('precipitation')
    proj_chirps = chirps.first().projection()
    era5 = ee.ImageCollection('ECMWF/ERA5_LAND/MONTHLY_AGGR').select('temperature_2m')
    pr_geom = (ee.FeatureCollection('FAO/GAUL/2015/level1')
               .filter(ee.Filter.eq('ADM1_NAME', 'Parana')).geometry().buffer(5000))

    def para_grade_chirps(img):
        # 4 subcelulas de 0,05 -> media na celula de 0,1 (nao amostra uma so).
        return (img.setDefaultProjection(proj_chirps)
                .reduceResolution(ee.Reducer.mean(), maxPixels=64).reproject(proj))

    bandas = []
    for ano, mes in meses_da_safra(s):
        ini = ee.Date.fromYMD(ano, mes, 1)
        fim = ini.advance(1, 'month')
        dia = chirps.filterDate(ini, fim)
        bandas.append(para_grade_chirps(dia.sum()).rename(f'pr_{mes:02d}'))
        bandas.append(para_grade_chirps(dia.map(lambda i: i.gte(LIMIAR_CHUVA_FORTE)).sum()).rename(f'h50_{mes:02d}'))
        t = era5.filterDate(ini, fim).first().subtract(273.15)
        # ERA5-Land e so terra: o litoral fica sem celula; herda os vizinhos.
        t = t.unmask(t.focalMean(2, 'square', 'pixels'))
        bandas.append(t.resample('bilinear').reproject(proj).rename(f't_{mes:02d}'))
    img = ee.Image.cat(bandas).toFloat().clip(pr_geom).unmask(-9999)
    m = PASSO * 0.49
    ret = ee.Geometry.Rectangle([BOUNDS['west'] - m, BOUNDS['south'] - m, BOUNDS['east'] + m, BOUNDS['north'] + m], None, False)
    props = com_retentativa(lambda: img.sampleRectangle(region=ret, defaultValue=-9999).getInfo()['properties'])
    out = {}
    for nome, linhas in props.items():
        linhas = linhas[::-1]  # sul primeiro
        assert len(linhas) == H and len(linhas[0]) == W, (nome, len(linhas), len(linhas[0]))
        out[nome] = [None if v is None or v <= -9000 else v for row in linhas for v in row]
    return out


def carregar_safras(ee) -> dict[int, dict[str, list]]:
    CACHE.mkdir(parents=True, exist_ok=True)

    def uma(s):
        arq = CACHE / f'safra_{s}.json'
        if arq.exists():
            return s, json.loads(arq.read_text(encoding='utf-8'))
        dados = amostrar_safra(ee, s)
        arq.write_text(json.dumps(dados), encoding='utf-8')
        print(f'  safra {s}/{s + 1 - 2000 if s >= 1999 else s + 1} ok')
        return s, dados

    with ThreadPoolExecutor(max_workers=6) as pool:
        return dict(pool.map(uma, range(SAFRA_INICIO, SAFRA_FIM + 1)))


# ---------------------------------------------------------------- estatistica

def quantil(xs: list[float], q: float) -> float:
    """Quantil com interpolacao linear (mesma regra do numpy padrao)."""
    xs = sorted(xs)
    pos = (len(xs) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def correlacao(x: list[float], y: list[float]) -> tuple[float, float]:
    """(r de Pearson, inclinacao OLS de y em x)."""
    mx, my = st.fmean(x), st.fmean(y)
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    if sxx == 0 or syy == 0:
        return 0.0, 0.0
    return sxy / math.sqrt(sxx * syy), sxy / sxx


def r_critico(n: int) -> float:
    """|r| minimo para p < 0,05 bicaudal (aproximacao t com n-2 graus)."""
    t = 2.0 if n > 60 else {40: 2.02, 45: 2.017}.get(n, 2.02)
    return t / math.sqrt(n - 2 + t * t)


def estatistica_celula(serie_pr, serie_h50, serie_t, oni, safras, normais, fortes):
    """Todos os campos de UMA celula num UM mes. Entradas: listas por safra."""
    pr_n = [serie_pr[s] for s in normais]
    normal = st.fmean(pr_n)
    t33, t66 = quantil(pr_n, 1 / 3), quantil(pr_n, 2 / 3)
    anom = [100 * (serie_pr[s] / normal - 1) if normal > 0 else 0.0 for s in safras]
    r_pr, incl = correlacao([oni[s] for s in safras], anom)
    forte = [100 * (serie_pr[s] / normal - 1) if normal > 0 else 0.0 for s in fortes]
    tem_t = all(v is not None for v in serie_t.values())
    if tem_t:
        t_norm = st.fmean(serie_t[s] for s in normais)
        r_t, _ = correlacao([oni[s] for s in safras], [serie_t[s] - t_norm for s in safras])
    return {
        'normal': round(normal),
        't33': round(t33),
        't66': round(t66),
        'r': round(r_pr, 2),
        'incl': round(incl, 1),
        'forteMed': round(st.median(forte)),
        'forteP25': round(quantil(forte, 0.25)),
        'forteP75': round(quantil(forte, 0.75)),
        'forteAcima': round(100 * sum(serie_pr[s] > t66 for s in fortes) / len(fortes)),
        'h50Normal': round(st.fmean(serie_h50[s] for s in normais), 2),
        'h50Forte': round(st.fmean(serie_h50[s] for s in fortes), 2),
        'tNormal': round(t_norm, 1) if tem_t else None,
        'tForte': round(st.median(serie_t[s] - t_norm for s in fortes), 2) if tem_t else None,
        'rT': round(r_t, 2) if tem_t else None,
    }


CAMPOS = ('normal', 't33', 't66', 'r', 'incl', 'forteMed', 'forteP25', 'forteP75', 'forteAcima',
          'h50Normal', 'h50Forte', 'tNormal', 'tForte', 'rT')
# Gravados como inteiros: valor real = inteiro / ESCALA (o resto ja e inteiro).
ESCALA = {'incl': 10, 'r': 100, 'rT': 100, 'h50Normal': 100, 'h50Forte': 100, 'tNormal': 10, 'tForte': 100}


def compactar(campos):
    """So as celulas do PR (indice k em `celulas`), inteiros escalados."""
    celulas = [k for k in range(W * H) if all(mes[k] is not None for mes in campos['normal'])]

    def inteiro(c, v):
        return None if v is None else round(v * ESCALA.get(c, 1))

    return celulas, {c: [[inteiro(c, mes[k]) for k in celulas] for mes in campos[c]] for c in CAMPOS}


def montar(safras_dados, oni):
    safras = sorted(safras_dados)
    normais = [s for s in safras if NORMAL[0] <= s <= NORMAL[1]]
    fortes = [s for s in safras if oni[s] >= LIMIAR_FORTE]
    assert len(normais) == 30, len(normais)
    assert len(fortes) >= 7, f'so {len(fortes)} El Ninos fortes: {fortes}'
    campos = {c: [[None] * (W * H) for _ in MESES] for c in CAMPOS}
    for im, mes in enumerate(MESES):
        kpr, kh, kt = f'pr_{mes:02d}', f'h50_{mes:02d}', f't_{mes:02d}'
        for k in range(W * H):
            pr = {s: safras_dados[s][kpr][k] for s in safras}
            if any(v is None for v in pr.values()):
                continue
            h50 = {s: safras_dados[s][kh][k] for s in safras}
            tt = {s: safras_dados[s][kt][k] for s in safras}
            cel = estatistica_celula(pr, h50, tt, oni, safras, normais, fortes)
            for c in CAMPOS:
                campos[c][im][k] = cel[c]
    return campos, safras, normais, fortes


# ---------------------------------------------------------------- conferencia

def celula(lat: float, lon: float) -> int:
    i = round((lon - BOUNDS['west']) / PASSO)
    j = round((lat - BOUNDS['south']) / PASSO)
    return j * W + i


CIDADES = {
    'Curitiba': (-25.43, -49.27),
    'Cascavel': (-24.96, -53.46),
    'Francisco Beltrão': (-26.08, -53.05),
    'Londrina': (-23.31, -51.16),
    'Paranaguá': (-25.52, -48.51),
}
# Codigo IBGE para cruzar a normal CHIRPS com a do BR-DWGD (clima-historico-pr.json).
IBGE = {'Curitiba': '4106902', 'Cascavel': '4104808', 'Francisco Beltrão': '4108403',
        'Londrina': '4113700', 'Paranaguá': '4118204'}
BRDWGD = ROOT / 'public' / 'data' / 'clima-historico-pr.json'


def conferir(campos, n_fortes):
    """Travas contra erro grosseiro; aborta antes de gravar se falhar."""
    im = {m: MESES.index(m) for m in MESES}
    for nome, (la, lo) in CIDADES.items():
        k = celula(la, lo)
        anual = sum(campos['normal'][i][k] for i in range(12))
        out_nov = [campos['forteMed'][im[m]][k] for m in (10, 11)]
        r_on = [campos['r'][im[m]][k] for m in (10, 11)]
        print(f'  {nome}: normal {anual} mm/ano, El Nino forte out/nov {out_nov} %, r out/nov {r_on}, '
              f'Tnormal jan {campos["tNormal"][im[1]][k]} C')
        assert 1100 <= anual <= 2400, f'{nome}: chuva anual implausivel'
        if BRDWGD.exists():
            # Duas fontes independentes (satelite+estacoes x interpolacao de
            # estacoes): concordam em ~5% no PR. Mais que 15% = erro de grade.
            ref = sum(json.loads(BRDWGD.read_text(encoding='utf-8'))['municipios'][IBGE[nome]]['normal']['pr'])
            print(f'    BR-DWGD {ref:.0f} mm/ano ({100 * (anual / ref - 1):+.0f}%)')
            assert abs(anual / ref - 1) <= 0.15, f'{nome}: CHIRPS longe do BR-DWGD'
    # Primavera de El Nino forte: mais chuva no PR (Grimm 1998; Kist & Gebert 2022).
    validos = [k for k in range(W * H) if campos['normal'][0][k] is not None]
    for m in (10, 11):
        med = st.median(campos['forteMed'][im[m]][k] for k in validos)
        r_med = st.median(campos['r'][im[m]][k] for k in validos)
        print(f'  mes {m}: mediana estadual El Nino forte {med:+} %, r mediano {r_med:+.2f}')
        assert med > 0 and r_med > 0, f'mes {m}: sinal da primavera nao e positivo, conferir'
    # Pico em novembro (CHIRPS 1981-2025: r mediano ~0,6; outubro e misto, com
    # 1986/87/91 secos e 1997/2023 muito umidos). Trava em novembro forte.
    nov = st.median(campos['forteMed'][im[11]][k] for k in validos)
    assert nov >= 15, f'novembro de El Nino deveria ser bem umido no PR, veio {nov:+} %'
    print(f'  {len(validos)} celulas no PR, {n_fortes} El Ninos fortes')
    assert len(validos) > 1500, len(validos)


def main() -> None:
    oni = ler_oni(baixar(ONI_URL))
    faltando = [s for s in range(SAFRA_INICIO, SAFRA_FIM + 1) if s not in oni]
    assert not faltando, f'ONI de OND ausente para {faltando}'
    ee = iniciar_ee()
    print(f'Amostrando {SAFRA_FIM - SAFRA_INICIO + 1} anos-safra no Earth Engine')
    dados = carregar_safras(ee)
    print('Estatistica por celula')
    campos, safras, normais, fortes = montar(dados, oni)
    print('Conferencia')
    conferir(campos, len(fortes))
    celulas, compactos = compactar(campos)
    doc = {
        'fonte': 'CHIRPS v2 diário (chuva) e ERA5-Land mensal (temperatura), ONI NOAA CPC',
        'creditos': ['CHIRPS v2.0, Funk et al. 2015 (CC BY 4.0)',
                     'ERA5-Land, Copernicus Climate Change Service (CC BY 4.0)',
                     'ONI, NOAA Climate Prediction Center (domínio público)'],
        'gerado': date.today().isoformat(),
        'anosSafra': [safras[0], safras[-1]],
        'normal': list(NORMAL),
        'limiarForte': LIMIAR_FORTE,
        'fortes': fortes,
        'oniOND': {str(s): oni[s] for s in safras},
        'rCritico': round(r_critico(len(safras)), 2),
        'meses': MESES,
        'bounds': BOUNDS, 'width': W, 'height': H, 'passoGraus': PASSO,
        'escala': ESCALA,
        'celulas': celulas,
        'campos': compactos,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{OUT.name}: {OUT.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    sys.exit(main())
