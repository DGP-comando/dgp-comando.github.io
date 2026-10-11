#!/usr/bin/env python3
"""Estabelecimentos de saúde do PR (CNES/DATASUS), com todos os campos do cadastro.

Fontes (brutos do repositório saude-parana, fora deste):
  - data/raw/cnes_estabelecimentos_csv.zip: CNES nacional (Portal de Dados
    Abertos do SUS); aqui só CO_UF = 41 e ativos (CO_MOTIVO_DESAB vazio).
  - data/raw/leitos_pr.csv: leitos existentes, SUS e UTI por CNES (CGHID/MS),
    última competência.
  - dashboard/public/data/estabelecimentos.json: nome e região de saúde por
    município.
  - Naturezas.zip da Receita (RF_AUX, opcional): nome da natureza jurídica.

Pontos no mesmo lugar (mesma coordenada) saem espalhados em espiral, como no
CNPJ agro. Saída: data/privado/cnes-saude-pr.json.gz (bucket datageo-privado):
consultório isolado de pessoa física traz nome, telefone e e-mail, autorizado
(plataforma com login e termo).

Uso: py -3 scripts/build_cnes_saude.py   (SAUDE_PARANA e RF_AUX sobrescrevem)
     SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/upload_privado.py cnes-saude
"""

import csv
import gzip
import io
import json
import os
import zipfile
from collections import defaultdict
from pathlib import Path

from build_cnpj_agro import girassol, tabela

SAUDE = Path(os.environ.get('SAUDE_PARANA', Path(__file__).resolve().parents[2] / 'saude-parana'))
AUX = Path(os.environ.get('RF_AUX', '/tmp/rf'))
OUT = Path(__file__).resolve().parent.parent / 'data' / 'privado' / 'cnes-saude-pr.json.gz'

# Famílias do saude-parana (scripts/etl/cnes_tipos.py), na ordem da legenda.
CLASSES = [
    ('Unidades básicas de saúde', {'1', '2', '71', '72'}),
    ('Hospitais', {'5', '7', '15', '62'}),
    ('Pronto atendimento e pronto socorro', {'20', '21', '73'}),
    ('Atenção psicossocial (CAPS)', {'70'}),
    ('Clínicas, policlínicas e consultórios', {'4', '22', '36', '61'}),
    ('Diagnóstico, laboratórios e hemoterapia', {'39', '67', '69', '80'}),
    ('Farmácias', {'43'}),
    ('Vigilância, regulação e gestão', {'50', '64', '68', '75', '76', '81', '82', '84'}),
    ('Outros', set()),
]
TIPOS = {
    '1': 'Posto de saúde', '2': 'Centro de saúde / unidade básica', '4': 'Policlínica',
    '5': 'Hospital geral', '7': 'Hospital especializado', '15': 'Unidade mista',
    '16': 'Pronto socorro (código legado)',
    '20': 'Pronto socorro geral', '21': 'Pronto socorro especializado', '22': 'Consultório isolado',
    '32': 'Unidade móvel fluvial', '36': 'Clínica / centro de especialidade',
    '39': 'Unidade de apoio diagnose e terapia (SADT isolado)', '40': 'Unidade móvel terrestre',
    '42': 'Unidade móvel de nível pré-hospitalar na área de urgência', '43': 'Farmácia',
    '50': 'Unidade de vigilância em saúde', '60': 'Cooperativa ou empresa de cessão de trabalhadores na saúde',
    '61': 'Centro de parto normal (isolado)', '62': 'Hospital/dia (isolado)',
    '64': 'Central de regulação de serviços de saúde', '67': 'Laboratório central de saúde pública (LACEN)',
    '68': 'Central de gestão em saúde', '69': 'Centro de atenção hemoterapia e/ou hematológica',
    '70': 'Centro de atenção psicossocial (CAPS)', '71': 'Centro de apoio à saúde da família',
    '72': 'Unidade de atenção à saúde indígena', '73': 'Pronto atendimento (UPA)', '74': 'Polo academia da saúde',
    '75': 'Telessaúde', '76': 'Central de regulação médica das urgências', '77': 'Serviço de atenção domiciliar isolado (home care)',
    '78': 'Unidade de atenção em regime residencial', '79': 'Oficina ortopédica',
    '80': 'Laboratório de saúde pública', '81': 'Central de regulação do acesso',
    '82': 'Central de notificação, captação e distribuição de órgãos estadual', '83': 'Polo de prevenção de doenças e agravos e promoção da saúde',
    '84': 'Central de abastecimento', '85': 'Centro de imunização',
}
GESTAO = {'M': 'Municipal', 'E': 'Estadual', 'D': 'Dupla'}
ENSINO = {'01': 'Unidade universitária', '02': 'Escola superior isolada', '03': 'Unidade auxiliar de ensino',
          '05': 'Hospital de ensino'}  # '04' = sem atividade de ensino (fica vazio)
SERVICOS = [('ST_CENTRO_CIRURGICO', 'centro cirúrgico'), ('ST_CENTRO_OBSTETRICO', 'centro obstétrico'),
            ('ST_CENTRO_NEONATAL', 'centro neonatal'), ('ST_ATEND_HOSPITALAR', 'atendimento hospitalar'),
            ('ST_ATEND_AMBULATORIAL', 'atendimento ambulatorial'), ('ST_SERVICO_APOIO', 'serviço de apoio')]
BBOX = (-55.0, -48.0, -27.0, -22.0)


def classe(tp: str) -> int:
    tp = tp.lstrip('0')
    return next((i for i, (_, tipos) in enumerate(CLASSES) if tp in tipos), len(CLASSES) - 1)


def coord(lon: str, lat: str):
    try:
        x, y = float(lon), float(lat)
    except ValueError:
        return None
    return (x, y) if BBOX[0] < x < BBOX[1] and BBOX[2] < y < BBOX[3] else None


def cnpj_fmt(c: str) -> str:
    c = (c or '').strip()
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}' if len(c) == 14 and c.isdigit() else c


def cep_fmt(c: str) -> str:
    c = (c or '').strip()
    return f'{c[:5]}-{c[5:]}' if len(c) == 8 and c.isdigit() else c


def leitos():
    """CNES (7 díg.) -> [existentes, SUS, UTI existentes, UTI SUS] na última competência."""
    with open(SAUDE / 'data' / 'raw' / 'leitos_pr.csv', encoding='latin-1', newline='') as fh:
        rows = list(csv.DictReader(fh, delimiter=';'))
    comp = max(r['COMP'] for r in rows)
    out = {}
    for r in rows:
        if r['COMP'] == comp and not r['MOTIVO_DESABILITACAO'].strip():
            v = [int(r[k] or 0) for k in ('LEITOS_EXISTENTES', 'LEITOS_SUS', 'UTI_TOTAL_EXIST', 'UTI_TOTAL_SUS')]
            out[r['CNES'].zfill(7)] = [a + b for a, b in zip(out.get(r['CNES'].zfill(7), [0] * 4), v)]
    return comp, out


def main() -> None:
    est = json.loads((SAUDE / 'dashboard' / 'public' / 'data' / 'estabelecimentos.json').read_text(encoding='utf-8'))
    muns = {m['cod_ibge'][:6]: m for m in est['porMunicipio']}
    naturezas = tabela('Naturezas.zip') if (AUX / 'Naturezas.zip').exists() else {}
    naturezas = {'4000': 'Pessoa Física', **naturezas}  # código só do CNES, fora da tabela da Receita
    if not naturezas:
        print('AVISO: sem Naturezas.zip (RF_AUX), natureza jurídica só com o código')
    comp_leitos, por_cnes = leitos()

    regs, sem_coord = [], 0
    with zipfile.ZipFile(SAUDE / 'data' / 'raw' / 'cnes_estabelecimentos_csv.zip') as z:
        with z.open('cnes_estabelecimentos.csv') as fh:
            for r in csv.DictReader(io.TextIOWrapper(fh, encoding='latin-1', newline=''), delimiter=';'):
                if r['CO_UF'] != '41' or r['CO_MOTIVO_DESAB'].strip():
                    continue
                xy = coord(r['NU_LONGITUDE'], r['NU_LATITUDE'])
                if xy is None:
                    sem_coord += 1
                    continue
                regs.append((r, xy))

    grupos = defaultdict(list)
    for i, (_, (x, y)) in enumerate(regs):
        grupos[(round(x, 5), round(y, 5))].append(i)
    pos = {}
    for (x, y), idx in grupos.items():
        for i, xy in zip(idx, girassol(x, y, len(idx), passo_m=25.0)):
            pos[i] = (xy, len(idx) > 1)

    p = []
    for i, (r, _) in enumerate(regs):
        (x, y), esp = pos[i]
        cnes = r['CO_CNES'].zfill(7)
        m = muns.get(r['CO_IBGE'], {})
        nat = r['CO_NATUREZA_JUR'].strip()
        lt = por_cnes.get(cnes)
        p.append({
            'x': round(x, 6), 'y': round(y, 6), 'esp': int(esp), 'c': classe(r['TP_UNIDADE']),
            'cnes': cnes, 'fantasia': r['NO_FANTASIA'].strip(), 'razao': r['NO_RAZAO_SOCIAL'].strip(),
            'tipo': TIPOS.get(r['TP_UNIDADE'].lstrip('0'), f'Tipo {r["TP_UNIDADE"]}'),
            'cnpj': cnpj_fmt(r['NU_CNPJ']), 'mantenedora': cnpj_fmt(r['NU_CNPJ_MANTENEDORA']),
            'natureza': f'{nat} {naturezas.get(nat, "")}'.strip(),
            'esfera': r['DS_ESFERA_ADMINISTRATIVA'].strip().capitalize(), 'gestao': GESTAO.get(r['TP_GESTAO'], r['TP_GESTAO']),
            'sus': r['CO_AMBULATORIAL_SUS'].upper() == 'SIM' or bool(lt and lt[1]),
            'turno': r['DS_TURNO_ATENDIMENTO'].strip().capitalize(), 'ensino': ENSINO.get(r['CO_ATIVIDADE'], ''),
            'servicos': [n for k, n in SERVICOS if r[k].startswith('1')],
            'leitos': lt,
            'end': ', '.join(v for v in (r['NO_LOGRADOURO'].strip(), r['NU_ENDERECO'].strip()) if v),
            'bairro': r['NO_BAIRRO'].strip(), 'cep': cep_fmt(r['CO_CEP']),
            'mun': m.get('municipio', r['CO_IBGE']), 'rs': m.get('regiao_saude', ''),
            'tel': r['NU_TELEFONE'].strip(), 'email': r['NO_EMAIL'].strip().lower(),
        })

    doc = {
        'fonte': f'CNES/DATASUS (Portal de Dados Abertos do SUS, cadastro de {est["metadata"].get("competenciaCnes", "")}) · '
                 f'leitos CGHID/MS ({comp_leitos})',
        'classes': [c for c, _ in CLASSES],
        'p': p,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUT, 'wt', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(p)} pontos ({sum(v["esp"] for v in p)} espalhados, {sem_coord} sem coordenada fora) '
          f'-> {OUT.name} {OUT.stat().st_size / 1e6:.1f} MB')


def _testes() -> None:
    assert classe('5') == 1 and classe('05') == 1 and classe('73') == 2 and classe('22') == 4 and classe('85') == 8
    assert coord('-49.1', '-25.3') == (-49.1, -25.3) and coord('0.0', '0.0') is None and coord('', '') is None
    assert cnpj_fmt('07088017000191') == '07.088.017/0001-91' and cnpj_fmt('') == ''
    assert cep_fmt('83434286') == '83434-286'


if __name__ == '__main__':
    _testes()
    main()
