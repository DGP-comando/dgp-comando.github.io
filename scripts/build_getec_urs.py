#!/usr/bin/env python3
"""Unidades de Referência (URs) cadastradas no GETEC (SISATER), todos os projetos.

Fonte: GETEC com login (GETEC_USUARIO/GETEC_SENHA no .env, ver
build_getec_grupos.py). Uma chamada a lista/lista_ur4.php?id=<codext>&nivel=1
por extensionista (os dos selects de cad_ur3.php e rel_cad_ur.php, ~850):
ano, projeto, produtor e município de cada UR. A soma bate, regional a
regional, com o relatório nominal "UR por Região" (rel_ur_reg); o resumo do
relatório estadual (rel_ur_est) conta outra coisa e não fecha (760 x ~640).

Ponto da UR, em ordem:
  1. família da CAF com um membro de nome igual no município da UR;
  2. idem com nome aproximado (todo nome da UR presente no da CAF, aceitando
     inicial abreviada e um erro de digitação; 1º e último nomes batem);
  3. nome igual, único no estado, numa família da CAF de outro município;
  4. produtor das explorações pecuárias da ADAPAR no município (um ponto só);
  5. sem nada disso (ou homônimos): centro do município, em anel.
O ponto da CAF é o de caf-pontos.json (build_caf.py). "Também em" marca a UR
que já está numa planilha de programa (urs-*-pr.geojson, build_urs_programas)
ou no diagnóstico de agroindústrias (agroindustrias-idr-pr.geojson).

LGPD: nome do produtor + coordenada = dado pessoal; saída só no bucket
privado. CPF e número da CAF não são gravados.

Saída: data/privado/getec-urs-pr.geojson
Uso:   py -3 scripts/build_getec_urs.py
       SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/upload_privado.py getec-urs
"""

import gzip
import html
import json
import math
import re
import unicodedata
from collections import defaultdict
from difflib import SequenceMatcher

from shapely.geometry import Point

import build_getec_grupos as getec
from build_urs_programas import OK, PRIV, Base, feature, write

SAIDA = 'getec-urs-pr.geojson'
CENTRO = 'sem ponto na CAF nem na ADAPAR: ponto no centro do município'
FORA = 'ponto da família na CAF fora do município da UR'
PARTICULAS = {'DE', 'DA', 'DO', 'DOS', 'DAS', 'E'}
PLANILHAS = {
    'urs-graos-pr.geojson': ('Programa Grãos (UIRTs)', 'Produtor'),
    'urs-cafe-pr.geojson': ('Programa Café', 'Produtor'),
    'urs-pecuaria-corte-pr.geojson': ('Pecuária de Corte (Purunã/Moderna)', 'Produtor'),
    'agroindustrias-idr-pr.geojson': ('Diagnóstico de agroindústrias', 'Produtor responsável'),
}


def chave(s: str) -> str:
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().upper()
    return ' '.join(re.sub(r'[^A-Z ]', ' ', s).split())


def nomes(s: str) -> list[str]:
    return [t for t in chave(s).split() if t not in PARTICULAS]


def parecido(a: str, b: str) -> bool:
    return a == b or (len(a) > 3 and SequenceMatcher(None, a, b).ratio() >= 0.8)


def compativel(a: str, b: str) -> bool:
    """Mesma pessoa com grafias diferentes: 1º e último batem e todo nome do mais curto está no outro."""
    a, b = nomes(a), nomes(b)
    if len(a) < 2 or len(b) < 2 or not parecido(a[0], b[0]) or not parecido(a[-1], b[-1]):
        return False
    curto, longo = (a, b) if len(a) <= len(b) else (b, a)
    return all(any((len(t) == 1 and x.startswith(t)) or parecido(t, x) for x in longo) for t in curto)


def _demo() -> None:
    assert compativel('Diego Vinicuis da Fraga', 'DIEGO VINICIUS DA FRAGA')
    assert compativel('Claudenir José B. Sebrian', 'CLAUDENIR JOSE BELFIORI SEBRIAN')
    assert compativel('Luiz F.Pawlak', 'LUIZ FRANCISCO PAWLAK')
    assert not compativel('Paulo Henrique da Silva', 'PAULO ANTONIO DA SILVA')
    assert not compativel('Pedro Alcantara Ribeiro Neto', 'PEDRO GONCALVES NETO')
    assert not compativel('Jose Francisco dos Santos', 'JOSE ANTONIO DOS SANTOS')
    assert chave('São  José') == 'SAO JOSE'


# ----------------------------------------------------------------- GETEC

def extensionistas(s) -> list[tuple[str, str]]:
    """(codext, nome) dos selects de extensionista das telas de UR."""
    out: dict[str, str] = {}
    for pagina, sel in [('cad_ur3.php', '1'), ('rel_cad_ur.php', '509')]:
        r = s.get(getec.BASE + 'principal.php', params={'content': pagina}, timeout=60)
        # Os selects vêm em UTF-8 (o resto da página mistura latin1): ler como latin1 quebra "João".
        texto = r.content.decode('utf-8', errors='replace')
        m = re.search(r'<select[^>]*id=["\']?' + sel + r'\b[^>]*>(.*?)</select>', texto, flags=re.S)
        if not m:
            raise SystemExit(f'select de extensionistas não encontrado em {pagina} (sessão caiu?)')
        for v, nome in re.findall(r'value=["\']?([^"\' >]*)["\']?[^>]*>([^<]*)', m.group(1)):
            if v not in ('', '-1', '0'):
                out.setdefault(v, html.unescape(nome).strip())
    return list(out.items())


def urs_do_extensionista(s, cod: str, nome: str) -> list[dict]:
    r = s.get(getec.BASE + 'lista/lista_ur4.php', params={'id': cod, 'nivel': 1}, timeout=60)
    r.encoding = 'utf-8'
    corpo = re.sub(r'<script.*?</script>|<style.*?</style>', '', r.text, flags=re.S)
    out = []
    for linha in re.findall(r'<tr.*?</tr>', corpo, flags=re.S):
        c = [' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', x)).split())
             for x in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', linha, flags=re.S)]
        if c[:4] == ['Ano', 'Projeto', 'Produtor', 'Municipio']:
            c = c[4:]
        out += [{'ano': c[k], 'projeto': c[k + 1], 'produtor': c[k + 2], 'municipio': c[k + 3], 'extensionista': nome}
                for k in range(0, len(c) - 3, 4) if re.fullmatch(r'\d{4}', c[k])]
    return out


def baixa_urs() -> list[dict]:
    getec.carregar_env()
    s = getec.entrar()
    exts = extensionistas(s)
    urs = [u for cod, nome in exts for u in urs_do_extensionista(s, cod, nome)]
    print(f'GETEC: {len(exts)} extensionistas, {len(urs)} URs')
    return urs


# ------------------------------------------------------------ ligações

def indices():
    membros = defaultdict(list)  # ibge -> [(nome, caf)]
    estado = defaultdict(set)    # nome -> {caf}
    for f in (PRIV / 'caf').glob('*.json'):
        d = json.loads(f.read_text(encoding='utf-8'))
        for caf, fam in d['familias'].items():
            for m in fam.get('membros') or []:
                membros[d['ibge']].append((m.get('nome') or '', caf))
                estado[chave(m.get('nome'))].add(caf)
    pontos = {str(p[2]): (p[0], p[1]) for p in json.loads((PRIV / 'caf-pontos.json').read_text(encoding='utf-8'))['p']}
    adp = json.loads(gzip.decompress((PRIV / 'adapar-exploracoes.json.gz').read_bytes()))
    adapar = defaultdict(set)    # (ibge, nome) -> {(lon, lat)}
    for p in adp['p']:
        for nome in (p[8] or '').split('; '):
            adapar[(adp['municipios'][p[2]][0], chave(nome.split(' e mais ')[0]))].add((p[0], p[1]))
    planilhas = defaultdict(list)  # ibge -> [(nome, rótulo)]
    for arq, (rotulo, campo) in PLANILHAS.items():
        for f in json.loads((PRIV / arq).read_text(encoding='utf-8'))['features']:
            p = f['properties']
            if p.get(campo) and p.get('ibge'):
                planilhas[str(p['ibge'])].append((p[campo], rotulo))
    return membros, estado, pontos, adapar, planilhas


def liga(u: dict, ibge: str, idx) -> tuple[tuple | None, str]:
    """(lon, lat) ou None e a origem do ponto."""
    membros, estado, pontos, adapar, _ = idx
    nome = u['produtor']
    exato = {caf for n, caf in membros[ibge] if chave(n) == chave(nome)}
    aprox = {caf for n, caf in membros[ibge] if compativel(nome, n)}
    outro = estado.get(chave(nome), set())
    adp = adapar.get((ibge, chave(nome)), set())
    for cafs, origem in [(exato, 'família na CAF (nome no município)'),
                         (aprox, 'família na CAF (nome aproximado no município)'),
                         (outro, 'família na CAF de outro município (nome único no estado)')]:
        if len(cafs) == 1:
            caf = next(iter(cafs))
            return pontos.get(caf), origem if caf in pontos else f'{origem}, sem ponto'
    if len(adp) == 1:
        return next(iter(adp)), 'produtor nas explorações pecuárias da ADAPAR'
    if len(exato) > 1 or len(aprox) > 1 or len(outro) > 1 or len(adp) > 1:
        return None, 'homônimos na CAF/ADAPAR: sem como escolher'
    return None, 'produtor não encontrado na CAF nem na ADAPAR'


def espalha(feats: list[dict]) -> None:
    """URs no centro do mesmo município: anel de >= ~300 m, ~60 m entre vizinhas."""
    por_mun = defaultdict(list)
    for f in feats:
        if f['properties']['Checagem da coordenada'] == CENTRO:
            por_mun[f['properties']['ibge']].append(f)
    for grupo in por_mun.values():
        if len(grupo) < 2:
            continue
        raio = max(0.003, len(grupo) * 0.0006 / (2 * math.pi))
        for i, f in enumerate(grupo):
            a = 2 * math.pi * i / len(grupo)
            x, y = f['geometry']['coordinates']
            f['geometry']['coordinates'] = [round(x + raio * math.cos(a), 5), round(y + raio * math.sin(a), 5)]


def main() -> None:
    _demo()
    urs = baixa_urs()
    base = Base()
    idx = indices()
    feats, sem_mun = [], []
    for u in urs:
        mun = base.municipio(u['municipio'])
        if not mun:
            sem_mun.append(u['municipio'])
            continue
        ibge, nome_mun = mun
        pt, origem = liga(u, ibge, idx)
        if pt:
            checagem = OK if base.geom[ibge].buffer(0.01).contains(Point(pt)) else FORA
        else:
            c = base.geom[ibge].representative_point()
            pt, checagem = (c.x, c.y), CENTRO
        tambem = sorted({r for n, r in idx[4][ibge] if compativel(u['produtor'], n)})
        feats.append(feature(pt[0], pt[1], {
            'Produtor': u['produtor'], 'Projeto': u['projeto'], 'Ano': u['ano'], 'Município': nome_mun, 'ibge': ibge,
            'Extensionista': u['extensionista'], 'Também em': '; '.join(tambem),
            'Origem do ponto': origem, 'Checagem da coordenada': checagem,
        }))
    if sem_mun:
        raise SystemExit(f'municípios sem correspondência no IBGE: {sorted(set(sem_mun))}')
    espalha(feats)
    feats.sort(key=lambda f: (f['properties']['ibge'], f['properties']['Projeto'], f['properties']['Produtor']))
    write(SAIDA, feats)
    origens = defaultdict(int)
    for f in feats:
        origens[f['properties']['Origem do ponto']] += 1
    for k, v in sorted(origens.items(), key=lambda kv: -kv[1]):
        print(f'  {v:4d}  {k}')
    print(f'  também em planilha/diagnóstico: {sum(1 for f in feats if f["properties"].get("Também em"))}')


if __name__ == '__main__':
    main()
