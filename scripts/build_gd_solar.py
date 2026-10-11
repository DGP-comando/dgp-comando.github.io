#!/usr/bin/env python3
"""Geração distribuída fotovoltaica (UFV) no PR, um ponto por empreendimento.

Fontes (projeto energy, fora deste repositório; ENERGY sobrescreve):
  - data/raw/aneel/aneel_gd_pr.parquet: Relação de Empreendimentos de GD da
    ANEEL (dados abertos, ref. 07/2026), 331 mil UFV no PR. A própria ANEEL já
    mascara CPF, nome e CEP de pessoa física e arredonda a coordenada a 0,01°
    (~1 km); PJ vem com nome e CNPJ (dado público).
  - data/raw/aneel/sigel_gd_pr.parquet: GD do SIGEL/ANEEL, só para a data de
    conexão (DthConexao) e a localização (urbana/rural), juntas pelo código GD.

Como a coordenada é arredondada, centenas de sistemas caem no mesmo ponto:
espalhados em espiral de girassol (passo 15 m, cabe dentro da célula de
~1 km), marcados no tooltip. Saída: public/data/gd-solar-pr.json.gz (aberto).

Uso: py -3 scripts/build_gd_solar.py
"""

import gzip
import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from build_cnpj_agro import girassol

ENERGY = Path(os.environ.get('ENERGY', 'G:/UPWORK/01-CONTRACTS/energy')) / 'data' / 'raw' / 'aneel'
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


def main() -> None:
    d = pd.read_parquet(ENERGY / 'aneel_gd_pr.parquet')
    d = d[d.SigTipoGeracao == 'UFV'].copy()
    d['x'], d['y'] = d.NumCoordEEmpreendimento, d.NumCoordNEmpreendimento
    ok = d.x.between(BBOX[0], BBOX[1]) & d.y.between(BBOX[2], BBOX[3])
    print(f'{len(d)} UFV, {int((~ok).sum())} sem coordenada no PR (fora)')
    d = d[ok].sort_values('CodEmpreendimento').reset_index(drop=True)

    s = pd.read_parquet(ENERGY / 'sigel_gd_pr.parquet', columns=['CodGD', 'DthConexao', 'Tipo'])
    s['CodGD'] = s.CodGD.str.strip()
    s = s.drop_duplicates('CodGD').set_index('CodGD')
    conex = s.DthConexao.to_dict()
    local = s.Tipo.to_dict()

    grupos = defaultdict(list)
    for i, (x, y) in enumerate(zip(d.x, d.y)):
        grupos[(round(x, 4), round(y, 4))].append(i)
    pos = [None] * len(d)
    for (x, y), idx in grupos.items():
        for i, xy in zip(idx, girassol(x, y, len(idx), passo_m=15.0)):
            pos[i] = (xy, len(idx))

    dic = {k: indexador() for k in ('mun', 'ag', 'sub', 'mod', 'porte', 'cls', 'local', 'se')}
    p = []
    for i, r in enumerate(d.itertuples(index=False)):
        (x, y), n = pos[i]
        cod = txt(r.CodEmpreendimento)
        ms = conex.get(cod)
        pj = r.SigTipoConsumidor == 'PJ'
        p.append([
            round(x, 5), round(y, 5), round(float(r.MdaPotenciaInstaladaKW or 0), 2),
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
            n,
        ])

    ref = txt(d.AnmPeriodoReferencia.iloc[0])
    doc = {
        'fonte': f'ANEEL · Relação de empreendimentos de GD (ref. {ref}) · data de conexão: SIGEL/ANEEL',
        'classes': CLASSES,
        'campos': ['x', 'y', 'kw', 'c', 'cod', 'titular', 'doc', 'tipoCons', 'cep', 'mun', 'ag', 'cls', 'sub',
                   'mod', 'porte', 'qtdUC', 'dtAtual', 'dtConex', 'local', 'se', 'nPonto'],
        'dic': {k: v[0] for k, v in dic.items()},
        'p': p,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUT, 'wt', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    mw = d.MdaPotenciaInstaladaKW.sum() / 1000
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
