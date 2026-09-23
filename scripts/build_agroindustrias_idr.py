#!/usr/bin/env python3
"""Gera data/privado/agroindustrias-idr-pr.geojson.

Fonte: diagnóstico das agroindústrias do IDR-Paraná (formulário de 2023),
planilha `dados.xlsx`, aba Campos, uma linha por agroindústria com as
coordenadas digitadas pelo técnico.

LGPD: a planilha e o GETEC trazem CPF, telefone e faturamento do produtor.
Esses campos saem em DROP, e sem_pessoal() apaga CPF ou telefone digitado
dentro de outros campos (responsável, endereço, observações).

As coordenadas vêm em formatos misturados: graus/minutos/segundos com S/O,
graus e minutos decimais, decimal com vírgula, decimal sem o separador
(-262814570), UTM 22S (ou 21S) em metros. `ler_coord()` tenta cada leitura e
fica com a primeira que cai dentro do município declarado (CodIBGE); sem
isso, com a que cai no PR, marcada em "Checagem da coordenada".

Cruzamento com o cadastro do GETEC (getec_agroindustrias_*.json, exportado
do relatório "Agroindustrias e Organizações" do IDR GETEC): ver cruzar_getec().

Uso:
  py -3 scripts/build_agroindustrias_idr.py
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

import openpyxl
from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(r'H:\IDR-PARANA\BI Agroindústria\dados.xlsx')
OUT = ROOT / 'data' / 'privado' / 'agroindustrias-idr-pr.geojson'
GETEC = SRC.parent / 'getec_agroindustrias_2026-09-23.json'
MUNICIPIOS = ROOT / 'public' / 'data' / 'municipios-pr.geojson'

# Coluna da planilha -> rótulo curto do tooltip (na ordem de exibição).
# Colunas ausentes aqui (carimbo, lat/lon brutas, CodIBGE) ficam de fora.
CAMPOS = [
    ('Nome da agroindústria', 'Agroindústria'),
    ('Município', 'Município'),
    ('Região', 'Regional'),
    ('Endereço completo', 'Endereço'),
    ('Nome completo do produtor RESPONSÁVEL PELA AGROINDÚSTRIA', 'Produtor responsável'),
    ('CPF do produtor responsável pela agroindústria', 'CPF'),
    ('Telefone/Whatsapp para contato do produtor responsável (DDD + número):', 'Telefone'),
    ('Técnico responsável pelo cadastro:', 'Técnico do cadastro'),
    ('Tipo de empreendimento', 'Tipo de empreendimento'),
    ('Possui CNPJ?', 'Possui CNPJ'),
    ('Se sim, número do CNPJ? (Se não preencha "zero")', 'CNPJ'),
    ('Agroindústria em situação legal? (Produtos de origem vegetal, animal ou bebidas)', 'Situação legal'),
    ('Ano de implantação da Agroindústria', 'Ano de implantação'),
    ('Área da Agroindústria (Área construída)', 'Área construída'),
    ('Local de processamento ', 'Local de processamento'),
    ('Fonte da água utilizada na Agroindústria', 'Fonte da água'),
    ('Descarte de resíduos sólidos', 'Resíduos sólidos'),
    ('Descarte de resíduos líquidos', 'Resíduos líquidos'),
    ('Categoria das matérias primas:', 'Matéria-prima'),
    ('Sistema de produção ', 'Sistema de produção'),
    ('Qual a porcentagem média anual de PRODUÇÃO PRÓPRIA de matéria prima?', 'Produção própria de MP'),
    ('Mão de obra na agroindústria', 'Mão de obra'),
    ('Mão de obra familiar: Quantas pessoas DA FAMÍLIA colaboram nas atividades da Agroindústria?', 'Pessoas da família'),
    ('Mão de obra CONTRATADA PERMANENTE: quantas pessoas contratadas trabalham na agroindústria?', 'Contratados permanentes'),
    ('Quantas pessoas são contratadas para trabalhos TEMPORÁRIOS na Agroindústria? (média de diárias pagas em 2022)', 'Temporários (2022)'),
    ('Realiza controle de qualidade dos produtos', 'Controle de qualidade'),
    ('Se faz controle de qualidade, como faz?', 'Como controla a qualidade'),
    ('Registros obtidos para os PRODUTOS DE ORIGEM ANIMAL', 'Registro origem animal'),
    ('No caso de BEBIDAS, POLPAS e VINAGRE, possui registro no MAPA?', 'Registro MAPA (bebidas)'),
    ('O estabelecimento possui regularização ambiental ', 'Regularização ambiental'),
    ('Utiliza código de barras', 'Código de barras'),
    ('Multifuncional (Processa mais de um tipo de produto na mesma unidade. Ex: panificados e geleias ou polpas e conservas)', 'Multifuncional'),
    ('Quantidade estimada da PRODUÇÃO MENSAL (Kg/mês, l/mês ou dúzias/mês, se ovos)', 'Produção mensal'),
    ('A condição atual do estabelecimento comportaria o aumento da produção?', 'Comporta aumento'),
    ('Investimento realizado na INSTALAÇÃO da Agroindústria (R$):', 'Investimento na instalação'),
    ('Fonte dos recursos', 'Fonte dos recursos'),
    ('Realiza controle de receitas e custos', 'Controle de receitas/custos'),
    ('Sabe o custo unitário dos produtos', 'Custo unitário'),
    ('Faturamento médio MENSAL em 2022 (R$/mês):', 'Faturamento mensal (2022)'),
    ('Qual a participação da Agroindústria na Renda Bruta Total vinda da propriedade?', 'Participação na renda'),
    ('Emite algum documento fiscal na venda?', 'Emite nota fiscal'),
    ('Tem necessidade de crédito?', 'Precisa de crédito'),
    ('Intenção de investimentos nos próximos 3 anos:', 'Investimento em 3 anos'),
    ('A Agroindústria recebeu assistência técnica (AT) na instalação?', 'ATER na instalação'),
    ('Possui alguma demanda de Assistência Técnica?', 'Demanda de ATER'),
    ('Qual a participação da VENDA DIRETA ao consumidor (porta a porta, feiras, redes sociais) no total comercializado (em %)?', 'Venda direta'),
    ('Qual a participação do MERCADO INSTITUCIONAL (PAA, PNAE ou similares) no total comercializado (em %)?', 'Mercado institucional'),
    ('Qual a participação do COMÉRCIO VAREJISTA do município no total comercializado (em %)?', 'Varejo local'),
    ('Realiza vendas por e-commerce ou redes sociais?', 'E-commerce/redes'),
    ('Outros mercados ', 'Outros mercados'),
    ('Gostaria de ampliar a comercialização para outros municípios?', 'Quer ampliar mercado'),
    ('A condição atual permite a comercialização em outros municípios?', 'Pode vender fora'),
    ('Qual a maior distância que percorre para realizar entregas?', 'Maior distância de entrega'),
    ('Possui produtos premiados em concursos ou similares?', 'Produtos premiados'),
    ('Quais os prêmios recebidos (Descreva apenas os prêmios recebidos a partir de 2020)? Se não há, preencha 0 (zero).', 'Prêmios'),
    ('Observações (Descreva aqui o que achar relevante)', 'Observações'),
    ('Ao seu ver, qual a necessidade desta agroindústria nas seguintes áreas [Regularização da Agroindústria]', 'Necessidade: regularização'),
    ('Ao seu ver, qual a necessidade desta agroindústria nas seguintes áreas [Rotulagem/Informação nutricional]', 'Necessidade: rotulagem'),
    ('Ao seu ver, qual a necessidade desta agroindústria nas seguintes áreas [Boas Práticas de Fabricação]', 'Necessidade: BPF'),
    ('Ao seu ver, qual a necessidade desta agroindústria nas seguintes áreas [Gestão do empreendimento]', 'Necessidade: gestão'),
    ('Ao seu ver, qual a necessidade desta agroindústria nas seguintes áreas [Tecnologia de produção de alimentos]', 'Necessidade: tecnologia'),
    ('Ao seu ver, qual a necessidade desta agroindústria nas seguintes áreas [Promoção e comercialização de produtos]', 'Necessidade: comercialização'),
]
# Rótulos cortados do GeoJSON publicado (LGPD).
DROP = {'CPF', 'Telefone', 'Faturamento mensal (2022)', 'GETEC · Telefone'}
# CPF ou telefone digitado dentro de outro campo ("Fulano / Cpf 060.523.789-13").
CPF_TXT = re.compile(r'[-/:,]*\s*cpf\b[\s:.]*(\d[\d.\s-]{9,13}\d)?|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b', re.I)
FONE_TXT = re.compile(r'\(?\b\d{2}\)?\s?9?\s?\d{4}[-\s]?\d{4}\b')


def sem_pessoal(v):
    return re.sub(r'\s{2,}', ' ', FONE_TXT.sub('', CPF_TXT.sub('', v))).strip(' /,:').rstrip(' -')

VAZIO = {'', 'zero', '0', 'não se aplica', 'sem observação.', 'sem observação', '-'}
UTM = {z: Transformer.from_crs(f'EPSG:{31960 + z}', 'EPSG:4674', always_xy=True) for z in (21, 22)}
NUM = re.compile(r'-?\d+(?:\.\d+)?')


def candidatos(txt, eixo):
    """Leituras possíveis (graus decimais, negativos) de uma coordenada."""
    s = str(txt).strip().replace(',', '.').replace('º', '°')
    try:
        nums = [float(s)]  # número puro, inclusive notação científica
    except ValueError:
        nums = [float(n) for n in NUM.findall(s)]
    if not nums:
        return []
    nums = [abs(n) for n in nums]
    if len(nums) >= 2 and nums[0] < 90:  # graus + minutos (+ segundos)
        g, m = nums[0], nums[1]
        sec = nums[2] if len(nums) > 2 else 0
        return [-(g + m / 60 + sec / 3600)]
    v = nums[0]
    lo, hi = (22, 27) if eixo == 'lat' else (48, 55)
    if lo <= v <= hi:
        return [-v]
    out = []
    if v > 1000 and v.is_integer():
        # decimal sem separador: -262814570 -> -26.2814570
        d = str(int(v))
        out.append(-float(d[:2] + '.' + d[2:]))
    return out + [('utm', v)]


def ler_coord(la, lo, mun_geom, pr):
    """(lon, lat, checagem) ou None."""
    cla, clo = candidatos(la, 'lat'), candidatos(lo, 'lon')
    opcoes = []
    for a in cla:
        for b in clo:
            if isinstance(a, float) and isinstance(b, float):
                opcoes += [(b, a), (a, b)]  # também lat/lon trocados
            elif isinstance(a, tuple) and isinstance(b, tuple):
                n, e = a[1], b[1]
                if n < e:
                    n, e = e, n
                for z in (22, 21):
                    opcoes.append(UTM[z].transform(e, n))
    dentro_pr = None
    for x, y in opcoes:
        p = Point(x, y)
        if mun_geom is not None and mun_geom.buffer(0.02).contains(p):
            return x, y, 'no município declarado'
        if dentro_pr is None and pr.contains(p):
            dentro_pr = (x, y, 'FORA do município declarado')
    return dentro_pr


def texto(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return re.sub(r'\s+', ' ', str(v)).strip()


def main():
    muns = json.loads(MUNICIPIOS.read_text(encoding='utf-8'))['features']
    geom = {f['properties']['CD_MUN']: shape(f['geometry']) for f in muns}
    pr = unary_union(list(geom.values())).buffer(0.01)

    ws = openpyxl.load_workbook(SRC, read_only=True, data_only=True)['Campos']
    rows = list(ws.iter_rows(values_only=True))
    head = [texto(h) for h in rows[0]]
    col = {h: i for i, h in enumerate(head)}
    faltando = [c for c, _ in CAMPOS if texto(c) not in col]
    if faltando:
        sys.exit(f'colunas ausentes na planilha: {faltando}')

    feats, sem = [], []
    for r in rows[1:]:
        if not any(c not in (None, '') for c in r):
            continue
        cod = texto(r[col['CodIBGE']])
        got = ler_coord(r[col['Latitude']], r[col['Longitude']], geom.get(cod), pr)
        if not got:
            sem.append((r[0], texto(r[col['Município']]), r[col['Latitude']], r[col['Longitude']]))
            continue
        lon, lat, chk = got
        props = {'id': r[0]}
        for c, rot in CAMPOS:
            if rot in DROP:
                continue
            v = texto(r[col[texto(c)]])
            if v.lower() not in VAZIO:
                props[rot] = v
        props = {k: sem_pessoal(v) if isinstance(v, str) else v for k, v in props.items()}
        props['Checagem da coordenada'] = chk
        feats.append({'type': 'Feature', 'properties': props,
                      'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]}})

    fora = sum(1 for f in feats if f['properties']['Checagem da coordenada'].startswith('FORA'))
    print(f'diagnóstico: {len(feats)} pontos ({fora} fora do município declarado), '
          f'{len(sem)} sem coordenada utilizável')
    for s in sem:
        print('  sem coord:', s)

    cod_mun = {chave(texto(r[col['Município']])): texto(r[col['CodIBGE']]) for r in rows[1:] if r[0]}
    feats += cruzar_getec(feats, geom, pr, cod_mun)
    OUT.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'total: {len(feats)} pontos, {OUT.stat().st_size / 1024:.0f} KB')


def chave(s):
    """Nome comparável: sem acento, minúsculo, só letras e dígitos."""
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return ' '.join(re.findall(r'[a-z0-9]+', s))


GENERICO = re.compile(r'\b(agroindustria|agroindustrias|queijaria|da|de|do|dos|das|e)\b')


def chave_curta(s):
    return ' '.join(GENERICO.sub(' ', chave(s)).split())


# Coordenada digitada no texto do endereço do GETEC: par decimal
# ("-24.79, -52.72") ou par em graus/minutos/segundos ("23°16'4.91\"S 50°13'46.84\"O").
DEC_PAR = re.compile(r'(-?2[2-7][.,]\d{3,})\s*[,;/ ]\s*(-?(?:4[89]|5[0-4])[.,]\d{3,})')
DMS = re.compile(r'(2[2-7]|4[89]|5[0-4])\s*[°º]\s*\d{1,2}\s*[\'’´]\s*[\d.,]*')


def coord_do_texto(s):
    m = DEC_PAR.search(s)
    if m:
        return m.group(1), m.group(2)
    dms = [x.group(0) for x in DMS.finditer(s)]
    lat = next((x for x in dms if x[:2] in {'22', '23', '24', '25', '26', '27'}), None)
    lon = next((x for x in dms if x[:2] in {'48', '49', '50', '51', '52', '53', '54'}), None)
    return (lat, lon) if lat and lon else None


def cruzar_getec(feats, geom, pr, cod_mun):
    """Casa o cadastro GETEC com os pontos do diagnóstico por nome no município.

    Casamento (em ordem): nome da agroindústria, nome do responsável, nome sem
    as palavras genéricas. Cada ponto casa com uma linha só. Linhas do GETEC
    sem par entram como ponto próprio quando o endereço traz coordenada.
    Devolve os pontos novos; os casados ganham os campos GETEC no lugar.
    """
    getec = json.loads(GETEC.read_text(encoding='utf-8'))['linhas']
    idx = {}
    for f in feats:
        p = f['properties']
        mun = chave(p.get('Município'))
        for k in (chave(p.get('Agroindústria')), chave(p.get('Produtor responsável')),
                  chave_curta(p.get('Agroindústria'))):
            if k:
                idx.setdefault((mun, k), f)
    usados, novos, casados = set(), [], 0
    for mun_nome, org, tipo, integ, resp, end, fone, ativo in getec:
        campos = {'GETEC · Nome': org, 'GETEC · Tipo': tipo, 'GETEC · Integrantes': integ,
                  'GETEC · Responsável': resp, 'GETEC · Endereço': re.sub(r'\s*CEP\s*$', '', end),
                  'GETEC · Telefone': fone, 'GETEC · Situação': ativo}
        campos = {k: sem_pessoal(v) for k, v in campos.items() if k not in DROP and v}
        campos = {k: v for k, v in campos.items() if v and v.lower() not in VAZIO}
        mun = chave(mun_nome)
        alvo = next((idx[(mun, k)] for k in (chave(org), chave(resp), chave_curta(org))
                     if k and (mun, k) in idx and id(idx[(mun, k)]) not in usados), None)
        if alvo:
            usados.add(id(alvo))
            alvo['properties'].update(campos)
            alvo['properties']['Fonte do ponto'] = 'Diagnóstico 2023 + GETEC'
            casados += 1
            continue
        par = coord_do_texto(end)
        got = par and ler_coord(par[0], par[1], geom.get(cod_mun.get(mun)), pr)
        if not got:
            continue
        lon, lat, chk = got
        props = {'Agroindústria': org, 'Município': mun_nome, **campos,
                 'Checagem da coordenada': chk, 'Fonte do ponto': 'GETEC (coordenada do endereço)'}
        novos.append({'type': 'Feature', 'properties': props,
                      'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]}})
    for f in feats:
        f['properties'].setdefault('Fonte do ponto', 'Diagnóstico 2023')
    print(f'GETEC: {len(getec)} linhas, {casados} casadas com o diagnóstico, '
          f'{len(novos)} novas pela coordenada do endereço, '
          f'{len(getec) - casados - len(novos)} sem ponto')
    return novos


if __name__ == '__main__':
    main()
