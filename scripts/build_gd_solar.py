#!/usr/bin/env python3
"""Geração distribuída fotovoltaica (UFV) no PR, um ponto por empreendimento.

Fontes (baixadas na hora; com ENERGY=<pasta do projeto energy> lê os
parquets locais em data/raw/aneel/ em vez de baixar):
  - Relação de Empreendimentos de GD da ANEEL (dados abertos, parquet
    nacional de ~100 MB, filtrado para o PR), ~336 mil UFV. A própria ANEEL já
    mascara CPF, nome e CEP de pessoa física; PJ vem com nome e CNPJ (dado
    público). Desde a ref. 10/2026 o arquivo NÃO traz mais a coordenada do
    empreendimento.
  - GD do SIGEL/ANEEL (ArcGIS REST, páginas de 2000): coordenada (arredondada
    a 0,01°, ~1 km), data de conexão e área urbana/rural, juntas pelo código GD.
    O SIGEL anda atrás da ANEEL (272 mil em 10/2026): quem não está nele vai
    para um ponto interno do município (public/data/municipios-pr.geojson),
    marcado como aproximado (vazado no mapa).

Como a coordenada é arredondada, centenas de sistemas caem no mesmo ponto:
espalhados em espiral de girassol (passo 15 m), marcados no tooltip.
Saída: public/data/gd-solar-pr.json.gz (aberto).

Uso: py -3 scripts/build_gd_solar.py   (GitHub Actions: atualiza-dados-energia.yml, mensal)
"""

import gzip
import json
import os
import tempfile
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from build_cnpj_agro import girassol

ENERGY = os.environ.get('ENERGY')
URL_ANEEL = ('https://dadosabertos.aneel.gov.br/dataset/5e0fafd2-21b9-4d5b-b622-40438d40aba2/resource/'
             'cd29f6eb-e08d-4db7-b6fb-ed6e3b682d27/download/empreendimento-geracao-distribuida.parquet')
URL_SIGEL = 'https://sigel.aneel.gov.br/arcgis/rest/services/Geracao_distribuida/GD_Sigel/FeatureServer/0/query'
MIN_UFV = 300_000  # o PR tinha 336 mil em 10/2026: abaixo disso a fonte veio quebrada
MIN_SIGEL = 0.7  # fração mínima de UFV com coordenada do SIGEL
MUNICIPIOS = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'municipios-pr.geojson'
CAMPOS_SIGEL = ['CodGD', 'DthConexao', 'Tipo', 'MdaLongitude', 'MdaLatitude', 'MdaPotenciaInstalada']
# Ref. 10/2026: a ANEEL trocou por 75 kW (teto da microgeração) a potência de ~36 mil
# sistemas da Copel que em 07/2026 tinham a real (mediana 5 kW, igual ao SIGEL).
TETO_SUSPEITO = 75.0
OBS_TETO = 'a ANEEL informa 75 kW (teto da microgeração, valor suspeito); potência do SIGEL'
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'gd-solar-pr.json.gz'
BBOX = (-55.0, -48.0, -27.0, -22.0)

# Classe de consumo -> cor no mapa (ordem da legenda).
CLASSES = ['Residencial', 'Rural', 'Comercial', 'Industrial', 'Poder público e serviços', 'Outros']
CLASSE_DE = {'Residencial': 0, 'Rural': 1, 'Comercial': 2, 'Industrial': 3, 'Poder Público': 4,
             'Serviço Público': 4, 'Iluminação pública': 4}
MODALIDADE = {'Geracao na propria UC': 'Geração na própria UC', 'Auto consumo remoto': 'Autoconsumo remoto',
              'Compartilhada': 'Geração compartilhada'}
PORTE = {'Microgeracao': 'Microgeração (até 75 kW)', 'Minigeracao': 'Minigeração (acima de 75 kW)'}


def txt(v) -> str:
    return '' if v is None or (isinstance(v, float) and pd.isna(v)) else str(v).strip()


def data_iso(v) -> str:
    s = txt(v)
    return s[:10] if len(s) >= 10 else ''


def cnpj_fmt(c: str) -> str:
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}' if len(c) == 14 and c.isdigit() else c


def indexador():
    """Valor -> índice numa lista (dicionário de strings repetidas)."""
    lista, idx = [], {}

    def f(v: str) -> int:
        if v not in idx:
            idx[v] = len(lista)
            lista.append(v)
        return idx[v]
    return lista, f


def baixar(url: str, destino: Path | None = None, tentativas: int = 5) -> bytes:
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'datageo-pr'})
            with urllib.request.urlopen(req, timeout=300) as r:
                if destino is None:
                    return r.read()
                with open(destino, 'wb') as fh:
                    while bloco := r.read(1 << 20):
                        fh.write(bloco)
                return b''
        except Exception as exc:  # noqa: BLE001
            if i == tentativas - 1:
                raise
            print(f'  falhou ({exc}), nova tentativa em {2 ** i}s')
            time.sleep(2 ** i)


def carregar_aneel() -> pd.DataFrame:
    if ENERGY:
        return pd.read_parquet(Path(ENERGY) / 'data' / 'raw' / 'aneel' / 'aneel_gd_pr.parquet')
    with tempfile.TemporaryDirectory() as tmp:
        arq = Path(tmp) / 'gd.parquet'
        baixar(URL_ANEEL, arq)
        print(f'ANEEL: {arq.stat().st_size / 1e6:.0f} MB baixados')
        return pd.read_parquet(arq, filters=[('SigUF', '==', 'PR')])


def carregar_sigel() -> pd.DataFrame:
    if ENERGY:
        return pd.read_parquet(Path(ENERGY) / 'data' / 'raw' / 'aneel' / 'sigel_gd_pr.parquet', columns=CAMPOS_SIGEL)
    total = json.loads(baixar(URL_SIGEL + '?' + urllib.parse.urlencode(
        {'where': "SigUF='PR'", 'returnCountOnly': 'true', 'f': 'json'})))['count']
    linhas = []
    for off in range(0, total, 2000):
        q = {'where': "SigUF='PR'", 'outFields': ','.join(CAMPOS_SIGEL), 'returnGeometry': 'false',
             'orderByFields': 'OBJECTID', 'resultOffset': off, 'resultRecordCount': 2000, 'f': 'json'}
        pag = json.loads(baixar(URL_SIGEL + '?' + urllib.parse.urlencode(q)))
        if 'error' in pag:
            raise RuntimeError(f'SIGEL offset {off}: {pag["error"]}')
        linhas += [f['attributes'] for f in pag['features']]
    print(f'SIGEL: {len(linhas)} de {total}')
    if len(linhas) < total * 0.99:
        raise RuntimeError(f'SIGEL incompleto: {len(linhas)} de {total}')
    return pd.DataFrame(linhas)


def pontos_municipios() -> dict[str, tuple[float, float]]:
    """Código IBGE (7 díg.) -> ponto garantidamente dentro do município."""
    from shapely.geometry import shape
    gj = json.loads(MUNICIPIOS.read_text(encoding='utf-8'))
    out = {}
    for f in gj['features']:
        pt = shape(f['geometry']).representative_point()
        out[str(f['properties']['CD_MUN'])] = (pt.x, pt.y)
    return out


def main() -> None:
    d = carregar_aneel()
    d = d[(d.SigUF == 'PR') & (d.SigTipoGeracao == 'UFV')].copy()
    if len(d) < MIN_UFV:
        raise SystemExit(f'só {len(d)} UFV no PR (mínimo {MIN_UFV}): fonte quebrada, nada gravado')
    d['CodEmpreendimento'] = d.CodEmpreendimento.str.strip()
    d = d.sort_values('CodEmpreendimento').reset_index(drop=True)

    s = carregar_sigel()
    s['CodGD'] = s.CodGD.str.strip()
    s = s.drop_duplicates('CodGD').set_index('CodGD')
    conex = s.DthConexao.to_dict()
    local = s.Tipo.to_dict()

    kw_sigel = d.CodEmpreendimento.map(s.MdaPotenciaInstalada)
    troca = (d.MdaPotenciaInstaladaKW == TETO_SUSPEITO) & (kw_sigel > 0) & (kw_sigel < TETO_SUSPEITO)
    d['kw'] = d.MdaPotenciaInstaladaKW.where(~troca, kw_sigel).fillna(0)
    d['obs'] = troca.map({True: OBS_TETO, False: ''})
    print(f'{int(troca.sum())} com 75 kW da ANEEL trocados pela potência do SIGEL '
          f'({(d.MdaPotenciaInstaladaKW.fillna(0) - d.kw).sum() / 1000:,.0f} MW a menos)')

    sx = d.CodEmpreendimento.map(s.MdaLongitude)
    sy = d.CodEmpreendimento.map(s.MdaLatitude)
    no_pr = sx.between(BBOX[0], BBOX[1]) & sy.between(BBOX[2], BBOX[3])
    mun = pontos_municipios()
    cm = d.CodMunicipioIbge.astype(str).map(mun)
    d['x'] = sx.where(no_pr, cm.map(lambda v: v[0] if isinstance(v, tuple) else None))
    d['y'] = sy.where(no_pr, cm.map(lambda v: v[1] if isinstance(v, tuple) else None))
    d['aprox'] = (~no_pr).astype(int)
    frac = no_pr.mean()
    print(f'{len(d)} UFV; {int(no_pr.sum())} com coordenada do SIGEL ({frac:.0%}), '
          f'{int((~no_pr).sum())} no ponto do município, {int(d.x.isna().sum())} sem nenhum (fora)')
    if frac < MIN_SIGEL:
        raise SystemExit(f'só {frac:.0%} com coordenada do SIGEL (mínimo {MIN_SIGEL:.0%}): nada gravado')
    d = d[d.x.notna()].reset_index(drop=True)

    grupos = defaultdict(list)
    for i, (x, y) in enumerate(zip(d.x, d.y)):
        grupos[(round(x, 4), round(y, 4))].append(i)
    pos = [None] * len(d)
    for (x, y), idx in grupos.items():
        for i, xy in zip(idx, girassol(x, y, len(idx), passo_m=15.0)):
            pos[i] = (xy, len(idx))

    dic = {k: indexador() for k in ('mun', 'ag', 'sub', 'mod', 'porte', 'cls', 'local', 'se', 'obs')}
    p = []
    for i, r in enumerate(d.itertuples(index=False)):
        (x, y), n = pos[i]
        cod = txt(r.CodEmpreendimento)
        ms = conex.get(cod)
        ms = ms if ms == ms else None  # NaN do pandas = sem data
        pj = r.SigTipoConsumidor == 'PJ'
        p.append([
            round(x, 5), round(y, 5), round(float(r.kw), 2),
            CLASSE_DE.get(txt(r.DscClasseConsumo), 5),
            cod, txt(r.NomTitularEmpreendimento) if pj else '',
            cnpj_fmt(txt(r.NumCPFCNPJ)) if pj else txt(r.NumCPFCNPJ), txt(r.SigTipoConsumidor),
            txt(r.CodCEP),
            dic['mun'][1](txt(r.NomMunicipio)), dic['ag'][1](txt(r.NomAgente)),
            dic['cls'][1](txt(r.DscClasseConsumo)), dic['sub'][1](txt(r.DscSubGrupoTarifario).upper()),
            dic['mod'][1](MODALIDADE.get(txt(r.DscModalidadeHabilitado), txt(r.DscModalidadeHabilitado))),
            dic['porte'][1](PORTE.get(txt(r.DscPorte), txt(r.DscPorte))),
            int(r.QtdUCRecebeCredito or 0),
            data_iso(r.DthAtualizaCadastralEmpreend),
            datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat() if ms else '',
            dic['local'][1](txt(local.get(cod))),
            dic['se'][1](txt(r.NomSubEstacao)),
            n, int(r.aprox), dic['obs'][1](r.obs),
        ])

    ref = txt(d.AnmPeriodoReferencia.iloc[0])
    doc = {
        'fonte': f'ANEEL · Relação de empreendimentos de GD (ref. {ref}) · posição e data de conexão: SIGEL/ANEEL',
        'classes': CLASSES,
        'campos': ['x', 'y', 'kw', 'c', 'cod', 'titular', 'doc', 'tipoCons', 'cep', 'mun', 'ag', 'cls', 'sub',
                   'mod', 'porte', 'qtdUC', 'dtAtual', 'dtConex', 'local', 'se', 'nPonto', 'aprox', 'obs'],
        'dic': {k: v[0] for k, v in dic.items()},
        'p': p,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0: mesmo dado = mesmos bytes (o Actions só faz commit se mudou).
    with gzip.GzipFile(OUT, 'wb', mtime=0) as fh:
        fh.write(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    mw = d.kw.sum() / 1000
    print(f'{len(p)} pontos, {mw:,.0f} MW, {sum(1 for v in p if v[17])} com data de conexão '
          f'-> {OUT.name} {OUT.stat().st_size / 1e6:.1f} MB')


def _testes() -> None:
    assert cnpj_fmt('76446020000152') == '76.446.020/0001-52' and cnpj_fmt('***.087.939-**') == '***.087.939-**'
    assert data_iso('2021-12-22') == '2021-12-22' and data_iso(None) == '' and txt(float('nan')) == ''
    lista, f = indexador()
    assert [f('a'), f('b'), f('a')] == [0, 1, 0] and lista == ['a', 'b']


if __name__ == '__main__':
    _testes()
    main()
