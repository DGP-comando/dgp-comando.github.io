# Clima histórico BR-DWGD: contrato de dados

Três JSONs estáticos em `public/data/`, gerados por
`scripts/build_clima_brdwgd.py` no Google Earth Engine. Qualquer repo do
ecossistema Datageo Paraná pode consumi-los pela URL publicada da Sala de
Situação ou copiando o arquivo (chave comum: **código IBGE de 7 dígitos**,
string).

Fonte: BR-DWGD, Xavier, Scanlon, King & Alves (2022), *Int. J. Climatol.*
42(16):8390–8404, doi:10.1002/joc.7731. **CC BY 4.0: citar em qualquer tela
que mostre o dado.** Espelho GEE: `projects/sat-io/open-datasets/BR-DWGD`
(awesome-gee-community-catalog).

## Metadados comuns (topo dos três arquivos)

| Campo | Exemplo | Nota |
|---|---|---|
| `fonte`, `citacao`, `doi`, `licenca`, `asset`, `catalogo` | | atribuição |
| `normal` | `[1990, 2019]` | 30 anos completos em todas as variáveis |
| `serieChuva` | `[1961, 2022]` | |
| `serieTemperatura` | `[1961, 2019]` | Tmax/Tmin/ETo terminam em 2020-07-31 |
| `limiares` | `{geada3: 3, geada0: 0, calor35: 35, chuva50: 50}` | °C ou mm/dia |
| `gerado` | `2026-09-13` | ISO 8601 |

## `clima-historico-pr.json` (resumo por município)

`municipios[ibge]`:

| Campo | Unidade | Definição |
|---|---|---|
| `normal.pr[12]`, `normal.eto[12]` | mm/mês | média mensal na normal |
| `normal.tmax[12]`, `normal.tmin[12]` | °C | média mensal na normal |
| `pr`, `eto` | mm/ano | média anual na normal |
| `tmed` | °C | (Tmax + Tmin)/2, média anual na normal |
| `balanco` | mm/ano | `pr − eto` |
| `mesesDeficit` | meses | meses da normal com chuva < ETo |
| `geada3`, `geada0` | dias/ano | dias com Tmin ≤ 3 °C / ≤ 0 °C |
| `calor35` | dias/ano | dias com Tmax ≥ 35 °C |
| `chuva50` | dias/ano | dias com chuva ≥ 50 mm |
| `tendTmed` | °C/década | OLS sobre a série anual 1961–2019 |
| `tendPrPct` | %/década | OLS da chuva anual 1961–2022, relativo à média |
| `tendTmedSig`, `tendPrSig` | bool | \|t\| da inclinação ≥ 2 (~95%) |

Valor municipal = média das células de 0,1° (~11 km) que cobrem o polígono
(reduceRegions a 2 km, então município menor que a célula recebe a célula que
o contém). É grade interpolada de estações: serve para comparar municípios e
para contexto agroclimático, não substitui estação local.

## `clima-historico-series-pr.json` (séries anuais)

`anos = {pr: [1961, 2022], tmed: [1961, 2019], geada3: [1961, 2019]}` e
`municipios[ibge] = {pr: [...], tmed: [...], geada3: [...]}`, um valor por ano
na ordem de `anos`. `null` = sem dado.

## `clima-historico-grade-pr.json` (campo estadual)

| Campo | Nota |
|---|---|
| `bounds {west, south, east, north}` | **centros** das células extremas, graus |
| `width`, `height`, `passoGraus` | 0,1° |
| `campos[indicador]` | array `width × height`, **linha 0 = sul**, oeste → leste; `null` fora do PR |
| `classes[indicador]` | quebras por quantil (legenda) |

Indicadores na grade: `pr, tmed, eto, balanco, mesesDeficit, geada3, geada0,
calor35, chuva50, tendTmed`.

## Onde já é usado

- `datageo-command`: camada `datageo-clima-historico` (token `E`) e seção
  "Clima histórico · BR-DWGD" da ficha municipal.
- `datageoparana.github.io`: referência 18 em `referencias.html`.

Ideias de uso nos dashboards: VBP × anomalia de chuva da safra (vbp-parana),
preço da terra × balanço hídrico (precos-de-terras), risco de geada por
município no crédito rural (credito-rural-parana).
