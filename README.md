# DataGeo PR · Sala de Situação

Mapa operacional do Paraná no navegador: os 399 municípios, dados agropecuários, ambientais, sociais, de infraestrutura e de monitoramento em tempo quase real, numa só tela com fichas de município e de regional.

No ar em **https://dgp-comando.github.io** (exige login).

O projeto é um fork do [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (Bilawal Sidhu, MIT), de onde vêm a interface, o HUD, os estilos de sensor, o rastreamento e os links compartilháveis. Os dados vêm dos pipelines do `c2-parana` (Supabase) e dos geradores em `scripts/`. A história da fusão está em [`PLANO_FUSAO.md`](PLANO_FUSAO.md); o diário das sessões, em [`LOG.md`](LOG.md).

---

## O que tem no mapa

O painel **Data Layers** lista primeiro as camadas DataGeo; as do God's Eye View ficam no fim, como contexto.

| Tema | Camadas (exemplos) |
|---|---|
| Monitoramento | Focos de calor (FIRMS), estações de clima (INMET), nível dos rios (ANA), alertas CEMADEN, telemetria InfoHidro, qualidade do ar, dengue (InfoDengue), risco territorial (IRTC), anomalias, incidentes, navios do Porto de Paranaguá, tráfego aéreo ao vivo |
| Clima | Clima histórico (normal 1990–2019), precipitação, ventos, umidade do solo (SMAP), perspectiva El Niño |
| Meio físico | Altimetria, declividade, curvas de nível, geologia, geomorfologia, hidrografia ottocodificada, nascentes, ottobacias, uso do solo, mineração |
| Água e ambiente | Outorgas, licenciamento ambiental, pivôs centrais, fontes protegidas, faxinais, CAR |
| Agropecuária | Agricultura familiar (CAF, pessoas físicas e jurídicas), Defesa Agropecuária (explorações pecuárias, comércio e indústrias), agroindústrias, empresas do agro (CNPJ), armazéns, CEASAs |
| Extensão rural | URs por programa e do GETEC, estações de pesquisa, unidades e endereços, atendimentos |
| Social | CadÚnico rural, CRAS/CREAS e segurança alimentar, estabelecimentos de saúde (CNES) |
| Infraestrutura | Rodovias, ferrovias, estradas municipais e conveniadas, transmissão, distribuição, subestações, usinas, geração distribuída solar, rede Copel, conectividade, rádios |
| Contexto global | Terremotos (USGS), datacenters, barragens, cabos submarinos |

A ficha de município (e a de regional, que soma os municípios) reúne indicadores, totais por camada e os resumos das bases privadas.

Mapas base sem chave: Satélite (Esri World Imagery), OpenStreetMap raster e vetorial (OpenFreeMap), em globo ou 2D, com relevo opcional.

## Acesso e dados pessoais

- **Login obrigatório** (Supabase Auth). Na primeira entrada o usuário assina o termo LGPD; há recuperação de senha pelo CPF do termo.
- Bases com dados pessoais (CAF, CadÚnico, Defesa Agropecuária, GETEC e afins) ficam no bucket privado `datageo-privado` e só carregam para usuários autorizados. Usuários externos não veem essas camadas (`src/data/acessoExterno.js`).
- Cada acesso fica registrado em `datageo_acesso_log` (só inserção).
- Detalhes das migrations e Edge Functions ficam no repo `c2-parana`.

## Rodar localmente

Requer Node.js 24.14.x ou 26.x.

```bash
npm install
npm run dev -- --host localhost --port 4173
```

Abra `http://localhost:4173`. No servidor de desenvolvimento, `?semlogin` pula o login (só para QA). O `.env` é opcional: copie de `.env.example` se quiser as chaves das camadas do God's Eye View.

```bash
npm test          # testes unitários (*.test.mjs)
npm run build     # build estático em dist/
```

## Produção

- `deploy-pages.yml` publica o build no GitHub Pages a cada push no `main`.
- O app é estático: as camadas DataGeo leem o Supabase direto do navegador com a anon key, sob RLS.
- Camadas do God's Eye View que dependem dos proxies do servidor de desenvolvimento (satélites, militares, CCTV, rádio mundial, trânsito, bikeshare, AIS global, lançamentos) **não entram no build de produção** e são trocadas por stubs (`src/prodStubs/`). A voz (OpenAI Realtime) também só funciona em dev.
- O tráfego aéreo funciona em produção pela Edge Function `aviacao-live`.

## Atualização dos dados

| Origem | Como atualiza |
|---|---|
| Monitoramento (clima, rios, alertas, focos, etc.) | pg_cron + Edge Functions do `c2-parana` |
| Umidade do solo | GitHub Actions diário (`atualiza-umidade-solo.yml`) |
| El Niño | GitHub Actions, dias 13 e 20 (`atualiza-el-nino.yml`) |
| Energia (ANEEL) | GitHub Actions mensal (`atualiza-dados-energia.yml`) |
| MDS (proteção social) | GitHub Actions semanal (`atualiza-dados-mds.yml`) |
| Demais camadas estáticas | Geradores `scripts/build_*.py`, rodados à mão; bases privadas sobem com `scripts/upload_privado.py` |

## Estrutura

```
src/
├── main.js            # boot, login, registro das camadas
├── maplibre/          # motor do mapa (engine.js), contrato de camada (kit.js), mapas base
│   └── layers/        # camadas DataGeo desenhadas no MapLibre
├── data/              # camadas vivas, clientes Supabase, fichas e políticas
├── datageo*.js        # login, senha, ficha, briefing, ticker, atalhos
├── prodStubs/         # stubs das camadas que só existem em dev
└── voice/             # sessão de voz OpenAI Realtime (dev)
scripts/               # geradores de dados (Python) e harnesses de QA (Node)
public/                # dados estáticos servidos pelo Pages
docs/                  # migração para MapLibre, estado atual, clima, El Niño
```

O motor deixou de ser CesiumJS em 2026-09 e passou a ser MapLibre GL JS 6.7; o que era 3D (modelos de aeronaves, Google 3D Tiles) virou equivalente 2D. Ver [`docs/MIGRACAO_MAPLIBRE.md`](docs/MIGRACAO_MAPLIBRE.md).

## Licença e fontes

Código sob [MIT](LICENSE), herdada do God's Eye View. Cada base tem seus próprios termos; ver [`DATA_SOURCES.md`](DATA_SOURCES.md) e os créditos de cada camada no app.

> Os dados podem estar atrasados, incompletos ou errados. Não use para decisões de segurança ou emergência sem conferir na fonte oficial.
