# Otimização dos GeoJSON estáticos (`public/data/`)

`scripts/optimize_geojson.py` reduz o peso dos arquivos que o browser baixa sem
mudar o contrato que os loaders esperam (FeatureCollection, mesmas feições, mesmas
propriedades, mesmos tipos de geometria).

## O que faz

- **Linhas e polígonos**: `shapely simplify(tolerância, preserve_topology=True)`, em
  graus (dados em lon/lat, EPSG:4674/4326).
- **Quantização** de todas as coordenadas a 5 casas (~1,1 m); Z descartado quando é
  sempre 0; vértices consecutivos repetidos removidos.
- **Propriedades de ruído OSM** (`@id`, `timestamp`, `version`, `changeset`, `user`,
  `uid`) removidas só se não aparecerem em `src/`. Hoje nenhum arquivo as tem.
- **JSON minificado**, UTF-8 sem `\u` escapes (acentos preservados).
- **Salvaguardas**: se uma feição simplificada ficar inválida (polígono) ou degenerada
  (anel com menos de 4 vértices, linha com menos de 2), usa a original só quantizada;
  se ainda quebrar, mantém a original. A contagem de feições nunca muda (o script
  aborta se mudar).
- **Idempotente**: arquivos simplificados ganham o membro `"otimizacao"` no topo
  (`{"tolerancia":…,"casas":5}`); rodar de novo não simplifica outra vez.

| Arquivo | Tolerância (graus) |
|---|---|
| rodovias-estaduais/federais, ferrovias, linhas-transmissao | 0.00005 (~5 m) |
| conectividade-sem-cobertura | 0.0001 |
| terras-indigenas, quilombolas | 0.00002 |
| municipios-pr | 0 (não simplifica: simplificar polígono a polígono desalinha divisas compartilhadas) |
| pontos (armazéns, usinas, agroindústrias, subestações, ceasas) | 0 (só quantiza/minifica) |
| conectividade-torres.json, municipios-info.json | só minifica |

## Como rodar

Sempre **depois** de regenerar dados com qualquer `scripts/build_*.py` (os builds
sobrescrevem o arquivo e removem o marcador `otimizacao`):

```powershell
py -3 scripts/build_rodovias.py            # (ou o build que foi regenerado)
py -3 scripts/optimize_geojson.py --dry-run
py -3 scripts/optimize_geojson.py --backup-dir "$env:TEMP\geojson-orig"
py -3 scripts/optimize_geojson.py rodovias-federais-pr.geojson   # só um arquivo
```

Para incluir um arquivo novo, adicione-o a `TARGETS` no script com a tolerância.

## Resultado da primeira execução (2026-09-13)

| Arquivo | Antes | Depois | Redução | Feições | Vértices |
|---|---|---|---|---|---|
| rodovias-estaduais-pr | 4.00 MB | 2.61 MB | 35% | 9975 = 9975 | 134344 → 67578 |
| rodovias-federais-pr | 2.05 MB | 1.37 MB | 33% | 6414 = 6414 | 61733 → 29084 |
| ferrovias-pr | 1.15 MB | 663 KB | 44% | 1819 = 1819 | 43487 → 19399 |
| linhas-transmissao-pr | 731 KB | 346 KB | 53% | 297 = 297 | 32042 → 13859 |
| conectividade-sem-cobertura | 2.55 MB | 1.50 MB | 41% | 1125 = 1125 | 58806 → 58673 |
| terras-indigenas-pr | 456 KB | 323 KB | 29% | 57 = 57 | 14815 → 14815 |
| quilombolas-pr | 75 KB | 37 KB | 50% | 10 = 10 | 1682 → 1682 |
| demais (municípios, pontos, JSONs) | 1.37 MB | 1.37 MB | 0% | iguais | iguais |
| **Total** | **12.33 MB** | **8.16 MB** | **34%** | | |

(MB = MiB.) Verificação: propriedades e membros de topo idênticos, tipos de geometria
idênticos por feição, acentos intactos (ex.: "Rodovia do Café Governador Ney Braga",
"São Miguel do Iguaçu"), polígonos inválidos 22 → 19 em sem-cobertura e 0 nos demais,
desvio máximo (Hausdorff, graus) ≤ tolerância; em metros (SIRGAS 2000 / UTM 22S) ≤ 5,5 m
em rodovias/ferrovias e ≤ 7 m em sem-cobertura. Duas LTs fora do PR (SP, trechos de
dezenas de km) medem 12 a 15 m em UTM 22S por distorção de projeção em segmentos longos,
não pela simplificação (desvio em graus 4,3e-5).
