"""CAF jurídicas (associações, cooperativas, empreendimentos familiares) do PR e seus sócios.

Entrada: a mesma extração do MDA de build_caf.py (pasta CAFS - PJ) e as
saídas dele em data/privado/ (rodar build_caf.py antes).

Saída: data/privado/caf-pj.json (bucket privado): cada PJ com dados,
responsável, contato, endereço, posição geocodificada, as famílias sócias
(nr_caf da CAF PF, para destacar no mapa), os sócios sem CAF PF e, nas
centrais, as cooperativas filiadas. Mais um resumo por município (PJ com sede
ali e famílias associadas a alguma PJ) para a ficha.

Vínculo sócio -> família: CPF do sócio = CPF de um membro de CAF PF (94%
casam; cada CPF cai numa família só).

Localização: a extração da PJ não tem coordenada. Geocodifica em cascata,
aceitando só ponto DENTRO do município da sede:
  1. rua + número (Nominatim/OSM, 1 req/s, política de uso do OSM), e a
     mesma rua em busca livre, sem número;
  2. CEP (AwesomeAPI; CEP geral do município, final 000, não serve);
  3. assentamento do INCRA de mesmo nome no município (endereço "PA X");
  4. sede urbana do município (onde fica o CEP geral), pelo Nominatim;
  5. ponto interno do município.
`precisao` diz qual valeu. Cache em .gev-cache/ (fora do git e do bucket):
reexecutar não repete consulta.

    py -3 scripts/build_caf_pj.py
"""
import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely

from build_caf import E25, PRIV, PUB, REF, cpf, norm

PJ = E25.parent.parent / 'CAFS - PJ' / 'ARQUIVOS'
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / '.gev-cache' / 'geocode-caf-pj.json'
OUT = PRIV / 'caf-pj.json'
UA = 'datageo-pr/1.0 (geocodificação de CAF PJ; avnerpaesgomes@gmail.com)'
TIPOS = ['Associação', 'Cooperativa Singular', 'Cooperativa Central', 'Empreendimento Familiar']


def get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'pt-BR'})
    for tentativa in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as err:  # rede instável: tenta de novo, depois desiste (cai no próximo nível)
            if tentativa == 2:
                print(f'    falha {url[:90]}: {err}')
                return None
            time.sleep(2 * (tentativa + 1))


def nominatim(rua, numero, cidade):
    q = {'format': 'json', 'limit': 3, 'countrycodes': 'br', 'state': 'Paraná', 'city': cidade,
         'street': f'{numero} {rua}' if numero and numero not in ('0', 'SN', 'S/N') else rua}
    time.sleep(1.1)  # política do Nominatim: no máximo 1 req/s
    return get_json('https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(q)) or []


def nominatim_livre(q):
    time.sleep(1.1)
    return get_json('https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(
        {'format': 'json', 'limit': 3, 'countrycodes': 'br', 'q': q})) or []


ASSENT = re.compile(r'\b(PROJETO DE ASSENTAMENTO|ASSENTAMENTO|ACAMPAMENTO|PA)\b\s*')


def assentamento(logradouro, ibge, assentamentos):
    """Ponto interno do assentamento do INCRA citado no endereço, no mesmo município."""
    s = norm(logradouro)
    if not ASSENT.search(s):
        return None
    nome = ASSENT.sub('', s).strip()
    for a in assentamentos.get(ibge, []):
        alvo = re.sub(r'^(PA|PE|PDS|PCA)\s+', '', a['nome'])
        if len(nome) >= 4 and (nome in alvo or alvo in nome):
            return a['ponto']
    return None


def awesome_cep(cep):
    d = get_json(f'https://cep.awesomeapi.com.br/json/{cep}')
    return d if isinstance(d, dict) and d.get('lat') else None


def geocodifica(e, poly, cache, assentamentos):
    """(lon, lat, precisao) para o endereço `e`, dentro de `poly` (município da sede)."""
    chave = f'{e.ds_logradouro}|{e.nr_logradouro}|{e.nr_cep}|{e.cd_municipio}'
    if chave not in cache:
        res = {'rua': [], 'cep': None}
        if e.ds_logradouro.strip():
            res['rua'] = [(float(r['lon']), float(r['lat'])) for r in nominatim(e.ds_logradouro, e.nr_logradouro, e.nm_municipio)]
        cep = ''.join(c for c in e.nr_cep if c.isdigit())
        if len(cep) == 8 and not cep.endswith('000'):
            c = awesome_cep(cep)
            res['cep'] = (float(c['lng']), float(c['lat'])) if c else None
        cache[chave] = res
        CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf-8')
    res = cache[chave]
    dentro = lambda pts: next(((x, y) for x, y in pts if shapely.contains_xy(poly, x, y)), None)
    if (pt := dentro(res['rua'])):
        return (*pt, 'rua')
    if res['cep'] and shapely.contains_xy(poly, *res['cep']):
        return (*res['cep'], 'cep')
    if (pt := assentamento(e.ds_logradouro, e.cd_municipio, assentamentos)):
        return (*pt, 'assentamento')
    # Níveis mais caros só para quem não achou nos de cima (e só uma vez: cache).
    if 'livre' not in res:
        res['livre'] = [] if not e.ds_logradouro.strip() else [
            (float(r['lon']), float(r['lat'])) for r in nominatim_livre(f'{e.ds_logradouro}, {e.nm_municipio}, Paraná')]
        res['sede'] = [(float(r['lon']), float(r['lat'])) for r in nominatim_livre(f'{e.nm_municipio}, Paraná')]
        CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf-8')
    if (pt := dentro(res['livre'])):
        return (*pt, 'rua')
    if (pt := dentro(res['sede'])):
        return (*pt, 'sede')
    p = poly.representative_point()
    return p.x, p.y, 'municipio'


def espalha(pjs):
    """Mesmo ponto (sede do município, CEP geral): abre em anel de ~300 m para não sobrepor."""
    por_ponto = {}
    for p in pjs:
        por_ponto.setdefault((round(p['lon'], 4), round(p['lat'], 4)), []).append(p)
    for grupo in por_ponto.values():
        if len(grupo) < 2:
            continue
        for i, p in enumerate(grupo):
            a = 2 * math.pi * i / len(grupo)
            p['lon'] = round(p['lon'] + 0.003 * math.cos(a), 6)
            p['lat'] = round(p['lat'] + 0.003 * math.sin(a), 6)


def main():
    r = lambda n: pd.read_csv(PJ / n, dtype=str, keep_default_na=False, encoding='utf-8')
    dados, resp, end, cont = r('01 - DADOS_PESSOA_JURIDICA.csv'), r('02 - RESPONSAVEL.csv'), r('03 - ENDERECO.csv'), r('04 - CONTATO.csv')
    socios, falhas = r('05 - SOCIOS_CAF.csv'), r('06 - SOCIOS_FALHA.csv')
    dados = dados.drop_duplicates('nr_caf').set_index('nr_caf')
    resp, end = resp.drop_duplicates('nr_caf').set_index('nr_caf'), end.drop_duplicates('nr_caf').set_index('nr_caf')

    membros = pd.read_csv(E25 / '02 - MEMBROS_FAMILIARES.csv', dtype=str, keep_default_na=False, usecols=['nr_caf', 'nr_cpf'])
    fam_de_cpf = dict(zip(membros.nr_cpf.map(cpf), membros.nr_caf))
    pontos = json.loads((PRIV / 'caf-pontos.json').read_text(encoding='utf-8'))
    ibge_fam = {str(p[2]): p[3] for p in pontos['p']}
    no_mapa = set(ibge_fam)
    # Município de toda família (inclusive sem ponto), para o resumo da ficha.
    for arq in (PRIV / 'caf').iterdir():
        for k in json.loads(arq.read_text(encoding='utf-8'))['familias']:
            ibge_fam.setdefault(k, arq.stem)
    cnpj_caf = {c: k for k, c in dados.nr_cnpj.items()}

    mun = gpd.read_file(PUB / 'municipios-pr.geojson').to_crs('EPSG:4674')
    poly = {str(m.CD_MUN): m.geometry for m in mun.itertuples()}
    cache = json.loads(CACHE.read_text(encoding='utf-8')) if CACHE.exists() else {}
    ag = gpd.read_file(PUB / 'assentamentos-incra-pr.geojson').to_crs('EPSG:4674')
    ibge_de = {norm(m.NM_MUN): str(m.CD_MUN) for m in mun.itertuples()}
    assentamentos = {}
    for a in ag.itertuples():
        pt = a.geometry.representative_point()
        assentamentos.setdefault(ibge_de.get(norm(a.municipio)), []).append({'nome': norm(a.nome), 'ponto': (pt.x, pt.y)})
    CACHE.parent.mkdir(exist_ok=True)

    pjs = []
    for i, (caf, d) in enumerate(dados.iterrows()):
        e = end.loc[caf] if caf in end.index else None
        ibge = e.cd_municipio if e is not None else ''
        if ibge not in poly:
            print(f'  CAF PJ {caf} sem município do PR no endereço; fora do mapa')
            continue
        lon, lat, prec = geocodifica(e, poly[ibge], cache, assentamentos)
        s = socios[socios.nr_caf == caf]
        pf = s[s.nr_cpf != '']
        fams, sem = [], []
        for c, nome in zip(pf.nr_cpf.map(cpf), pf.nm_pessoa_fisica):
            k = fam_de_cpf.get(c)
            if k:
                fams.append(k)
            else:
                sem.append(nome)
        filiadas = [cnpj_caf[c] for c in s[s.nr_cnpj != ''].nr_cnpj if c in cnpj_caf]
        rp = resp.loc[caf] if caf in resp.index else None
        pjs.append({
            'caf': caf, 'cnpj': d.nr_cnpj, 'razao': d.nm_razao_social, 'fantasia': d.nm_fantasia, 'tipo': d.ds_tipo_caf,
            'constituicao': d.dt_constituicao, 'inscricao': d.dt_inscricao, 'validade': d.dt_validade,
            'atualizacao': d.dt_atualizacao[:10], 'emissor': d['nm_razao_social.1'], 'cadastrador': d.nm_usuario,
            'responsavel': None if rp is None else {'nome': rp.nm_usuario, 'cpf': rp.nr_cpf,
                                                    'nome_t': rp.nm_usuario_t, 'cpf_t': rp.nr_cpf_t},
            'endereco': {'logradouro': e.ds_logradouro, 'numero': e.nr_logradouro, 'complemento': e.ds_complemento,
                         'referencia': e.ds_referencia, 'municipio': e.nm_municipio, 'cep': e.nr_cep},
            'contatos': [{'email': c.ds_email, 'telefone': c.nr_telefone} for c in cont[cont.nr_caf == caf].itertuples()],
            'ibge': ibge, 'lon': round(lon, 6), 'lat': round(lat, 6), 'precisao': prec,
            'familias': sorted(set(fams), key=int),
            'familias_no_mapa': sum(1 for k in set(fams) if k in no_mapa),
            'socios_sem_caf': sem,
            'falhas': falhas[falhas.nr_caf == caf].ds_erro.value_counts().to_dict(),
            'filiadas': filiadas,
        })
        if (i + 1) % 50 == 0:
            print(f'  {i + 1}/{len(dados)} PJ')
    espalha(pjs)

    # Resumo por município: PJ com sede ali (por tipo) e famílias sócias de alguma PJ.
    municipios = {}
    for p in pjs:
        m = municipios.setdefault(p['ibge'], {'pj': {t: 0 for t in TIPOS}, 'associadas': set()})
        m['pj'][p['tipo']] = m['pj'].get(p['tipo'], 0) + 1
    for p in pjs:
        for k in p['familias']:
            ib = ibge_fam.get(k)
            if ib:
                municipios.setdefault(ib, {'pj': {t: 0 for t in TIPOS}, 'associadas': set()})['associadas'].add(k)
    resumo = {ib: {'pj': m['pj'], 'associadas': len(m['associadas'])} for ib, m in municipios.items()}

    OUT.write_text(json.dumps({'fonte': 'MDA · CAF PJ, extração entregue ao IDR-Paraná', 'referencia': REF['2025-10'],
                               'tipos': TIPOS, 'pj': pjs, 'municipios': resumo},
                              ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    prec = pd.Series([p['precisao'] for p in pjs]).value_counts().to_dict()
    vinc = {k for p in pjs for k in p['familias']}
    print(f'{len(pjs)} PJ -> {OUT.name} ({OUT.stat().st_size // 1024} KB) · precisão {prec} · '
          f'{len(vinc)} famílias sócias · {sum(len(p["socios_sem_caf"]) for p in pjs)} sócios sem CAF PF')


if __name__ == '__main__':
    main()
