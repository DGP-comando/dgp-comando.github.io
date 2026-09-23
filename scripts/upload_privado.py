"""Sobe data/privado/* para o bucket privado datageo-privado (Supabase Storage).

O front le esses arquivos por /privado/<nome> (dgFetchData), so com usuario
liberado. Rodar depois de regerar qualquer um deles:
  SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/upload_privado.py
"""
import mimetypes
import os
import sys
import urllib.request
from pathlib import Path

SUPABASE_URL = os.environ.get('DATAGEO_SUPABASE_URL', 'https://fialxjcsgywvvuxjxcly.supabase.co')
PASTA = Path(__file__).resolve().parents[1] / 'data' / 'privado'
BUCKET = 'datageo-privado'


def main():
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or sys.exit('SUPABASE_SERVICE_ROLE_KEY ausente')
    arquivos = sorted(p for p in PASTA.iterdir() if p.is_file())
    if not arquivos:
        sys.exit(f'nada em {PASTA}')
    for p in arquivos:
        tipo = 'application/geo+json' if p.suffix == '.geojson' else mimetypes.guess_type(p.name)[0]
        req = urllib.request.Request(
            f'{SUPABASE_URL}/storage/v1/object/{BUCKET}/{p.name}',
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
            print(f'{p.name}: {p.stat().st_size // 1024} KB -> HTTP {r.status}')


if __name__ == '__main__':
    main()
