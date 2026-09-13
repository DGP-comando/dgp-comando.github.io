#!/usr/bin/env python3
"""Gera o clima historico do PR (1961-2022) a partir do BR-DWGD no Earth Engine.

Fonte: Brazilian Daily Weather Gridded Data, grade diaria de 0,1 grau
(Xavier, Scanlon, King & Alves 2022, Int. J. Climatol. 42(16):8390-8404,
doi:10.1002/joc.7731), CC BY 4.0, espelhado no awesome-gee-community-catalog:
  projects/sat-io/open-datasets/BR-DWGD/{PR,TMAX,TMIN,ET}
PR vai de 1961-01-01 a 2022-12-31; TMAX/TMIN/ET param em 2020-07-31.

Todo o calculo pesado (somas e contagens diarias) roda no Earth Engine; aqui
so chegam medias municipais e uma grade estadual pequena.

Saidas (public/data/), contrato documentado em docs/CLIMA_BRDWGD.md:
  clima-historico-pr.json         normal 1990-2019 + indicadores agro +
                                  tendencias, por cod IBGE (ficha municipal e
                                  qualquer dashboard do ecossistema)
  clima-historico-series-pr.json  series anuais por municipio (carga sob
                                  demanda: sparkline da ficha)
  clima-historico-grade-pr.json   grade 0,1 grau mascarada no PR, um array por
                                  indicador (camada datageo-clima-historico)

Normal: 1990-2019, os ultimos 30 anos COMPLETOS em todas as variaveis (a WMO
usa 1991-2020, mas temperatura e ETo acabam em julho de 2020). O rotulo
aparece na ficha e no painel; nao troque o periodo sem trocar o rotulo.

Uso:
  py -3 -m pip install earthengine-api
  earthengine authenticate          (uma vez por maquina)
  set EE_PROJECT=<id do projeto Cloud com Earth Engine habilitado>
  py -3 scripts/build_clima_brdwgd.py
Re-rodar so se o BR-DWGD publicar versao nova (a serie e historica).
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'data'
MUNICIPIOS = OUT / 'municipios-pr.geojson'
CACHE = ROOT / '.gev-cache' / 'brdwgd'

ASSET = 'projects/sat-io/open-datasets/BR-DWGD/'
COLECOES = {'pr': 'PR', 'tmax': 'TMAX', 'tmin': 'TMIN', 'eto': 'ET'}
# Empacotamento NetCDF declarado pelo catalogo (valor = bruto * escala + offset).
# O script NAO assume que os assets estao empacotados: sonda e decide (ver
# detectar_decodificacao), porque aplicar a escala num dado ja decodificado
# produziria um clima plausivel-mas-errado sem erro nenhum.
EMPACOTAMENTO = {
    'pr': (0.006866665, 225.0),
    'tmax': (0.001068148, 15.0),
    'tmin': (0.001068148, 15.0),
    'eto': (0.051181102, 0.0),
}
FAIXA_FISICA = {'pr': (0.0, 30.0), 'tmax': (5.0, 40.0), 'tmin': (-5.0, 30.0), 'eto': (0.5, 10.0)}

ANO_INICIO = 1961
ANO_FIM_PR = 2022
ANO_FIM_T = 2019          # ultimo ano completo de TMAX/TMIN/ET
NORMAL = (1990, 2019)

# Paraná com folga de meia celula: os limites da grade exportada.
BBOX = (-54.70, -26.80, -47.95, -22.45)   # oeste, sul, leste, norte
ESCALA_ZONAL_M = 2000     # < celula de 11 km: municipio pequeno recebe a celula que o contem

LIMIARES = {
    'geada3': 3.0,        # Tmin de abrigo <= 3 C: geada provavel na relva (convencao agro PR)
    'geada0': 0.0,
    'calor35': 35.0,      # Tmax >= 35 C: estresse termico em soja/milho na floracao
    'chuva50': 50.0,      # dia com >= 50 mm: chuva intensa
}


# ---------------------------------------------------------------------------
# Earth Engine
# ---------------------------------------------------------------------------

def iniciar_ee():
    try:
        import ee
    except ImportError:
        sys.exit('earthengine-api ausente: py -3 -m pip install earthengine-api')
    projeto = os.environ.get('EE_PROJECT')
    try:
        ee.Initialize(project=projeto) if projeto else ee.Initialize()
    except Exception as exc:  # noqa: BLE001 - mensagem acionavel e sair
        sys.exit(f'Earth Engine nao inicializou ({exc}).\n'
                 'Rode "earthengine authenticate" e defina EE_PROJECT.')
    return ee


def com_retentativa(fn, tentativas=4):
    for i in range(tentativas):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            if i == tentativas - 1:
                raise
            espera = 5 * (i + 1)
            print(f'  EE falhou ({str(exc)[:120]}), nova tentativa em {espera}s')
            time.sleep(espera)


def detectar_decodificacao(ee, regiao):
    """Para cada variavel, decide se os assets precisam de escala/offset.

    Media estadual de janeiro de 2000 no valor como esta; se cair na faixa
    fisica, o asset ja esta em unidade. Senao, testa com o empacotamento. Se
    nenhum dos dois servir, aborta: melhor nenhum dado que dado errado.
    """
    decisao = {}
    for var, nome in COLECOES.items():
        img = ee.ImageCollection(ASSET + nome).filterDate('2000-01-01', '2000-02-01').mean().select([0])
        bruto = com_retentativa(lambda: img.reduceRegion(
            ee.Reducer.mean(), regiao, 11000, maxPixels=1e9).values().get(0).getInfo())
        lo, hi = FAIXA_FISICA[var]
        escala, offset = EMPACOTAMENTO[var]
        if bruto is not None and lo <= bruto <= hi:
            decisao[var] = (1.0, 0.0)
        elif bruto is not None and lo <= bruto * escala + offset <= hi:
            decisao[var] = (escala, offset)
        else:
            sys.exit(f'{var}: media de jan/2000 = {bruto}, fora da faixa fisica com e sem '
                     'escala. Conferir os assets antes de gerar qualquer JSON.')
        print(f'  {var}: bruto {bruto:.4f} -> escala {decisao[var][0]}, offset {decisao[var][1]}')
    return decisao


def colecao(ee, var, decod):
    escala, offset = decod[var]

    def prep(img):
        out = img.select([0]).rename(var)
        if escala != 1.0 or offset != 0.0:
            out = out.multiply(escala).add(offset)
        return out.copyProperties(img, ['system:time_start'])

    return ee.ImageCollection(ASSET + COLECOES[var]).map(prep)


def imagem_anual(ee, cols, ano):
    ini, fim = f'{ano}-01-01', f'{ano + 1}-01-01'
    pr = cols['pr'].filterDate(ini, fim)
    bandas = [
        pr.sum().rename('pr'),
        pr.map(lambda i: i.gte(LIMIARES['chuva50'])).sum().rename('chuva50'),
    ]
    if ano <= ANO_FIM_T:
        tmax = cols['tmax'].filterDate(ini, fim)
        tmin = cols['tmin'].filterDate(ini, fim)
        bandas += [
            tmax.mean().add(tmin.mean()).divide(2).rename('tmed'),
            cols['eto'].filterDate(ini, fim).sum().rename('eto'),
            tmin.map(lambda i: i.lte(LIMIARES['geada3'])).sum().rename('geada3'),
            tmin.map(lambda i: i.lte(LIMIARES['geada0'])).sum().rename('geada0'),
            tmax.map(lambda i: i.gte(LIMIARES['calor35'])).sum().rename('calor35'),
        ]
    return ee.Image.cat(bandas).set('ano', ano)


def imagem_normal_mensal(ee, cols):
    """48 bandas: pr/eto (mm/mes) e tmax/tmin (C) medios por mes na normal."""
    ini, fim = f'{NORMAL[0]}-01-01', f'{NORMAL[1] + 1}-01-01'
    anos = NORMAL[1] - NORMAL[0] + 1
    bandas = []
    for m in range(1, 13):
        f = ee.Filter.calendarRange(m, m, 'month')
        bandas += [
            cols['pr'].filterDate(ini, fim).filter(f).sum().divide(anos).rename(f'pr_{m:02d}'),
            cols['eto'].filterDate(ini, fim).filter(f).sum().divide(anos).rename(f'eto_{m:02d}'),
            cols['tmax'].filterDate(ini, fim).filter(f).mean().rename(f'tmax_{m:02d}'),
            cols['tmin'].filterDate(ini, fim).filter(f).mean().rename(f'tmin_{m:02d}'),
        ]
    return ee.Image.cat(bandas)


def municipios_fc(ee):
    gj = json.loads(MUNICIPIOS.read_text(encoding='utf-8'))
    feats = [ee.Feature(f['geometry'], {'ibge': f['properties']['CD_MUN']}) for f in gj['features']]
    return ee.FeatureCollection(feats)


def zonal(ee, img, fc):
    fc_out = img.reduceRegions(collection=fc, reducer=ee.Reducer.mean(), scale=ESCALA_ZONAL_M, tileScale=4)
    dados = com_retentativa(lambda: fc_out.getInfo())
    return {f['properties']['ibge']: f['properties'] for f in dados['features']}


# ---------------------------------------------------------------------------
# Estatistica local
# ---------------------------------------------------------------------------

def tendencia(anos, valores):
    """Inclinacao OLS por decada e |t| da inclinacao (|t| >= 2 ~ 95%)."""
    pares = [(a, v) for a, v in zip(anos, valores) if v is not None]
    n = len(pares)
    if n < 10:
        return None, None
    mx = sum(a for a, _ in pares) / n
    my = sum(v for _, v in pares) / n
    sxx = sum((a - mx) ** 2 for a, _ in pares)
    b = sum((a - mx) * (v - my) for a, v in pares) / sxx
    resid = sum((v - (my + b * (a - mx))) ** 2 for a, v in pares)
    se = math.sqrt(resid / (n - 2) / sxx) if n > 2 else float('inf')
    return b * 10, (abs(b) / se if se > 0 else float('inf'))


def media(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def r(x, casas=1):
    return None if x is None else round(x, casas)


# ---------------------------------------------------------------------------
# Construcao
# ---------------------------------------------------------------------------

def build_municipal(ee, cols, fc):
    anos = list(range(ANO_INICIO, ANO_FIM_PR + 1))
    print(f'Zonal anual: {len(anos)} anos x 399 municipios (paralelo)')

    def um_ano(ano):
        res = zonal(ee, imagem_anual(ee, cols, ano), fc)
        print(f'  {ano} ok')
        return str(ano), res

    # Cache local das agregacoes (minutos de Earth Engine): uma conferencia que
    # falha no fim nao obriga a recalcular 62 anos. Apagar para forcar.
    cache = CACHE / 'zonal_municipal.json'
    if cache.exists():
        print(f'Zonal municipal lido do cache {cache}')
        bruto = json.loads(cache.read_text(encoding='utf-8'))
        por_ano, mensal = bruto['por_ano'], bruto['mensal']
    else:
        with ThreadPoolExecutor(max_workers=6) as pool:
            por_ano = dict(pool.map(um_ano, anos))
        print('Zonal da normal mensal')
        mensal = zonal(ee, imagem_normal_mensal(ee, cols), fc)
        CACHE.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({'por_ano': por_ano, 'mensal': mensal}), encoding='utf-8')
    por_ano = {int(a): v for a, v in por_ano.items()}

    anos_t = [a for a in anos if a <= ANO_FIM_T]
    anos_n = list(range(NORMAL[0], NORMAL[1] + 1))
    resumo, series = {}, {}
    for ibge in sorted(mensal):
        s = {k: [r(por_ano[a].get(ibge, {}).get(k)) for a in (anos if k in ('pr', 'chuva50') else anos_t)]
             for k in ('pr', 'chuva50', 'tmed', 'eto', 'geada3', 'geada0', 'calor35')}

        def normal(k):
            base = anos if k in ('pr', 'chuva50') else anos_t
            return media([s[k][base.index(a)] for a in anos_n])

        m = mensal[ibge]
        nm = {k: [r(m.get(f'{k}_{i:02d}')) for i in range(1, 13)] for k in ('pr', 'eto', 'tmax', 'tmin')}
        pr_n, eto_n = normal('pr'), normal('eto')
        tend_t, t_t = tendencia(anos_t, s['tmed'])
        tend_p, t_p = tendencia(anos, s['pr'])
        media_pr = media(s['pr'])
        resumo[ibge] = {
            'normal': nm,
            'pr': r(pr_n, 0),
            'tmed': r(normal('tmed')),
            'eto': r(eto_n, 0),
            'balanco': r(pr_n - eto_n, 0) if pr_n is not None and eto_n is not None else None,
            'mesesDeficit': sum(1 for p, e in zip(nm['pr'], nm['eto'])
                                if p is not None and e is not None and p < e),
            'geada3': r(normal('geada3')),
            'geada0': r(normal('geada0')),
            'calor35': r(normal('calor35')),
            'chuva50': r(normal('chuva50')),
            'tendTmed': r(tend_t, 2),
            'tendTmedSig': bool(t_t is not None and t_t >= 2),
            'tendPrPct': r(100 * tend_p / media_pr, 1) if tend_p is not None and media_pr else None,
            'tendPrSig': bool(t_p is not None and t_p >= 2),
        }
        series[ibge] = {k: s[k] for k in ('pr', 'tmed', 'geada3')}
    return resumo, series


def build_grade(ee, cols):
    print('Grade estadual')
    anuais_n = ee.ImageCollection([imagem_anual(ee, cols, a) for a in range(NORMAL[0], NORMAL[1] + 1)])
    normal = anuais_n.mean()
    mensal = imagem_normal_mensal(ee, cols)
    deficit = ee.Image.cat([
        mensal.select(f'pr_{m:02d}').lt(mensal.select(f'eto_{m:02d}')) for m in range(1, 13)
    ]).reduce(ee.Reducer.sum()).rename('mesesDeficit')

    def com_tempo(img):
        return img.addBands(ee.Image.constant(ee.Number(img.get('ano'))).float().rename('t'))

    anuais_t = ee.ImageCollection([imagem_anual(ee, cols, a) for a in range(ANO_INICIO, ANO_FIM_T + 1)]).map(com_tempo)
    tend_t = anuais_t.select(['t', 'tmed']).reduce(ee.Reducer.linearFit()).select('scale').multiply(10).rename('tendTmed')

    img = ee.Image.cat([
        normal.select(['pr', 'tmed', 'eto', 'geada3', 'geada0', 'calor35', 'chuva50']),
        normal.select('pr').subtract(normal.select('eto')).rename('balanco'),
        deficit,
        tend_t,
    ])

    proj = com_retentativa(lambda: cols['pr'].first().projection().getInfo())
    parana = ee.FeatureCollection('FAO/GAUL/2015/level1').filter(
        ee.Filter.And(ee.Filter.eq('ADM0_NAME', 'Brazil'), ee.Filter.eq('ADM1_NAME', 'Parana'))
    ).geometry().buffer(3000)
    # sampleRectangle exige um tipo compativel com o defaultValue em TODAS as
    # bandas (contagens saem inteiras, medias em ponto flutuante).
    grade = (img.toFloat().updateMask(ee.Image.constant(1).clip(parana).mask())
             .reproject(crs=proj['crs'], crsTransform=proj['transform']))
    regiao = ee.Geometry.Rectangle(list(BBOX), None, False)
    # Centros das celulas, amostrados SEM a mascara do PR para a grade ficar
    # retangular e georreferenciavel.
    coords = ee.Image.pixelLonLat().reproject(crs=proj['crs'], crsTransform=proj['transform'])
    amostra = com_retentativa(lambda: grade.sampleRectangle(region=regiao, defaultValue=-9999).getInfo())
    geo = com_retentativa(lambda: coords.sampleRectangle(region=regiao).getInfo())

    props = amostra['properties']
    lons = geo['properties']['longitude'][0]
    lats = [linha[0] for linha in geo['properties']['latitude']]
    altura, largura = len(lats), len(lons)
    # sampleRectangle devolve a linha 0 no NORTE; a camada usa linha 0 no SUL
    # (mesma convencao da grade Open-Meteo de ventos/precipitacao).
    ordem = range(altura - 1, -1, -1) if lats[0] > lats[-1] else range(altura)

    campos = {}
    casas = {'pr': 0, 'eto': 0, 'balanco': 0, 'tmed': 2, 'tendTmed': 3}
    for k in ('pr', 'tmed', 'eto', 'balanco', 'mesesDeficit', 'geada3', 'geada0', 'calor35', 'chuva50', 'tendTmed'):
        valores = []
        for j in ordem:
            for i in range(largura):
                v = props[k][j][i]
                valores.append(None if v is None or v <= -9998 else round(v, casas.get(k, 1)))
        campos[k] = valores

    lats_sul = sorted(lats)
    passo = abs(lons[1] - lons[0])
    return {
        'bounds': {'west': round(min(lons), 4), 'south': round(lats_sul[0], 4),
                   'east': round(max(lons), 4), 'north': round(lats_sul[-1], 4)},
        'width': largura,
        'height': altura,
        'passoGraus': round(passo, 4),
        'campos': campos,
    }


def quebras(valores, n=5, casas=0):
    """Quebras por quantil arredondadas: a legenda sempre cabe no dado real."""
    xs = sorted(v for v in valores if v is not None)
    if not xs:
        return []
    out = []
    for q in range(1, n):
        v = xs[min(len(xs) - 1, int(len(xs) * q / n))]
        v = round(v, casas) if casas else int(round(v))
        if not out or v > out[-1]:
            out.append(v)
    return out


def meta():
    return {
        'fonte': 'BR-DWGD, Brazilian Daily Weather Gridded Data (grade 0,1°)',
        'citacao': ('Xavier, A. C., Scanlon, B. R., King, C. W., & Alves, A. I. (2022). New improved '
                    'Brazilian daily weather gridded data (1961–2020). International Journal of '
                    'Climatology, 42(16), 8390–8404.'),
        'doi': '10.1002/joc.7731',
        'licenca': 'CC BY 4.0',
        'asset': ASSET,
        'catalogo': 'https://gee-community-catalog.org/projects/br_dwgd/',
        'normal': list(NORMAL),
        'serieChuva': [ANO_INICIO, ANO_FIM_PR],
        'serieTemperatura': [ANO_INICIO, ANO_FIM_T],
        'limiares': LIMIARES,
        'gerado': date.today().isoformat(),
    }


def salvar(nome, obj):
    caminho = OUT / nome
    caminho.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{nome}: {caminho.stat().st_size / 1024:.0f} KB')


def conferir(resumo):
    """Sanidade contra climatologia conhecida; aborta antes de gravar se falhar.

    Faixas de temperatura em (Tmax+Tmin)/2, que fica ~0,5-1 C acima da media
    compensada do INMET (Curitiba ~23,5/13,5 C na normal 1991-2020 => ~18,5).
    Sao travas contra erro grosseiro (escala, unidade, mascara), nao validacao.
    """
    referencias = {
        '4106902': ('Curitiba', (1300, 1800), (16.5, 19.5), (1, 40)),
        '4108304': ('Foz do Iguaçu', (1500, 2100), (20.0, 23.5), (0, 12)),
        '4115200': ('Maringá', (1300, 1900), (20.5, 24.5), (0, 8)),
    }
    for ibge, (nome, faixa_pr, faixa_t, faixa_geada) in referencias.items():
        m = resumo.get(ibge)
        assert m, f'{nome} ausente'
        print(f'  {nome}: {m["pr"]} mm/ano, {m["tmed"]} C, geada<=3C {m["geada3"]} d/ano, '
              f'balanco {m["balanco"]} mm, tendencia {m["tendTmed"]} C/dec')
        assert faixa_pr[0] <= m['pr'] <= faixa_pr[1], f'{nome}: chuva implausivel'
        assert faixa_t[0] <= m['tmed'] <= faixa_t[1], f'{nome}: temperatura implausivel'
        assert faixa_geada[0] <= m['geada3'] <= faixa_geada[1], f'{nome}: geada implausivel'


def main():
    ee = iniciar_ee()
    regiao = ee.Geometry.Rectangle(list(BBOX), None, False)
    print('Sondando empacotamento dos assets')
    decod = detectar_decodificacao(ee, regiao)
    cols = {v: colecao(ee, v, decod) for v in COLECOES}
    fc = municipios_fc(ee)

    resumo, series = build_municipal(ee, cols, fc)
    print('Conferencia')
    conferir(resumo)
    grade = build_grade(ee, cols)

    base = meta()
    salvar('clima-historico-pr.json', {**base, 'municipios': resumo})
    salvar('clima-historico-series-pr.json', {
        **base,
        'anos': {'pr': [ANO_INICIO, ANO_FIM_PR], 'tmed': [ANO_INICIO, ANO_FIM_T], 'geada3': [ANO_INICIO, ANO_FIM_T]},
        'municipios': series,
    })
    casas_q = {'tmed': 1, 'tendTmed': 2}
    grade['classes'] = {k: quebras(v, casas=casas_q.get(k, 0)) for k, v in grade['campos'].items()}
    salvar('clima-historico-grade-pr.json', {**base, **grade})


if __name__ == '__main__':
    main()
