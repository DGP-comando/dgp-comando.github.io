"""Equipamentos da assistência social e da segurança alimentar no PR (MDS).

Fonte: API pública do Mapa Social / MOPS do MDS (SAGI), a mesma que alimenta
https://mapa-social.mds.gov.br. Sem autenticação.

    aplicacoes.mds.gov.br/sagi/servicos/equipamentos?fq=uf:PR&wt=json

Saída: public/data/equipamentos-suas-pr.geojson (EPSG:4326, como a API).

Só equipamentos públicos, com endereço público. E-mail e telefone da API
ficam fora (minimização, LGPD): o tooltip mostra onde fica, não quem atende.
Pontos sem coordenada ou fora do retângulo do PR são descartados e contados.

    py -3 scripts/build_equipamentos_suas.py
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://aplicacoes.mds.gov.br/sagi/servicos/equipamentos'
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'equipamentos-suas-pr.geojson'

# tipo_equipamento da API -> grupo da legenda (src/data/equipamentosSuasEstilos.js)
TIPOS = {
    'CRAS': 'cras',
    'CREAS': 'creas',
    'CENTRO POP': 'pop',
    'POSTO_CADASTRAMENTO': 'cadunico',
    'RESTAURANTE_POPULAR_NOVO': 'restaurante',
    'COZINHA_COMUNITARIA_NOVO': 'cozinha',
    'BANCO_ALIMENTOS_NOVO': 'banco',
}
# Retângulo do PR com folga (lon, lat).
BBOX = (-54.7, -26.8, -47.9, -22.4)


def fetch(tipo):
    q = urllib.parse.urlencode({
        'q': '*:*', 'fq': ['uf:PR', f'tipo_equipamento:"{tipo}"'], 'rows': 5000, 'wt': 'json',
    }, doseq=True)
    req = urllib.request.Request(f'{API}?{q}', headers={'User-Agent': 'datageo-command/1.0 (build script)'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)['response']['docs']


def coords(d):
    """(lon, lat) de `georef_location` ("lat,lon") ou de p_latitude/p_longitude."""
    try:
        if d.get('georef_location'):
            lat, lon = (float(v) for v in d['georef_location'].split(','))
        else:
            lat, lon = float(d['p_latitude']), float(d['p_longitude'])
    except (KeyError, TypeError, ValueError):
        return None
    if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
        return None
    return round(lon, 6), round(lat, 6)


def limpa(v):
    s = ' '.join(str(v or '').split())
    return '' if s.upper() in ('0', 'NONE', '-', 'SI', 'NSA') else s


def caixa(s):
    """Só mexe na caixa do que vem todo em maiúsculas ("PADRE DAMASO" -> "Padre Damaso")."""
    if not s.isupper():
        return s
    t = s.title()
    for w in ('Do', 'Da', 'De', 'Dos', 'Das', 'E'):
        t = t.replace(f' {w} ', f' {w.lower()} ')
    return t


def endereco(d):
    rua, num = limpa(d.get('endereco')), limpa(d.get('numero'))
    # A API às vezes já traz "Rua X - 47" ou "Rua X - 0" no campo endereco.
    rua = rua.removesuffix(' - 0').strip()
    if num and not rua.endswith(num):
        rua = f'{rua}, {num}'
    return rua


def feature(d, grupo):
    xy = coords(d)
    if not xy:
        return None
    props = {
        'grupo': grupo,
        'nome': limpa(d.get('nome')),
        'municipio': caixa(limpa(d.get('cidade'))),
        # SUAS vem com 6 dígitos, SAN com 7: fica o de 6 (sem verificador).
        'ibge6': limpa(d.get('ibge'))[:6],
        'endereco': caixa(endereco(d)),
        'bairro': caixa(limpa(d.get('bairro'))),
        'situacao': limpa(d.get('situacao')),
    }
    return {
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': list(xy)},
        'properties': {k: v for k, v in props.items() if v},
    }


def main():
    feats, atualizado = [], ''
    for tipo, grupo in TIPOS.items():
        docs = fetch(tipo)
        ok = [f for f in (feature(d, grupo) for d in docs) if f]
        atualizado = max([atualizado, *(d.get('data_atualizacao', '')[:10] for d in docs)])
        print(f'{tipo:26} {len(docs):4} na API, {len(ok):4} com coordenada no PR')
        feats.extend(ok)
    if len(feats) < 500:  # CRAS sozinhos passam de 500: menos que isso é API quebrada
        sys.exit(f'só {len(feats)} pontos: API mudou? arquivo não sobrescrito')
    gj = {'type': 'FeatureCollection', 'fonte': f'MDS · Mapa Social (SAGI), consulta {atualizado}', 'features': feats}
    OUT.write_text(json.dumps(gj, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(feats)} pontos -> {OUT.name}')


if __name__ == '__main__':
    main()
