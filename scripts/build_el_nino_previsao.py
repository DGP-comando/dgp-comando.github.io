#!/usr/bin/env python3
"""Perspectiva mensal da chuva e da temperatura no PR para os proximos 6 meses.

Segunda metade da camada "Perspectiva El Nino" (datageo-el-nino); a primeira e
o sinal historico (build_el_nino_historico.py), cujo JSON este script le para a
grade, a normal e os tercis observados de cada celula.

Fontes (todas abertas, nenhuma chave):
  ECMWF SEAS5 via Open-Meteo Seasonal API (CC BY 4.0): media mensal e anomalia
    do ensemble, e os 51 membros diarios de chuva.
  NMME (NOAA CPC, dominio publico): probabilidade de cada tercil, grade de 1 grau.
  ONI e RONI (NOAA CPC) e a tabela de probabilidades do ENSO do CPC.

Metodo, por celula de 0,1 grau:
  1. A anomalia do SEAS5 vira RAZAO sobre a climatologia do proprio modelo
     (media / (media - anomalia)); a razao vezes a normal OBSERVADA (CHIRPS
     1991-2020) da a chuva esperada em mm. A razao corrige o vies de volume do
     modelo sem precisar de hindcast.
  2. Cada membro diario soma o mes; o espalhamento entre membros (total do
     membro / media dos membros) multiplica a razao do ensemble. Os 51 valores
     dao p10/p50/p90 e a fracao acima do tercil superior / abaixo do inferior
     observados. O mes corrente esta pela metade nos membros: so a media.
  3. Pontos do SEAS5 a cada 0,5 grau (o modelo tem ~36 km) interpolados
     bilinearmente para a grade de 0,1 grau.
  4. Confianca 0-3: o SEAS5 tem sinal (|anomalia| >= 10%), e o NMME (tercil
     dominante com >= 10 p.p. de vantagem) e o historico de El Nino (mediana
     >= 10% no mesmo sentido) concordam.

Saida: public/data/el-nino-previsao-pr.json (contrato em docs/EL_NINO.md).
Uso: py -3 scripts/build_el_nino_previsao.py   (Actions: atualiza-el-nino.yml)
"""

from __future__ import annotations

import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from calendar import monthrange
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
from scipy.io import netcdf_file

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / 'public' / 'data' / 'el-nino-historico-pr.json'
OUT = ROOT / 'public' / 'data' / 'el-nino-previsao-pr.json'

OM_URL = 'https://seasonal-api.open-meteo.com/v1/seasonal'
NMME_URL = 'https://ftp.cpc.ncep.noaa.gov/NMME/prob/netcdf/{var}.{ym}.prob.adj.mon.nc'
ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt'
RONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt'
CPC_PROB_URL = 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/probabilities/'

N_MESES = 6
PASSO_PONTOS = 0.5
# Pontos do SEAS5: retangulo que cobre o PR com meia celula de folga.
LONS = np.round(np.arange(-54.75, -47.74, PASSO_PONTOS), 2)
LATS = np.round(np.arange(-26.75, -22.24, PASSO_PONTOS), 2)
LOTE = 5            # localidades por chamada (membros diarios pesam na cota)
PAUSA_S = 4
LIMIAR_SINAL = 10   # % de anomalia para contar como sinal
LIMIAR_NMME = 10    # p.p. de vantagem do tercil dominante


# ---------------------------------------------------------------- HTTP

def baixar(url: str, tentativas: int = 5) -> bytes:
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'datageo-parana/1.0'})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404 or i == tentativas - 1:
                raise
            espera = 65 if exc.code == 429 else 10 * (i + 1)
            print(f'  HTTP {exc.code} em {url[:80]}..., nova tentativa em {espera}s')
            time.sleep(espera)
        except (urllib.error.URLError, TimeoutError) as exc:
            if i == tentativas - 1:
                raise
            print(f'  {exc} em {url[:80]}..., nova tentativa')
            time.sleep(10 * (i + 1))
    raise RuntimeError('inalcancavel')


def baixar_json(url: str):
    return json.loads(baixar(url).decode('utf-8'))


# ---------------------------------------------------------------- ENSO

def ultimos_indices(texto: str, n: int = 6) -> list[dict]:
    """Ultimos n trimestres de oni.ascii.txt (SEAS YR TOTAL ANOM) ou RONI (SEAS YR ANOM)."""
    linhas = [l.split() for l in texto.splitlines()[1:] if l.split()]
    return [{'tri': p[0], 'ano': int(p[1]), 'valor': float(p[-1])} for p in linhas[-n:]]


def probabilidades_cpc(html: str) -> list[dict]:
    """Tabela 'ENSO Probabilities' do CPC: trimestre, La Nina, Neutro, El Nino (%)."""
    tabela = html[html.index('id="probabilities-table"'):]
    tabela = tabela[:tabela.index('</table>')]
    linhas = re.findall(r'<abbr>(\w{3})\s.*?</th>\s*<td>(\d+)</td>\s*<td>(\d+)</td>\s*<td>(\d+)</td>', tabela, re.S)
    assert linhas, 'tabela de probabilidades do CPC mudou de formato'
    return [{'tri': t, 'laNina': int(a), 'neutro': int(b), 'elNino': int(c)} for t, a, b, c in linhas]


def enso() -> dict:
    out = {
        'oni': ultimos_indices(baixar(ONI_URL).decode()),
        'roni': ultimos_indices(baixar(RONI_URL).decode()),
    }
    try:
        out['probCpc'] = probabilidades_cpc(baixar(CPC_PROB_URL).decode('utf-8', 'replace'))
    except Exception as exc:  # noqa: BLE001 - a camada vive sem a tabela
        print(f'  probabilidades do CPC indisponiveis: {exc}')
        out['probCpc'] = []
    return out


# ---------------------------------------------------------------- SEAS5 (Open-Meteo)

def pontos() -> list[tuple[float, float]]:
    return [(float(la), float(lo)) for la in LATS for lo in LONS]


def chamar_om(params: dict, lote: list[tuple[float, float]]) -> list[dict]:
    q = {**params,
         'latitude': ','.join(f'{la}' for la, _ in lote),
         'longitude': ','.join(f'{lo}' for _, lo in lote)}
    dado = baixar_json(f'{OM_URL}?{urllib.parse.urlencode(q)}')
    dado = dado if isinstance(dado, list) else [dado]
    # Resposta curta desalinharia os pontos em silencio.
    assert len(dado) == len(lote), f'Open-Meteo devolveu {len(dado)} de {len(lote)} pontos'
    return dado


def seas5_mensal(pts) -> tuple[list[str], np.ndarray, np.ndarray, np.ndarray]:
    """Meses (YYYY-MM), razao da chuva [pt, mes], anomalia de T [pt, mes], media [pt, mes]."""
    params = {'monthly': 'precipitation_mean,precipitation_anomaly,temperature_2m_mean,temperature_2m_anomaly',
              'forecast_months': N_MESES}
    resp = []
    for i in range(0, len(pts), 25):
        resp += chamar_om(params, pts[i:i + 25])
        time.sleep(PAUSA_S)
    meses = [t[:7] for t in resp[0]['monthly']['time']][:N_MESES]
    media = np.array([r['monthly']['precipitation_mean'][:N_MESES] for r in resp], dtype=float)
    anom = np.array([r['monthly']['precipitation_anomaly'][:N_MESES] for r in resp], dtype=float)
    t_anom = np.array([r['monthly']['temperature_2m_anomaly'][:N_MESES] for r in resp], dtype=float)
    # Nulo na API viraria razao 1 (= "normal") publicada sem aviso: aborta.
    for nome, arr in (('precipitation_mean', media), ('precipitation_anomaly', anom),
                      ('temperature_2m_anomaly', t_anom)):
        assert np.isfinite(arr).all(), f'SEAS5 mensal: {nome} com {int((~np.isfinite(arr)).sum())} nulos'
    clim = media - anom
    secos = float((clim <= 5).mean())
    assert secos < 0.05, f'SEAS5: climatologia do modelo <= 5 mm em {100 * secos:.0f}% dos pontos x meses'
    # Climatologia do modelo quase nula (mes muito seco): sem razao confiavel.
    razao = np.where(clim > 5, media / np.where(clim > 5, clim, 1), 1.0)
    return meses, razao, t_anom, media


def seas5_membros(pts, meses: list[str]) -> np.ndarray:
    """Total mensal de cada membro [pt, mes, membro]; NaN no mes corrente (incompleto)."""
    hoje = date.today()
    completos = [m for m in meses if date(int(m[:4]), int(m[5:]), 1) > hoje]
    if not completos:
        return np.full((len(pts), len(meses), 1), np.nan)
    ini = f'{completos[0]}-01'
    a, m = int(completos[-1][:4]), int(completos[-1][5:])
    fim = f'{completos[-1]}-{monthrange(a, m)[1]:02d}'
    params = {'daily': 'precipitation_sum', 'start_date': ini, 'end_date': fim}
    saida = None
    for i in range(0, len(pts), LOTE):
        for j, r in enumerate(chamar_om(params, pts[i:i + LOTE])):
            dia = r['daily']
            series = [k for k in dia if k.startswith('precipitation_sum')]
            if saida is None:
                saida = np.full((len(pts), len(meses), len(series)), np.nan)
            for im, mes in enumerate(meses):
                if mes not in completos:
                    continue
                idx = [n for n, t in enumerate(dia['time']) if t.startswith(mes)]
                for s, k in enumerate(series):
                    vals = [dia[k][n] for n in idx]
                    if all(v is not None for v in vals):
                        saida[i + j, im, s] = sum(vals)
        print(f'  membros: {min(i + LOTE, len(pts))}/{len(pts)} pontos')
        time.sleep(PAUSA_S)
    return saida


# ---------------------------------------------------------------- NMME

def nmme(var: str, meses: list[str]) -> tuple[str | None, dict[str, dict]]:
    """Probabilidade dos tercis (acima/abaixo) por mes-alvo; rodada do mes ou a anterior."""
    hoje = date.today()
    for volta in (0, 1):
        a, m = hoje.year, hoje.month - volta
        if m == 0:
            a, m = a - 1, 12
        ym = f'{a}{m:02d}'
        try:
            bruto = baixar(NMME_URL.format(var=var, ym=ym))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                continue
            raise
        f = netcdf_file(io.BytesIO(bruto), 'r', mmap=False)
        lat = f.variables['lat'][:].astype(float)
        lon = f.variables['lon'][:].astype(float)
        alvo = f.variables['target'][:].astype(int)  # meses desde 1960-01
        acima = f.variables['prob_above'][:].astype(float)
        abaixo = f.variables['prob_below'][:].astype(float)
        # scipy nao aplica _FillValue: valores de preenchimento (~1e36) viram NaN.
        acima[np.abs(acima) > 1e20] = np.nan
        abaixo[np.abs(abaixo) > 1e20] = np.nan
        # O atributo diz 'percent', mas o arquivo vem em fracao (0,66 = 66%).
        topo = np.nanmax(acima)
        if topo <= 1.0:
            acima, abaixo = acima * 100, abaixo * 100
        else:
            assert topo > 5, f'NMME {var}: escala ambigua (maximo {topo})'
        out = {}
        for n, t in enumerate(alvo):
            chave = f'{1960 + t // 12}-{t % 12 + 1:02d}'
            if chave in meses:
                out[chave] = {'lat': lat, 'lon': lon, 'acima': acima[n], 'abaixo': abaixo[n]}
        return ym, out
    print(f'  ATENCAO: NMME {var} sem rodada neste mes nem no anterior; publicando sem NMME')
    return None, {}


def nmme_na_celula(campo: dict, la: float, lo: float) -> tuple[float | None, float | None]:
    i = int(np.argmin(np.abs(campo['lat'] - la)))
    j = int(np.argmin(np.abs(campo['lon'] - (lo % 360))))
    a, b = campo['acima'][i, j], campo['abaixo'][i, j]
    if not (np.isfinite(a) and np.isfinite(b)) or a < 0 or b < 0 or a > 100:
        return None, None
    return float(a), float(b)


# ---------------------------------------------------------------- grade

def bilinear(valores_pts: np.ndarray, la: float, lo: float) -> np.ndarray:
    """valores_pts[pt, ...] na grade LATS x LONS (pt = ilat*len(LONS)+ilon) -> valor em (la, lo)."""
    fi = np.clip((la - LATS[0]) / PASSO_PONTOS, 0, len(LATS) - 1.0001)
    fj = np.clip((lo - LONS[0]) / PASSO_PONTOS, 0, len(LONS) - 1.0001)
    i, j = int(fi), int(fj)
    di, dj = fi - i, fj - j
    n = len(LONS)

    def v(a, b):
        return valores_pts[a * n + b]

    return ((1 - di) * (1 - dj) * v(i, j) + (1 - di) * dj * v(i, j + 1)
            + di * (1 - dj) * v(i + 1, j) + di * dj * v(i + 1, j + 1))


def centro(hist: dict, k: int) -> tuple[float, float]:
    w, b, p = hist['width'], hist['bounds'], hist['passoGraus']
    return b['south'] + (k // w) * p, b['west'] + (k % w) * p


def confianca(anom: float, nmme_a, nmme_b, forte_med) -> int:
    if abs(anom) < LIMIAR_SINAL:
        return 0
    d = 1 if anom > 0 else -1
    c = 1
    if nmme_a is not None and d * (nmme_a - nmme_b) >= LIMIAR_NMME:
        c += 1
    if forte_med is not None and d * forte_med >= LIMIAR_SINAL:
        c += 1
    return c


def montar(hist, meses, razao, t_anom, membros, nmme_p, nmme_t) -> dict:
    celulas = hist['celulas']
    idx_mes = {m: i for i, m in enumerate(hist['meses'])}
    H = hist['campos']
    campos = {c: [[None] * len(celulas) for _ in meses]
              for c in ('esperado', 'anom', 'p10', 'p50', 'p90', 'pAcima', 'pAbaixo',
                        'tAnom', 'nmmeAcima', 'nmmeAbaixo', 'nmmeTAcima', 'conf')}
    tem_membros = np.isfinite(membros).any(axis=(0, 2))
    for im, mes in enumerate(meses):
        ih = idx_mes[int(mes[5:])]
        # Espalhamento: total do membro / media dos membros, por ponto.
        if tem_membros[im]:
            m = membros[:, im, :]
            media = np.nanmean(m, axis=1, keepdims=True)
            espalho = np.where(media > 0.5, m / np.where(media > 0.5, media, 1), 1.0)
        for n, k in enumerate(celulas):
            la, lo = centro(hist, k)
            normal = H['normal'][ih][n]
            r = float(bilinear(razao[:, im], la, lo))
            esperado = normal * r
            anom = 100 * (r - 1)
            campos['esperado'][im][n] = round(esperado)
            campos['anom'][im][n] = round(anom)
            campos['tAnom'][im][n] = round(10 * float(bilinear(t_anom[:, im], la, lo)))
            if tem_membros[im]:
                vals = normal * r * bilinear(espalho, la, lo)
                vals = vals[np.isfinite(vals)]
                assert vals.size >= 20, f'{mes}: so {vals.size} membros validos na celula {k}'
                p10, p50, p90 = np.percentile(vals, [10, 50, 90])
                campos['p10'][im][n], campos['p50'][im][n], campos['p90'][im][n] = round(p10), round(p50), round(p90)
                campos['pAcima'][im][n] = round(100 * float(np.mean(vals > H['t66'][ih][n])))
                campos['pAbaixo'][im][n] = round(100 * float(np.mean(vals < H['t33'][ih][n])))
            na, nb = nmme_na_celula(nmme_p[mes], la, lo) if mes in nmme_p else (None, None)
            if na is not None:
                campos['nmmeAcima'][im][n], campos['nmmeAbaixo'][im][n] = round(na), round(nb)
            if mes in nmme_t:
                ta, _ = nmme_na_celula(nmme_t[mes], la, lo)
                campos['nmmeTAcima'][im][n] = None if ta is None else round(ta)
            campos['conf'][im][n] = confianca(anom, na, nb, H['forteMed'][ih][n])
    return campos


# ---------------------------------------------------------------- conferencia

def conferir(hist, meses, campos):
    k_cwb = hist['celulas'].index(round((-25.4 - hist['bounds']['south']) / hist['passoGraus']) * hist['width']
                                  + round((-49.3 - hist['bounds']['west']) / hist['passoGraus']))
    for im, mes in enumerate(meses):
        anom = [v for v in campos['anom'][im] if v is not None]
        assert len(anom) == len(hist['celulas']), mes
        assert -95 <= min(anom) and max(anom) <= 500, (mes, min(anom), max(anom))
        p = [(a, b, c) for a, b, c in zip(campos['p10'][im], campos['p50'][im], campos['p90'][im]) if a is not None]
        assert all(a <= b <= c for a, b, c in p), f'{mes}: p10 <= p50 <= p90 violado'
        t = [v for v in campos['tAnom'][im] if v is not None]
        assert t and -60 <= min(t) and max(t) <= 60, (mes, 'anomalia de temperatura implausivel')
        print(f'  {mes}: anomalia de chuva {np.median(anom):+.0f}% (mediana), Curitiba '
              f'{campos["esperado"][im][k_cwb]} mm ({campos["anom"][im][k_cwb]:+}%), '
              f'p10-p90 {campos["p10"][im][k_cwb]}-{campos["p90"][im][k_cwb]}, '
              f'P(acima) {campos["pAcima"][im][k_cwb]}%, NMME acima {campos["nmmeAcima"][im][k_cwb]}%, '
              f'conf {campos["conf"][im][k_cwb]}')


def main() -> int:
    hist = json.loads(HIST.read_text(encoding='utf-8'))
    print('ENSO (CPC)')
    estado = enso()
    print(f'  ONI {estado["oni"][-1]}, RONI {estado["roni"][-1]}')
    pts = pontos()
    print(f'SEAS5 mensal: {len(pts)} pontos')
    meses, razao, t_anom, _ = seas5_mensal(pts)
    print(f'  meses {meses}')
    print('SEAS5 membros diarios')
    membros = seas5_membros(pts, meses)
    completos = [m for m in meses if date(int(m[:4]), int(m[5:]), 1) > date.today()]
    if completos:
        com_dado = int(np.isfinite(membros).any(axis=(0, 2)).sum())
        assert com_dado == len(completos), f'membros diarios em {com_dado} de {len(completos)} meses'
    print('NMME')
    ym_p, nmme_p = nmme('prate', meses)
    ym_t, nmme_t = nmme('tmp2m', meses)
    print(f'  rodada chuva {ym_p} ({len(nmme_p)} meses), temperatura {ym_t} ({len(nmme_t)} meses)')
    campos = montar(hist, meses, razao, t_anom, membros, nmme_p, nmme_t)
    print('Conferencia')
    conferir(hist, meses, campos)
    doc = {
        'fonte': 'ECMWF SEAS5 (Open-Meteo), NMME (NOAA CPC), ONI/RONI (NOAA CPC)',
        'creditos': ['ECMWF SEAS5 via Open-Meteo.com (CC BY 4.0)',
                     'NMME, NOAA Climate Prediction Center (domínio público)',
                     'ONI/RONI e probabilidades do ENSO, NOAA CPC (domínio público)'],
        'gerado': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'meses': meses,
        'membros': int(np.isfinite(membros[0, -1]).sum()),
        'rodadaNmme': ym_p,
        # Os campos sao indexados pela posicao em hist['celulas']: o front confere.
        'historico': {'gerado': hist['gerado'], 'nCelulas': len(hist['celulas'])},
        'enso': estado,
        'escala': {'tAnom': 10},
        'campos': campos,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{OUT.name}: {OUT.stat().st_size / 1024:.0f} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
