"""Importa os usuarios ativos do SISATER para o Supabase Auth do DataGeo (c2-parana).

Login = matricula (codext). Senha inicial = matricula invertida, que e exatamente
a coluna senha_temporaria do export. No primeiro acesso o front obriga a troca
(user_metadata.must_change_password).

LGPD: so matricula e nome saem do CSV; CPF, e-mail, celular e documento ficam.

Uso (service key so local, nunca no bundle):
  SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/import_usuarios_sisater.py usuarios_sisater.csv            # dry-run
  SUPABASE_SERVICE_ROLE_KEY=... py -3 scripts/import_usuarios_sisater.py usuarios_sisater.csv --aplicar
Idempotente: matricula ja cadastrada e pulada (senha dela nao e resetada).
"""
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request

SUPABASE_URL = os.environ.get('DATAGEO_SUPABASE_URL', 'https://fialxjcsgywvvuxjxcly.supabase.co')
# Mesmos valores de src/data/datageoAuth.js: o front aplica a mesma transformacao.
EMAIL_DOMINIO = 'sisater.local'
SENHA_PREFIXO = 'dgp:'  # Supabase exige >= 6 caracteres; ha matriculas de 3-4 digitos.
MATRICULA_MIN = 3        # codext 0 e 1 sao registros de sistema


def email_de(matricula):
    return f'{matricula}@{EMAIL_DOMINIO}'


def senha_auth(senha_digitada):
    return SENHA_PREFIXO + senha_digitada


def usuarios_ativos(caminho):
    with open(caminho, encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f, delimiter=';'):
            mat = r['codext'].strip()
            if r['ativo'] != 'True' or not mat.isdigit() or len(mat) < MATRICULA_MIN:
                continue
            if r['senha_temporaria'] != mat[::-1]:
                raise ValueError(f'senha_temporaria fora do padrao na matricula {mat}')
            yield {'matricula': mat, 'nome': r['nomext'].strip()}


def criar(u, key):
    body = {
        'email': email_de(u['matricula']),
        'password': senha_auth(u['matricula'][::-1]),
        'email_confirm': True,
        'app_metadata': {'datageo': True, 'origem': 'sisater'},
        'user_metadata': {'matricula': u['matricula'], 'nome': u['nome'], 'must_change_password': True},
    }
    req = urllib.request.Request(
        f'{SUPABASE_URL}/auth/v1/admin/users',
        data=json.dumps(body).encode('utf-8'),
        method='POST',
        headers={'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
    )
    for tentativa in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30):
                return 'criado'
        except urllib.error.HTTPError as e:
            detalhe = e.read().decode('utf-8', 'replace')
            if e.code == 422 and 'already' in detalhe:
                return 'existente'
            if e.code != 429 and e.code < 500:
                return f'erro {e.code}: {detalhe[:200]}'
            ultimo = f'erro {e.code}: {detalhe[:200]}'
        except urllib.error.URLError as e:  # conexao derrubada pelo servidor (rate limit)
            ultimo = f'erro rede: {e.reason}'
        time.sleep(2 ** tentativa)
    return ultimo


def _checa():
    assert senha_auth('4321') == 'dgp:4321' and len(senha_auth('321')) >= 6
    assert email_de('0133') == '0133@sisater.local'


def main():
    _checa()
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    usuarios = list(usuarios_ativos(sys.argv[1]))
    print(f'{len(usuarios)} usuarios ativos no CSV')
    if '--aplicar' not in sys.argv:
        print('dry-run: nada gravado (use --aplicar)')
        return
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        sys.exit('SUPABASE_SERVICE_ROLE_KEY ausente')
    totais = {}
    for i, u in enumerate(usuarios, 1):
        res = criar(u, key)
        chave = res if not res.startswith('erro') else 'erro'
        totais[chave] = totais.get(chave, 0) + 1
        if chave == 'erro':
            print(f'  matricula {u["matricula"]}: {res}', file=sys.stderr)
        if i % 100 == 0:
            print(f'  {i}/{len(usuarios)} {totais}')
    print('fim', totais)
    if totais.get('erro'):
        sys.exit(1)


if __name__ == '__main__':
    main()
