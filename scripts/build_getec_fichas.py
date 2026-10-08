#!/usr/bin/env python3
"""Fichas do GETEC a partir de data/privado/getec-grupos.json (sem nova consulta).

Monta duas visões, já que o GETEC não tem um prontuário pronto (ver nota abaixo):

1) data/privado/getec-ficha-produtor.json  (bucket privado: nomes de produtores)
   Prontuário do produtor, chaveado pela CAF (só quem tem CAF tem ponto/ficha):
   {geradoEm, ano, fonte, nota,
    produtores: {<caf>: {nome, ibge, municipio, categoria, ativo, caf, lon, lat,
        programas:[projeto...], tecnicos:[{id,nome}], grupos:[{nome,projeto,tecnicoId,tecnicoNome}],
        nVinculos, atendimentosDatados}}}

2) data/privado/getec-ficha-tecnico.json
   Ficha do extensionista: grupos + TODOS os produtores atendidos (com e sem CAF;
   os com CAF têm ponto), e um resumo.
   {geradoEm, ano, fonte,
    tecnicos: {<id>: {nome, grupos:[{nome,projeto,nClientes}],
        produtores:[{nome,ibge,municipio,categoria,ativo,caf,lon,lat,grupo,projeto}],
        resumo:{nGrupos,nProdutores,comCaf,semCaf,comPonto,nMunicipios,programas:[...]}}}}

NOTA sobre atendimentos datados: o GETEC web não expõe o evento de atendimento
individual (data/tema/último atendimento) em massa — o único acesso é o popup
lista_ateMetIndividual, travado no ano da sessão. O nº de atendimentos histórico e
os "últimos 3 atendimentos" detalhados saem da view do banco do SISATER
(10.15.62.197), quando a rede liberar. Aqui, 'programas' e 'tecnicos' vêm dos
vínculos de grupo do ano; 'nVinculos' é o nº de grupos em que o produtor está.

Uso: py -3 scripts/build_getec_fichas.py   (depois: upload_privado.py getec-ficha)
"""

import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIV = ROOT / "data" / "privado"
ENTRADA = PRIV / "getec-grupos.json"
SAIDA_PROD = PRIV / "getec-ficha-produtor.json"
SAIDA_TEC = PRIV / "getec-ficha-tecnico.json"

NOTA_PROD = (
    "programas e tecnicos vem dos vinculos de grupo do GETEC no ano; nVinculos = "
    "nº de grupos. atendimentos datados (nº historico e ultimos atendimentos) nao "
    "sao expostos pelo GETEC web; virao da view do banco do SISATER."
)


def chave_prod(cli: dict) -> str | None:
    """Produtor é identificado pela CAF (só CAF tem ponto). Sem CAF -> None."""
    caf = cli.get("caf")
    return str(caf) if caf else None


def ficha_produtor(dados: dict) -> dict:
    prod: dict[str, dict] = {}
    for tid, ext in dados["extensionistas"].items():
        tnome = ext["nome"]
        for g in ext["grupos"]:
            projeto = g.get("projeto")
            for c in g["clientes"]:
                caf = chave_prod(c)
                if not caf:
                    continue  # sem CAF: entra só na ficha do técnico
                p = prod.get(caf)
                if p is None:
                    p = prod[caf] = {
                        "nome": c["nome"], "ibge": c.get("ibge"),
                        "municipio": c.get("municipio"), "categoria": c.get("categoria"),
                        "ativo": c.get("ativo"), "caf": caf,
                        "lon": c.get("lon"), "lat": c.get("lat"),
                        "programas": [], "tecnicos": [], "grupos": [],
                        "nVinculos": 0, "atendimentosDatados": None,
                    }
                p["nVinculos"] += 1
                p["grupos"].append({
                    "nome": g.get("nome"), "projeto": projeto,
                    "tecnicoId": tid, "tecnicoNome": tnome,
                })
                if projeto and projeto not in p["programas"]:
                    p["programas"].append(projeto)
                if not any(t["id"] == tid for t in p["tecnicos"]):
                    p["tecnicos"].append({"id": tid, "nome": tnome})
    return prod


def ficha_tecnico(dados: dict) -> dict:
    tecnicos: dict[str, dict] = {}
    for tid, ext in dados["extensionistas"].items():
        grupos_out, produtores, programas, municipios = [], [], [], set()
        com_caf = com_ponto = 0
        for g in ext["grupos"]:
            projeto = g.get("projeto")
            grupos_out.append({
                "nome": g.get("nome"), "projeto": projeto, "nClientes": len(g["clientes"]),
            })
            if projeto and projeto not in programas:
                programas.append(projeto)
            for c in g["clientes"]:
                if c.get("ibge"):
                    municipios.add(c["ibge"])
                if c.get("caf"):
                    com_caf += 1
                if c.get("lon") is not None:
                    com_ponto += 1
                produtores.append({
                    "nome": c["nome"], "ibge": c.get("ibge"), "municipio": c.get("municipio"),
                    "categoria": c.get("categoria"), "ativo": c.get("ativo"),
                    "caf": c.get("caf"), "lon": c.get("lon"), "lat": c.get("lat"),
                    "grupo": g.get("nome"), "projeto": projeto,
                })
        tecnicos[tid] = {
            "nome": ext["nome"],
            "grupos": grupos_out,
            "produtores": produtores,
            "resumo": {
                "nGrupos": len(grupos_out),
                "nProdutores": len(produtores),
                "comCaf": com_caf,
                "semCaf": len(produtores) - com_caf,
                "comPonto": com_ponto,
                "nMunicipios": len(municipios),
                "programas": programas,
            },
        }
    return tecnicos


def main() -> None:
    dados = json.loads(ENTRADA.read_text(encoding="utf-8"))
    ano, fonte = dados.get("ano"), dados.get("fonte")
    prod = ficha_produtor(dados)
    tec = ficha_tecnico(dados)
    hoje = date.today().isoformat()
    SAIDA_PROD.write_text(json.dumps({
        "geradoEm": hoje, "ano": ano, "fonte": fonte, "nota": NOTA_PROD,
        "produtores": prod,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    SAIDA_TEC.write_text(json.dumps({
        "geradoEm": hoje, "ano": ano, "fonte": fonte,
        "tecnicos": tec,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    n_prod_ponto = sum(1 for p in prod.values() if p["lon"] is not None)
    tot_prod_tec = sum(t["resumo"]["nProdutores"] for t in tec.values())
    tot_caf_tec = sum(t["resumo"]["comCaf"] for t in tec.values())
    print(f"produtores (CAF) com ficha: {len(prod)} ({n_prod_ponto} com ponto) "
          f"-> {SAIDA_PROD.relative_to(ROOT)}")
    print(f"tecnicos: {len(tec)} | vinculos de produtor: {tot_prod_tec} "
          f"({tot_caf_tec} com CAF, {tot_prod_tec - tot_caf_tec} sem) "
          f"-> {SAIDA_TEC.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
