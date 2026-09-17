#!/usr/bin/env python3
"""Baixa os imoveis ATIVOS do CAR no PR, um GeoJSON por municipio.

Fonte: WFS publico do SICAR (geoserver.car.gov.br), camada
`sicar:sicar_imoveis_pr`. Sao ~533 mil imoveis ativos (de ~557 mil no total);
os demais estao pendentes, suspensos ou cancelados e NAO entram.

Baixa por municipio (CQL_FILTER em cod_municipio_ibge) em vez de paginar o
estado inteiro: cada arquivo e um ponto de retomada natural, e uma queda no
meio nao invalida o que ja veio. Reexecutar pula o que ja esta em disco
(--force refaz).

TRANSPORTE: `curl`, nao urllib. O geoserver.car.gov.br negocia uma suite que o
nivel de seguranca padrao do OpenSSL recusa (SSLV3_ALERT_HANDSHAKE_FAILURE), e
baixar o SECLEVEL do contexto do Python fazia o handshake passar mas travava a
conexao em silencio depois de algumas dezenas de requisicoes — sem estourar o
timeout de socket, porque o servidor derruba sem FIN. O curl fala com este
servidor sem ajuste nenhum e traz os proprios limites de tempo e retentativa,
entao e ele quem carrega o dado. Verificacao de certificado segue LIGADA.

O acervo bruto passa de 1 GB e NAO e versionado: fica no diretorio de saida
(--out, por padrao ./car-pr), de onde build_car.py le.

Uso:
  py -3 scripts/fetch_car.py --out /caminho/car-pr
"""

import argparse
import json
import shutil
import subprocess
import time
import urllib.parse
from pathlib import Path

WFS = 'https://geoserver.car.gov.br/geoserver/sicar/wfs'
TYPENAME = 'sicar:sicar_imoveis_pr'
STATUS_ATIVO = 'AT'
UA = 'datageo-command/1.0 (build script; github.com/DGP-comando)'
INFO = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'municipios-info.json'


def municipios() -> list[str]:
    info = json.loads(INFO.read_text(encoding='utf-8'))
    return sorted(info['municipios'])


def url_municipio(ibge: str) -> str:
    params = {
        'service': 'WFS',
        'version': '2.0.0',
        'request': 'GetFeature',
        'typeName': TYPENAME,
        'outputFormat': 'application/json',
        'srsName': 'EPSG:4674',
        'CQL_FILTER': f"status_imovel='{STATUS_ATIVO}' AND cod_municipio_ibge={int(ibge)}",
    }
    return f'{WFS}?{urllib.parse.urlencode(params)}'


def baixar(ibge: str, destino: Path, tentativas: int = 4) -> int:
    """Grava o GeoJSON do municipio e devolve quantas feicoes vieram."""
    parcial = destino.with_suffix('.parcial')
    for tentativa in range(tentativas):
        erro = None
        try:
            # --max-time corta a requisicao inteira; --speed-time/--speed-limit
            # derrubam a conexao que ficou viva mas parou de entregar bytes,
            # que e exatamente como este servidor falha.
            subprocess.run(
                ['curl', '-sS', '--fail', '--location',
                 '--max-time', '300', '--connect-timeout', '30',
                 '--speed-time', '60', '--speed-limit', '1024',
                 '--user-agent', UA, '-o', str(parcial), url_municipio(ibge)],
                check=True, capture_output=True, text=True,
            )
            # Valida ANTES de publicar: o GeoServer responde erro com HTTP 200 e
            # um XML de ows:ExceptionReport, que viraria um arquivo "pronto"
            # e silenciosamente vazio na proxima execucao.
            dados = json.loads(parcial.read_text(encoding='utf-8'))
            feicoes = dados.get('features')
            if feicoes is None:
                raise ValueError(f'resposta sem `features`: {parcial.read_bytes()[:200]!r}')
            parcial.replace(destino)
            return len(feicoes)
        except subprocess.CalledProcessError as e:
            erro = (e.stderr or '').strip() or f'curl saiu com {e.returncode}'
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as e:
            erro = str(e)
        parcial.unlink(missing_ok=True)
        if tentativa == tentativas - 1:
            raise RuntimeError(f'{ibge}: {erro}')
        espera = 10 * (tentativa + 1)
        print(f'  {ibge} tentativa {tentativa + 1} falhou ({erro}); {espera}s', flush=True)
        time.sleep(espera)
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', default='car-pr', help='diretorio dos GeoJSON por municipio')
    ap.add_argument('--force', action='store_true', help='rebaixar o que ja esta em disco')
    args = ap.parse_args()

    if not shutil.which('curl'):
        raise SystemExit('curl nao encontrado no PATH — este script depende dele (ver cabecalho)')

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    codigos = municipios()
    total = 0
    t0 = time.time()
    for n, ibge in enumerate(codigos, 1):
        destino = out / f'{ibge}.geojson'
        if destino.exists() and not args.force:
            continue
        feicoes = baixar(ibge, destino)
        total += feicoes
        print(f'[{n}/{len(codigos)}] {ibge}: {feicoes} imoveis '
              f'({destino.stat().st_size / 1e6:.1f} MB, {(time.time() - t0) / 60:.1f} min)',
              flush=True)

    prontos = sorted(out.glob('*.geojson'))
    print(f'\n{len(prontos)}/{len(codigos)} municipios em disco, '
          f'{sum(p.stat().st_size for p in prontos) / 1e9:.2f} GB, '
          f'{total} imoveis baixados nesta execucao')


if __name__ == '__main__':
    main()
