# Perspectiva El Niño: método e contrato de dados

Camada `datageo-el-nino` (token `Eb`, categoria Clima): chuva e temperatura dos
próximos 6 meses em cada célula de 0,1° (~11 km) do Paraná, junto com o que o
El Niño costuma fazer em cada lugar. Dois JSONs estáticos em `public/data/`,
na MESMA grade (`bounds` = centros das células extremas, linha 0 = sul,
`k = j * width + i`). Só as células do PR são gravadas: `celulas[n] = k`, e
todo campo é `campos[nome][mês][n]`.

## Por que este desenho

- **Previsão dinâmica calibrada no observado.** O ECMWF SEAS5 (51 membros) diz
  quanto o mês se afasta da climatologia do próprio modelo; essa razão vezes a
  normal observada (CHIRPS 1991–2020) dá milímetros locais sem herdar o viés de
  volume do modelo. O NMME (outro conjunto de modelos) e o histórico do ENSO
  servem de segunda e terceira opinião, e o índice de **confiança 0–3** conta
  quantas concordam no sentido.
- **Histórico condicionado ao ENSO.** 45 anos-safra (1981–82 a 2025–26) de
  CHIRPS (chuva) e ERA5-Land (temperatura), correlação e regressão no ONI de
  OND e composição dos El Niños com ONI ≥ 1,0. Com ≥ 1,5 sobram 4 eventos
  (1982, 1997, 2015, 2023), pouco para quartis; a intensidade de um evento muito
  forte entra pela regressão (inclinação × ONI atual).
- **Sem "início das chuvas".** No PR o ciclo anual é fraco no centro-sul,
  sudoeste e litoral (Liebmann et al. 2007 avisam que o critério falha no Sul).
  No lugar: chance de mês no terço mais chuvoso, dias com ≥ 50 mm e uma leitura
  agronômica por mês (soja, milho, trigo, feijão).

## O que os dados mostram (gerado em 2026-10-13)

- Sinal histórico concentrado em **novembro** (r mediano +0,61, significativo
  em 100% das células; El Niños com mediana +40%) e em **abril–maio** do ano
  seguinte (+36% e +45%), como em Grimm et al. (1998). Outubro é misto: 1986,
  1987 e 1991 secos; 1997 e 2023 muito úmidos.
- Normal CHIRPS a 0–5% do BR-DWGD nas cidades de conferência.
- Rodada de out/2026 (ONI JAS +2,16, RONI +1,69): mediana estadual de
  +98% em outubro, +65% em novembro e +35% em dezembro. Em Curitiba, novembro
  fica em 185 mm (p10–p90 de 114 a 277 mm), com 80% de chance no terço mais
  chuvoso e confiança 3/3.

## `el-nino-historico-pr.json` (build_el_nino_historico.py, Earth Engine)

Topo: `fonte`, `creditos`, `gerado`, `anosSafra [1981, 2025]`, `normal [1991, 2020]`,
`limiarForte` (1,0), `fortes` (anos-safra), `oniOND {ano: valor}`, `rCritico`
(|r| mínimo para p < 0,05), `meses [7..6]` (ordem do ano-safra), grade, `escala`,
`celulas`, `campos`.

| Campo | Unidade (após `/ escala`) | Definição |
|---|---|---|
| `normal`, `t33`, `t66` | mm/mês | média e tercis da chuva, 1991–2020 |
| `r` | — (escala 100) | correlação chuva × ONI de OND, 45 anos |
| `incl` | % por °C de ONI | inclinação da anomalia relativa |
| `forteMed`, `forteP25`, `forteP75` | % da normal | anomalia nos El Niños (ONI ≥ 1,0) |
| `forteAcima` | % dos eventos | El Niños com o mês no terço superior |
| `h50Normal`, `h50Forte` | dias/mês (escala 100) | dias com chuva ≥ 50 mm |
| `tNormal` | °C (escala 10) | temperatura média, 1991–2020 |
| `tForte`, `rT` | °C (100), — (100) | anomalia nos El Niños e correlação |

Re-rodar uma vez por ano (13 de setembro, no Actions). Cache por ano-safra em
`.gev-cache/el-nino/`. Travas antes de gravar: chuva anual plausível, CHIRPS a
≤ 15% do BR-DWGD, primavera de El Niño positiva e novembro ≥ +15%.

## `el-nino-previsao-pr.json` (build_el_nino_previsao.py, Actions dia 13 e 20)

Topo: `gerado` (UTC), `meses ['2026-10', ...]` (6), `membros` (51), `rodadaNmme`
(`YYYYMM`), `enso {oni, roni: [{tri, ano, valor}], probCpc: [{tri, laNina,
neutro, elNino}]}`, `escala {tAnom: 10}`, `campos`.

| Campo | Unidade | Definição |
|---|---|---|
| `esperado` | mm | normal × razão do ensemble SEAS5 |
| `anom` | % | razão − 1 |
| `p10`, `p50`, `p90` | mm | dos 51 membros; `null` no mês corrente |
| `pAcima`, `pAbaixo` | % | membros acima do `t66` / abaixo do `t33` observados |
| `tAnom` | °C (escala 10) | anomalia de temperatura do SEAS5 |
| `nmmeAcima`, `nmmeAbaixo`, `nmmeTAcima` | % | tercis do NMME (vizinho de 1°) |
| `conf` | 0–3 | SEAS5 com sinal (≥ 10%) + NMME (≥ 10 p.p.) + histórico (≥ 10%) |

Cota da Open-Meteo: 150 pontos (0,5°), membros diários em lotes de 5 com pausa;
~4 min. Falha de fonte = script sai com erro e o JSON anterior fica publicado.

## Limites conhecidos

- Sem hindcast: a razão corrige o volume médio, não a dispersão; p10–p90 é a
  dispersão do próprio SEAS5 (tende a ser estreita demais).
- Mapa de habilidade (ACC/ROC dos hindcasts) não entrou: os do NMME estão no
  FTP do CPC e os do SEAS5 exigem chave gratuita do CDS. Próximo passo natural.
- A licença do Open-Meteo é CC BY 4.0, e o uso gratuito é não comercial.

## Fontes

Funk et al. (2015) CHIRPS, Sci. Data 2:150066 · Muñoz-Sabater et al. (2021)
ERA5-Land, ESSD 13:4349 · ECMWF SEAS5 (Johnson et al. 2019, GMD 12:1087) via
Open-Meteo · NMME (Kirtman et al. 2014, BAMS 95:585), NOAA CPC · Grimm, Ferraz
& Gomes (1998), J. Climate 11:2863 · Grimm & Tedeschi (2009), J. Climate
22:1589 · Kist & Gebert (2022), RBClima 31 · Liebmann et al. (2007), J.
Climate 20:2037.
