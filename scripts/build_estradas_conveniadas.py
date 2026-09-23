#!/usr/bin/env python3
"""Gera data/privado/estradas-conveniadas-pr.geojson.

Três conjuntos de estradas rurais da SEAB, cada feição marcada em `grupo`:
  - conveniadas: convênios de 2026 (SET, preliminar), 96 trechos com
    convênio, protocolo, município, valores, empenho e pagamento;
  - protocolos:  protocolos de 2025 (KMZ), nome e descrição do trecho;
  - automatizado: malha de 2025 traçada por rede (matriz origem-destino),
    só extensão e ids de origem/destino.

Entradas em data/estradas-conveniadas/ (os arquivos recebidos, sem edição).
Fica de fora o CNPJ do colaborador e as colunas do processamento SIG que
vieram junto (layer, path com caminho e usuário da máquina, custos de rede).

Os acentos das conveniadas chegaram PERDIDOS: o DBF (e o KML exportado dele)
traz U+FFFD no lugar de cada letra acentuada ("Mambor�", "Pavimenta��o").
Não é leitura errada, os bytes já estão assim. `reparar()` devolve a palavra
casando cada � com uma letra contra um vocabulário acentuado (municípios do
PR, textos do KMZ de protocolos, que veio íntegro, e VOCAB_EXTRA). Palavra
ambígua ou desconhecida fica como está e sai listada no fim da execução:
acrescente-a em VOCAB_EXTRA. Pedir o arquivo de novo à SEAB resolve de vez.

Uso (precisa do GDAL, o Python do QGIS serve):
  "C:\\Program Files\\QGIS 4.2.2\\bin\\python-qgis.bat" scripts/build_estradas_conveniadas.py
"""

import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

from osgeo import gdal, ogr, osr

ogr.UseExceptions()
ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / 'data' / 'estradas-conveniadas').as_posix()
OUT = ROOT / 'data' / 'privado' / 'estradas-conveniadas-pr.geojson'
MUNICIPIOS = ROOT / 'public' / 'data' / 'municipios-pr.geojson'
LOST = '�'
# Palavras das conveniadas que não estão nos municípios nem nos protocolos.
VOCAB_EXTRA = (
    'Pavimentação Integração Apresentação Recuperação Readequação Cascalhamento '
    'Conservação Manutenção Situação Lançado Lançada Pagamento Vigência Núcleo '
    'Município Extensão Convênio Poliédrico Poliédrica Paralelepípedo Básico '
    'Ribeirão Córrego Água Águas São Tupinambá Três Médio Pátio Colônia Linha '
    'Estrada Rodovia Anhumaí Guaraciaba Inácio início Avião Biguá Crianças Demétrio '
    'Eleutério Galvão Gesuíno Gonçalves Góes Guairacazão Guaritá Humaitá Indianópoles '
    'Longuinópolis Mãe Paiquerê Palmitolândia René Sertãozinho Sérgio Taquaruçu '
    'Travessão Vorá muncípio Golçalves'
)

CONVENIADAS = f'/vsizip/{SRC}/conveniadas-2026-set-preliminar.zip/Estradas Rurais SEAB 2026_prel.shp'
PROTOCOLOS = f'/vsizip/{SRC}/protocolos-2025.kmz/doc.kml'
AUTOMATIZADO = f'/vsizip/{SRC}/automatizado-2025.zip/Estradas_automatizado_2025_CORRETO.shp'

# Nome truncado do DBF -> rótulo legível, na ordem da planilha. O que não
# está aqui (CNPJ, colunas de processamento) não sai.
CONVENIADAS_CAMPOS = [
    ('N° CONV°', 'Nº convênio'), ('PROTOCOLO', 'Protocolo'), ('TRECHO', 'Trecho'),
    ('EXTENSÃO', 'Extensão (m)'), ('SETOR', 'Setor'), ('Tipo', 'Tipo'),
    ('MUNICÍPI', 'Município'), ('NÚCLEO R', 'Núcleo regional'), ('PROGRAMA', 'Programa'),
    ('PROJETO', 'Projeto'), ('OBJETO DO', 'Objeto'), ('DETALHES D', 'Detalhes'),
    ('VALOR GLOB', 'Valor global'), ('VALOR SEAB', 'Valor SEAB'),
    ('SEAB (Inve', 'SEAB (investimento)'), ('SEAB (Cust', 'SEAB (custeio)'),
    ('CONTRAPART', 'Contrapartida'), ('FONTE DE R', 'Fonte de recurso'),
    ('MESES VIG°', 'Vigência (meses)'), ('% Obrigato', '% contrapartida obrigatória'),
    ('% Calculad', '% contrapartida calculada'), ('COLABORADO', 'Colaborador'),
    ('DATA ASSIN', 'Assinatura'), ('DATA PUBLI', 'Publicação'),
    ('N° EMPEN', 'Nº empenho'), ('DATA EMP.', 'Data empenho'), ('VALOR EMPE', 'Valor empenhado'),
    ('DATA PAGAM', 'Data pagamento'), ('VALOR PAGO', 'Valor pago'),
    ('FALTA EMPE', 'Falta empenhar'), ('EMPENHADO', 'Empenhado'),
    ('N° EMP_1', 'Nº empenho 2'), ('DATA EMP_1', 'Data empenho 2'), ('VALOR EM_1', 'Valor empenhado 2'),
    ('DATA PAG_1', 'Data pagamento 2'), ('VALOR PA_1', 'Valor pago 2'),
    ('FALTA EM_1', 'Falta empenhar 2'), ('EMPENHAD_1', 'Empenhado 2'),
    ('SIT - TCE/', 'SIT (TCE)'), ('SITUA???', 'Situação')  # truncado no meio do 'Ã',
]
PROTOCOLOS_CAMPOS = [('Name', 'Trecho'), ('description', 'Descrição'), ('DIST_KM', 'Distância (km)')]
AUTOMATIZADO_CAMPOS = [('extensao', 'Extensão (m)'), ('origin_id', 'Origem (id)'), ('destinatio', 'Destino (id)')]

WGS84 = osr.SpatialReference()
WGS84.ImportFromEPSG(4326)
WGS84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
SIMPLIFY_DEG = 0.00003  # ~3 m: traço de obra, não levantamento
DECIMALS = 5            # ~1 m


WORD_RE = re.compile(r'[\w' + LOST + r']+')


def sem_acento(s):
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()


def vocabulario(textos):
    """Contagem das grafias acentuadas (sem o 'ç' de fora: ele também se perde)."""
    vocab = Counter()
    for texto in textos:
        for w in WORD_RE.findall(texto):
            if not w.isascii() and LOST not in w:
                vocab[w] += 1
    return vocab


def reparar(texto, vocab, pendentes):
    """Troca cada palavra com � pela grafia do vocabulário que encaixa.

    Mais de uma candidata: vence a de mesma caixa inicial ("In�cio" é o
    Inácio de Inácio Martins, "in�cio" é início) e, entre essas, a mais
    frequente. Sem candidata a palavra fica como veio, e é listada.
    """
    def troca(m):
        w = m.group(0)
        if LOST not in w:
            return w
        if re.fullmatch(r'\d+' + LOST, w):  # "1� pagamento"
            return w[:-1] + 'º'
        padrao = re.compile(''.join('.' if c == LOST else re.escape(c.lower()) for c in w))
        achados = [(g, n) for g, n in vocab.items() if len(g) == len(w) and padrao.fullmatch(g.lower())]
        mesma_caixa = [(g, n) for g, n in achados if g[:1].isupper() == w[:1].isupper()]
        achados = mesma_caixa or achados
        if not achados:
            pendentes.add(w)
            return w
        g = max(achados, key=lambda a: a[1])[0]
        return g.upper() if w.isupper() else g[:1].upper() + g[1:] if w[:1].isupper() else g.lower()
    return WORD_RE.sub(troca, texto)


def municipio_oficial(nome, municipios):
    """Nome do IBGE para 'Terra roxa', 'In�cio Martins', "Pérola D'Oeste"..."""
    chave = re.compile(''.join('.' if c == LOST else re.escape(c)
                               for c in sem_acento(nome.replace(LOST, '#')).replace('#', LOST)))
    achados = [m for m in municipios if chave.fullmatch(sem_acento(m))]
    return achados[0] if len(achados) == 1 else None


def valor(v):
    if v is None:
        return None
    if isinstance(v, float):
        v = round(v, 2)
        return int(v) if v.is_integer() else v
    v = str(v).strip()
    return v or None


def mesmo_campo(real, nome):
    """Compara nomes de campo ignorando os caracteres não ASCII (perdidos em �)."""
    so_ascii = lambda s: re.sub(r'[^\x00-\x7f]', '?', s)
    return so_ascii(real) == so_ascii(nome)


def campos(feature, defn_names, mapa):
    out = {}
    for nome, rotulo in mapa:
        real = next((n for n in defn_names if mesmo_campo(n, nome)), None)
        if real is None:
            continue
        v = valor(feature.GetField(real))
        if v is not None:
            out[rotulo] = v
    return out


def linhas(geom):
    """LineString/MultiLineString (com ou sem Z) -> lista de [[lon, lat], ...]."""
    geom = geom.Clone()
    geom.FlattenTo2D()
    geom = geom.SimplifyPreserveTopology(SIMPLIFY_DEG)
    partes = [geom] if geom.GetGeometryType() == ogr.wkbLineString else [
        geom.GetGeometryRef(i) for i in range(geom.GetGeometryCount())]
    out = []
    for p in partes:
        pts = [[round(p.GetX(i), DECIMALS), round(p.GetY(i), DECIMALS)] for i in range(p.GetPointCount())]
        if len({tuple(q) for q in pts}) >= 2:
            out.append(pts)
    return out


def ler(path, grupo, mapa, open_options=()):
    ds = gdal.OpenEx(path, gdal.OF_VECTOR, open_options=list(open_options))
    feats = []
    for layer in ds:  # KML tem uma camada por pasta
        srs = layer.GetSpatialRef()
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        tr = osr.CoordinateTransformation(srs, WGS84)
        defn = layer.GetLayerDefn()
        names = [defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())]
        for f in layer:
            g = f.GetGeometryRef()
            if g is None:
                continue
            g = g.Clone()
            g.Transform(tr)
            partes = linhas(g)
            if not partes:
                continue
            feats.append({
                'type': 'Feature',
                'properties': {'grupo': grupo, **campos(f, names, mapa)},
                'geometry': ({'type': 'LineString', 'coordinates': partes[0]} if len(partes) == 1
                             else {'type': 'MultiLineString', 'coordinates': partes}),
            })
    return feats


def main():
    conveniadas = ler(CONVENIADAS, 'conveniadas', CONVENIADAS_CAMPOS)
    protocolos = ler(PROTOCOLOS, 'protocolos', PROTOCOLOS_CAMPOS)
    automatizado = ler(AUTOMATIZADO, 'automatizado', AUTOMATIZADO_CAMPOS)

    municipios = [f['properties']['NM_MUN'] for f in
                  json.loads(MUNICIPIOS.read_text(encoding='utf-8'))['features']]
    vocab = vocabulario(municipios + [VOCAB_EXTRA] + [
        str(v) for f in protocolos for v in f['properties'].values()])
    pendentes = set()
    for f in conveniadas:
        f['properties'] = {k: reparar(v, vocab, pendentes) if isinstance(v, str) else v
                           for k, v in f['properties'].items()}
        for campo in ('Município', 'Núcleo regional'):
            nome = f['properties'].get(campo)
            if nome and nome not in municipios:
                oficial = municipio_oficial(nome, municipios)
                if oficial:
                    f['properties'][campo] = oficial
                else:
                    pendentes.add(f'{campo}? {nome}')

    feats = conveniadas + protocolos + automatizado
    for f in feats:
        assert 'CNPJ' not in json.dumps(f['properties'], ensure_ascii=False)
    if pendentes:
        print('SEM REPARO (acrescente em VOCAB_EXTRA):', sorted(pendentes))
    OUT.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    por_grupo = {}
    for f in feats:
        por_grupo[f['properties']['grupo']] = por_grupo.get(f['properties']['grupo'], 0) + 1
    print(OUT.name, por_grupo, f'{OUT.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
