"""Sobe data/privado/* para o bucket privado datageo-privado (Supabase Storage).

O front le esses arquivos por /privado/<nome> (dgFetchData), so com usuario
liberado. Subpastas viram prefixo no bucket (data/privado/caf/x.json ->
caf/x.json). Rodar depois de regerar qualquer um deles; com argumentos, so os
caminhos (relativos a data/privado) que comecam por eles:
  SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/upload_privado.py [caf-municipios.json caf/ ...]
"""
import mimetypes
import os
import sys
import urllib.request
from pathlib import Path

SUPABASE_URL = os.environ.get('DATAGEO_SUPABASE_URL', 'https://fialxjcsgywvvuxjxcly.supabase.co')
PASTA = Path(__file__).resolve().parents[1] / 'data' / 'privado'
BUCKET = 'datageo-privado'
# Gravados pelas Edge Functions do c2 (de hora em hora): uma cópia local
# (ex.: gerada para QA) nunca sobrescreve o arquivo vivo.
DO_SERVIDOR = {'servidores-idr.json'}


def main():
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or sys.exit('SUPABASE_SERVICE_ROLE_KEY ausente')
    filtro = sys.argv[1:]
    arquivos = sorted(
        p for p in PASTA.rglob('*')
        if p.is_file() and p.name not in DO_SERVIDOR
        and (not filtro or any(p.relative_to(PASTA).as_posix().startswith(f) for f in filtro))
    )
    if not arquivos:
        sys.exit(f'nada em {PASTA}')
    for p in arquivos:
        # .json.gz sobe como gzip (guess_type diria application/json): o front descomprime.
        tipo = {'.geojson': 'application/geo+json', '.gz': 'application/gzip'}.get(p.suffix) or mimetypes.guess_type(p.name)[0]
        req = urllib.request.Request(
            f'{SUPABASE_URL}/storage/v1/object/{BUCKET}/{p.relative_to(PASTA).as_posix()}',
            data=p.read_bytes(),
            method='POST',
            headers={
                'apikey': key,
                'Authorization': f'Bearer {key}',
                'Content-Type': tipo or 'application/octet-stream',
                'x-upsert': 'true',
                'Cache-Control': 'max-age=300',
            },
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            print(f'{p.relative_to(PASTA).as_posix()}: {p.stat().st_size // 1024} KB -> HTTP {r.status}')


if __name__ == '__main__':
    main()
