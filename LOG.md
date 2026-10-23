# LOG de desenvolvimento — DataGeo Command

> Diário das sessões de trabalho neste repo. Uma entrada por sessão, mais
> recente primeiro. O plano vivo é o `PLANO_FUSAO.md`; aqui fica o registro
> de COMO cada fase aconteceu, com as decisões e as pegadinhas.

---

## Sessão 2026-10-23: explorações pecuárias da ADAPAR, URs do GETEC e enrich de imóvel (fase 0)

Pedido: classificação por atividade nas propriedades com exploração pecuária
da ADAPAR, como nas outorgas, com totais nas fichas de município e de
regional. Depois, a Declaração de Exploração 2024 com bubalinos e a fusão
dos pontos repetidos; por fim, as URs do GETEC ligadas à CAF. Commits
`7b458f7`, `db43e31`, `654c175` `8595c0d` (URs), mais a fase 0 do enrich de imóvel; deploy no Pages concluído.

- **Fonte da atividade.**
  - O export atual (`explorações+ativas.csv`, out/2026) não traz espécie nem tipo de exploração.
  - A espécie vem dos cadastros da ADAPAR de mar/2022 em `H:\IDR-PARANA\SEAB\FONTES_BENNO`: `AVES(3).csv`, `BOVINOS(corr).csv` e `SUINOS(3).csv`, em cp1252 e sem nome nem CPF.
  - O cruzamento é pela coordenada exata GGMMSSs (campos `LAT_GRAU`/`LAT_MIN`/`LAT_SEG`). Cerca de 93% dos registros de 2022 encontram uma propriedade de hoje.
- **Classificação.** Com várias espécies vale a primeira, em ordem de prioridade:
  1. suinocultura comercial (área de atuação Produção ou Reprodução);
  2. avicultura comercial (qualquer classificação além de "Não se Aplica");
  3. bovinocultura de leite;
  4. bovinos de corte e leite;
  5. bovinocultura de corte;
  6. bubalinocultura (2024);
  7. bovinos, finalidade não informada (2024);
  8. aves ou suínos de subsistência;
  9. aves ou suínos, porte não informado (2024);
  10. sem espécie nos cadastros.
- **Resultado.** Só com 2022, 153 mil das 256,6 mil propriedades no mapa ganharam atividade. Com 2024, ficam 73,8 mil (~29%) "sem espécie".
- **Gerador** (`scripts/build_adapar.py`).
  - Grava a atividade como último campo de cada ponto de `adapar-exploracoes.json.gz`.
  - Gera o resumo por município `adapar-exploracoes-municipios.json` (contagens por DAP/CAF e por atividade).
  - Os dois arquivos subiram para o bucket `datageo-privado` com `upload_privado.py adapar-exploracoes`.
- **Camada.**
  - Chips **DAP/CAF / Atividade** (`EXPLORACOES_MODOS`); `onLegend` troca a cor dos pontos e o filtro da legenda.
  - O tooltip ganhou a linha "Atividade"; o rodapé do tooltip e o da ficha citam as duas fontes (2022 e 2024).
- **Ficha.**
  - Nova seção "Exploração pecuária · ADAPAR" na ficha municipal e na regional: total de propriedades, barras por atividade e por DAP/CAF.
  - Na regional, soma os municípios. Sem acesso ao bucket privado a seção não aparece.
- **Verificação.**
  - 16 testes em `defesaAgropecuaria.test.mjs` passaram, incluindo o dado real: toda propriedade tem atividade e o resumo bate com os pontos.
  - `npm test` e o build passaram.
  - `qa-defesa-agropecuaria.mjs`: 34/34, com chip, legenda, cor, tooltip, ficha de Palotina (944 propriedades) e ficha regional (1.432).
- **Declaração de Exploração 2024** (pedido seguinte na mesma sessão).
  - Fonte: `H:\IDR-PARANA\GEOPROCESSAMENTO\adapar`, com aves, bovinos, bubalinos e suínos. Também está em `pecuária.gpkg`.
  - Traz só cabeças, sem finalidade nem porte. Entra abaixo do detalhe de 2022, com três classes novas: bubalinocultura (148), bovinos com finalidade não informada (27,9 mil) e aves ou suínos com porte não informado (3,5 mil).
  - "Sem espécie" caiu de 103,7 mil para 73,8 mil.
  - 86 linhas desalinhadas (nome de produtor numa coluna de cabeças) ficam de fora; dessas linhas nada é lido.
  - Linhas com zero cabeças ou sem coordenada também ficam de fora. A coordenada decimal vira GGMMSSs (`gms_decimal`) e casa como a de 2022.
  - Verificação: os mesmos 16 testes, `npm test` (2.980) e o build passaram; QA 34/34 com as 10 classes na legenda e na ficha.
  - Ovinos, caprinos e equinos foram pedidos, mas não existem em nenhum arquivo local (procurado em H:, Downloads, Documentos e OneDrive). Falta um export do painel da ADAPAR com essas espécies.

- **Pontos repetidos fundidos** (terceiro pedido da sessão).
  - 10.166 coordenadas tinham mais de uma propriedade (22,8 mil pontos). Eram de dois tipos: a mesma propriedade com outra grafia ("SITIO SANTA ELISA" / "SÍTIO SANTA ELISA") ou vizinhas cadastradas num ponto só (até 68).
  - Regra pedida: fundir só quando a coordenada e o conjunto de produtores são os mesmos. Com produtores diferentes, os dois pontos ficam (`funde()` agrupa por lon, lat e os produtores normalizados).
  - Melhor informação de cada campo:
    - DAP/CAF e atividade: a de maior prioridade;
    - "fora do município": só se todos estiverem fora;
    - município: o mais frequente;
    - nomes e produtores: todos;
    - área: a maior de cada nome (sem acento nem caixa), somada entre nomes diferentes.
  - Pontos sem produtor vinculado na mesma coordenada também se fundem entre si ("nenhum produtor" conta como produtores iguais). Fica em aberto: se o usuário preferir separados, é uma linha na chave de `mesma` em `build_exploracoes`.
  - Resultado: 256.551 → 254.732 pontos (1.762 coordenadas). Em Palotina, 944 → 935.
  - O arquivo ganhou o campo `n_propriedades`; o tooltip mostra "N propriedades do mesmo produtor neste ponto" com a lista.
  - Verificação: os mesmos 16 testes (um deles garante que não há ponto repetido com os mesmos produtores), `npm test`, build e QA 34/34.

- **URs do GETEC** (quarto pedido da sessão; UR = Unidade de Referência).
  - O que dá para consultar no GETEC:
    - Com login, menu "Unidade de referência": `lista/lista_ur4.php?id=<codext>&nivel=1` (ano, projeto, produtor, município) e os relatórios em PDF `relatorios/rel_ur_{est,reg,mun,ext}.php` e `rel_sustenta_*` (Marco Zero de sustentabilidade), filtros Ano/CodReg/CodAdi/CodMun/CodExt/CodPro.
    - Sem login, nada específico de UR.
    - Não há coordenada nem histórico (2025 vazio).
  - Lista completa: `lista_ur4` de 847 extensionistas (selects de `cad_ur3` e `rel_cad_ur`) dá 639 URs (635 de 2026, 4 de 2027). Bate com o nominal `rel_ur_reg` em Ivaiporã, Toledo, Paranavaí e Ponta Grossa; o resumo do `rel_ur_est` (760) não fecha.
  - Ligação (`scripts/build_getec_urs.py`), em ordem:
    1. nome igual a um membro da família da CAF no município (344, mais 13 sem ponto);
    2. nome aproximado (52): 1º e último nomes e todos os nomes da UR no da CAF, aceitando inicial e um erro de digitação. Só 1º+último trazia erros ("Paulo Henrique da Silva" → PAULO ANTONIO);
    3. nome único no estado em outro município (15);
    4. produtor da ADAPAR no município (57);
    5. centro do município, em anel (171, que incluem 14 homônimos). Centro = centróide (o ponto interno do shapely ficava até 7,8 km dele, mediana 2 km); ponto interno só se o centróide cair fora.
  - 73% com ponto. 43 pontos da CAF caem fora do município da UR e saem esmaecidos.
  - Comparação com as camadas atuais (planilhas dos programas): quase não se repetem. Grãos 48 de 199, Café 2 de 62, Pecuária de corte 6 de 68; piscicultura sem nome. No diagnóstico de agroindústrias, 10 das 33 URs de Agroindústria. Onde há par, os pontos conferem (mediana de 0,1 a 0,9 km). As camadas atuais ficam; "Também em" marca 57 URs.
  - Camada `datageo-urs-getec` (token `Pf`, no fim do registro; `layerState.test` agora conta 81), `CAMADAS_PRIVADAS`, seção da ficha (`getUrsGetec`), QA `qa-programas-idr.mjs` 27/27.
  - Legenda por projeto (pedido seguinte): `GETEC_FAMILIAS` com os 31 projetos do catálogo do GETEC (select 511 de `rel_cad_ur`), um tom por projeto dentro da cor da família (`tom()`), 32 cores distintas; `makePointsLayer({legendaSoComDados})` esconde os projetos sem UR.
  - Relatório quantitativo (estado, regional, projeto e regional × projeto, só agregados) em `URs_GETEC_2026.html` na área de trabalho; script fora do repo.

- **Enrich de imóvel, fase 0** (último pedido; estudo "Mireye para o PR").
  - Estudo: os imóveis ativos do CAR (539.477) fazem o papel das parcels; as camadas viram campos; a `public-api` do c2 já tem chave `dgp_live_`, cota, `api_usage` e Stripe. Fases: 0 enrich local, 1 lote GeoParquet dos 539 mil, 2 search/enrich/compare na API, 3 MCP remoto. Motor fora do Supabase do c2 (Micro, Disk IO no limite): DuckDB + GeoParquet. API pública só com dado público (nada do bucket privado).
  - `scripts/enrich_imovel.py`: código do CAR ou lon/lat vira 81 campos, cada um com rótulo, unidade e fonte (catálogo em `meta.catalogo`, avisos em `meta.avisos`), no envelope `{success, data, error, meta}`. CLI, `--servir PORTA` (`/v1/enrich?car=` ou `?lon=&lat=`, `/v1/fields`) e `--avaliar N`.
  - Campos: imóvel do CAR; município, regional IDR e módulo fiscal; declividade e uso do solo lidos dos PNG de 30 m (bbox de `aspectos-fisicos-pr.json`, mercator); sobreposição com UC federal/estadual, TI, quilombola, assentamento, faxinal; distâncias (rodovias, ferrovia, LT, armazém CONAB, CEASA, subestação) em UTM 22S; cobertura celular; ottobacia; pivôs a 5 km; clima BR-DWGD; preço da terra SIPT por classe (A-I a C-VIII, do `precos-de-terras`); VBP e população.
  - O CAR vem das fatias do mapa (`public/data/car`, delta encadeado por grupo, ~5 m): o acervo bruto do `fetch_car.py` não está no disco. Fontes ao vivo (outorgas, licenças) ficam para a fase 1.
  - Avaliação (200 imóveis sorteados, semente 7): área da geometria / declarada com mediana 0,995 e 96% entre 0,9 e 1,1. Uma falha, corrigida: nó do clima fora da máscara na divisa (Pérola d'Oeste) passou a usar o vizinho com dado. Casos-ouro: REBIO das Perobas (47,9% de sobreposição) e Curitiba (CEASA Curitiba). Uma chamada leva ~5 s a frio; a avaliação inteira, ~3 min.

### Pegadinhas
- Os selects de extensionista do GETEC vêm em UTF-8 no meio de páginas
  latin1: ler a página como latin1 quebra "João" (o teste de mojibake pegou).
- O `LAT_DEC`/`LONG_DEC` do `SUINOS(CORR).csv` vem arredondado e só encontra 8%
  das propriedades. Usar grau, minuto e segundo (`SUINOS(3).csv`).
- Cerca de 29% "sem espécie": propriedade nova, coordenada alterada ou só
  ovinos, caprinos ou equinos, que não estão nos cadastros de 2022 nem de
  2024. Um export atual do painel da ADAPAR com espécie por propriedade
  substitui essa ponte.
- Na Declaração 2024 há nome de produtor em coluna de cabeças (linha
  desalinhada): nunca ler colunas fora do cabeçalho nomeado.
- Ao escrever caminhos Windows por script Python, `\a` vira o caractere BEL
  (já aconteceu em `GEOPROCESSAMENTO\adapar`): usar string raw.

---

## Sessão 2026-10-21: Disk IO do c2-parana e alertas sem fan-out

E-mail da Supabase: "c2-parana is running out of Disk IO Budget" (compute Micro,
224 MB de shared_buffers). Correção no c2-parana, PR #10, já em produção.

- **Causa.**
  - `etl-alerts` e `etl-correlations` gravavam uma notificação por linha de `profiles`. Desde 2026-09-23 o Auth do c2 guarda os ~1.143 usuários do DataGeo, então cada disparo de regra virava 1.000 linhas (limite do PostgREST).
  - `notifications` chegou a 436 mil linhas e 235 MB. 99% eram de usuários do DataGeo, e só 54 linhas tinham sido lidas.
  - O cooldown por `sent_at` fazia seq scan numa tabela maior que o cache.
  - Nenhum push ou e-mail saía de fato; o estrago era só IO.
- **Decisão.** O C2 será descontinuado. Nenhum usuário recebe mais alertas, e fica só o que o DataGeo usa:
  - `incidents` (`fetchActiveIncidents` e a ficha do município);
  - `situational_reports.active_alerts_count` (briefing).
- **Correção.**
  - Cada disparo grava um registro com `user_id null`, como no `etl-cemaden`. Esse registro segue servindo de cooldown, de contagem do `etl-situational` e de base para a criação de incidentes.
  - Saem as leituras de `profiles` e `notification_preferences`.
  - O `active_alerts_count` do briefing cai de milhares para dezenas, que é o número real de disparos.
- **Verificação.**
  - `deno check` passou; deploy das duas funções.
  - O `etl-alerts` das 09:30 UTC gravou 1 linha, onde antes seriam 2.000. O `etl-correlations` das 09:45 UTC não gravou nenhuma linha por usuário.
  - Os 3 incidentes ativos foram mantidos.
- **Limpeza.**
  - 435.062 linhas por usuário apagadas em lotes de 50 mil, preservando as referenciadas por `incidents.source_notification_id`.
  - Depois, `VACUUM FULL`: a tabela foi de 235 MB para 584 kB (1.271 linhas).

### Pegadinhas
- Nunca refazer fan-out por `profiles` no c2. Todos os perfis são `viewer` e
  quase todos são do DataGeo. O `etl-escalation` mira `commander`/`operator`,
  papéis que ninguém tem.
- DELETE sozinho não encolhe a tabela; o seq scan continua lendo as páginas
  vazias. Para devolver espaço é preciso `VACUUM FULL`, que é rápido quando
  sobram poucas linhas.
- O `etl-aviacao` a cada minuto continua sendo o maior gerador de WAL
  (~17 GB desde março). Se o aviso de IO voltar, é o próximo alvo.

---

## Sessão 2026-10-20: log de acesso, painel de acessos, usuário externo e solicitação de acesso

Painel "Acessos ao DataGeo" (botão `#analytics-btn`, só `datageo_admin`) e tudo
o que gira em torno dos usuários. Banco no c2-parana, migrations 048 a 053
(PRs #4 a #9, já aplicadas); a Edge Function `datageo-usuarios` foi
republicada a cada etapa.

- **Log de acesso** (`src/data/acessoLog.js`, migrations 048/049).
  - Gravado em `datageo_acesso_log`. O usuário só insere a própria linha; `user_id` e `criado_em` vêm do servidor.
  - O envio sai em lote (15 s, 20 eventos ou aba escondida). Falha transitória devolve o lote à fila; o envio de saída usa keepalive em pedaços.
  - O banco recusa mais de 300 eventos por minuto por usuário. Retenção de 12 meses via pg_cron.
  - Eventos registrados:
    - sessão, saída e heartbeat de 5 min;
    - camada ligada ou desligada (só por intenção do usuário, restauração não conta);
    - ficha municipal e regional, cadastro aberto (`openPainel`);
    - busca de pessoa (termo em claro, decisão do usuário), arquivo restrito e exportação;
    - ações do admin.
- **Painel** (`src/datageoAnalytics.js`), lido pelas RPCs `datageo_acesso_resumo` e `datageo_acesso_eventos`.
  - Aba Visão geral: KPIs (DAU/WAU/MAU, sessões, mediana, nunca entraram, acesso a dado pessoal), usuários por dia, camadas, lotação (matrícula = id do SisPont), municípios, heatmap dia × hora e retenção semanal.
  - Aba Usuários: botões Revogar/Reativar e checkbox Externo em cada linha. Filtros: ativos, inativos, nunca entraram, externos, revogados.
  - Aba Solicitações: pedidos de externos, com Aprovar e Recusar.
  - Aba Log completo: filtros e CSV paginado em blocos de 1000.
  - Matrícula derivada do e-mail `<matricula>@sisater.local` (`datageo_matricula`), porque o `user_metadata` é editável pelo próprio usuário.
- **Revogar e reativar** (ações da `datageo-usuarios`, migration 050). O resumo lista revogados (chave `datageo` presente e `false`). Revogados em 2026-10-20: edtadeu1@gmail.com, 1697 e teste@teste.com.
- **Usuário externo** (`app_metadata.datageo_externo`, `src/data/acessoExterno.js`, migrations 051/053).
  - O bucket `datageo-privado` é negado na policy.
  - As 22 camadas de `CAMADAS_PRIVADAS` não são registradas, a busca de pessoas some e o `dgFetchData` devolve 403 para `/privado/` sem fazer requisição.
  - A 053 restringe o `data_cache` às 3 chaves que o front lê. Fecha também 8 tabelas que o DataGeo não usa e as escritas em incidentes (`datageo_interno()`).
- **Solicitar acesso** (`src/datageoSolicitacao.js`, migration 052).
  - É só para externos; servidor entra com matrícula e senha provisória.
  - Campos: entidade, nome, endereço, CPF, telefone, e-mail e finalidade, mais aceite LGPD.
  - INSERT anônimo só nessas colunas, uma pendente por e-mail (409), 30 pedidos por hora. Recusadas são apagadas em 90 dias.
  - Aprovar cria a conta com login = e-mail e mostra a senha temporária uma única vez (não há envio de e-mail).
- **Termos**:
  - O termo LGPD do servidor foi para a versão 2026-10-20, que informa o registro de uso (todos assinam de novo).
  - O externo assina o "Termo de uso para usuário externo" (`externo-2026-10-20`): só dado público, e a obrigação é citar a fonte. `termoDe(user)` escolhe; mudar de perfil pede nova assinatura.

### Pegadinhas
- plpgsql: variável com o mesmo nome de coluna de CTE (`ini`) dá 42702 só na
  primeira chamada; o `create function` passa. Prefixo `v_` nas variáveis.
- O MCP do Supabase não faz `set role authenticated` nem tem execute nas RPCs.
  Teste de RLS: curl com a anon key e `set_config('request.jwt.claims', ...)`
  avaliando a expressão das policies.
- Editar um módulo com o Vite rodando faz o app importá-lo com `?t=`. Um
  `import('/src/...')` do QA pega outra instância. Reiniciar o dev server
  antes do QA; `TaskStop` deixa o node vivo na porta 5173 (matar pelo PID).
- Git Bash no Windows estraga acento em argumento de `curl -d`: mandar JSON por
  arquivo UTF-8 (`--data-binary @arquivo`).
- `#usuarios-dialog` também usa `.login-form`; seletor de QA do gate precisa de
  `#loading-screen`.
- Camada nova que leia `/privado/` entra em `CAMADAS_PRIVADAS`. Chave nova de
  `dgCache` que o externo precise ler entra na allowlist da 053. Nos dois casos,
  se esquecer, a camada chega vazia para o externo, sem vazar dado.
- Ficou uma solicitação de teste pendente ("QA Teste Ação",
  qa-solicitacao@exemplo.invalid): recusar pela aba, não aprovar.

---

## Sessão 2026-10-16: atendimentos do SISATER no card do produtor

Fecha a pendência do `build_getec_fichas.py` ("atendimentos datados virão do
banco"). Banco do SISATER na rede interna do IDR: PostgreSQL 8.3, base
`sisater`, leitura com usuário próprio (credenciais `SISATER_DB_*` no `.env`).

- `scripts/build_getec_atendimentos.py` (~1 min): `tb_saateind` (4,9 mi
  atendimentos individuais 2008 a hoje) e `tb_saeventocli`+`tb_saevento`, por
  família da CAF. Ligação: CPF dos membros (`caf/<ibge>.json`) = `tb_sacadcli.cpfcli`.
  137.888 clientes casados; 91.242 famílias (89.134 com atendimento, 2.108 só
  com evento); 15.653 das 15.663 fichas de grupo (as 10 restantes não têm
  nenhum registro no banco). Saída `data/privado/getec-atendimentos/<ibge>.json`
  (398 arquivos, 63 MB, maior 1,3 MB): o estado inteiro num arquivo só não serve
  ao clique.
- Front: `loadGetecAtendimentos(ibge)` + `prontuario(ficha, caf, atend)` e a
  seção "Prontuário de atendimento · GETEC" com nº, período, horas, últimos 5
  anos, 3 últimos atendimentos e eventos. Testes em `getecFichaProdutor.test.mjs`.
- Revisão adversarial (workflow, conferência contra o banco): a mesma visita
  lançada para dois membros aparecia duas vezes nos "últimos" (6.212 famílias).
  Agora é deduplicada por (data, método, ação, atividade, técnico); evento por
  (codorg, codmun, codeve); empate de data com ordem estável; gravação via
  `.tmp` + `os.replace` e aborta sem apagar nada se nada casar.

### Pegadinhas
- PG 8.3: sem window function e sem CTE; alias de coluna exige `AS`.
- A view `atendimento` existe mas o usuário não tem SELECT; as tabelas base sim.
- Datas sujas: ano 25 em `tb_saateind`, ano 72025 em `tb_saevento` (psycopg2
  quebra no `fetch`). Filtrar `between '2008-01-01' and current_date` no SQL.
- `cpfcli` com 8 a 10 dígitos = zeros à esquerda perdidos (todos passam no dígito).
- ~0,15% dos casamentos por CPF não batem nem por nome da família (CPF de outra
  pessoa no cadastro do SISATER); ficou sem filtro, a conferir.

---

## Sessão 2026-10-13: perspectiva El Niño (camada `datageo-el-nino`)

Origem: o El Niño Explorer da Morfo (morfo.rest/el-nino-explorer) não tem
licença de reuso. Montada uma camada própria só com fontes abertas, melhor
para o PR: grade de 0,1° em vez de 0,25° e previsão calibrada na normal
observada. Método, números e contrato em `docs/EL_NINO.md`.

- `scripts/build_el_nino_historico.py` (Earth Engine, anual): CHIRPS diário e
  ERA5-Land de 1981-82 a 2025-26; por célula e mês, normal e tercis 1991–2020,
  r e inclinação no ONI de OND, composição dos 10 El Niños com ONI ≥ 1,0
  (mediana e quartis), dias com ≥ 50 mm e temperatura. 1.078 KB (~280 KB gzip).
- `scripts/build_el_nino_previsao.py` (Actions, dias 13 e 20, sem chave):
  SEAS5 pela Open-Meteo (razão sobre a climatologia do modelo × normal CHIRPS;
  51 membros diários → p10/p50/p90 e chance de terço chuvoso), tercis do NMME,
  ONI/RONI e probabilidades do CPC, confiança 0–3. 461 KB, ~4 min.
- `src/maplibre/layers/elNino.js` (token `Eb`): chips CHUVA, EXCESSO, TEMP,
  SINAL e de mês; véu cinza onde a confiança é ≤ 1 ou o r não é significativo;
  tooltip com previsão, faixa, NMME, leitura agronômica, histórico e ENSO.
- `.github/workflows/atualiza-el-nino.yml`; `scripts/qa-el-nino.mjs` (11/11);
  `elNino.test.mjs` (11/11); suíte completa 2.958/2.958.
- Revisão de código: falha parcial de fonte agora aborta (nulos do SEAS5,
  resposta curta, fill value do NMME, membros faltando); previsão grava o
  `gerado` do histórico e o front recusa arquivos de gerações diferentes; véu
  obedece ao filtro da legenda; histórico com nova tentativa no dia 20 e sem
  derrubar a previsão.

### Pegadinhas
- **Open-Meteo Seasonal:** sem `timezone`, o eixo mensal começa no 1º dia do
  mês corrente. Com fuso de Brasília os rótulos recuam um dia
  (`2026-09-30` = outubro). Os membros diários começam HOJE: o mês corrente
  sai só com a média.
- **NMME prob:** o atributo diz `percent`, mas os valores vêm em fração (0,66).
- ONI ≥ 1,5 em OND dá só 4 eventos desde 1981; a composição usa ≥ 1,0.
- Outubro é misto no histórico (não serve de trava); novembro é o pico.
- ERA5-Land não cobre o litoral: a temperatura herda os vizinhos (`focalMean`).
- `layerState.test.mjs`: registro com 80 ids DataGeo / 96 no total.

---

## Sessão 2026-10-11: estabelecimentos de saúde (CNES)

- Camada `datageo-cnes-saude` (token Sa, aba Saúde e proteção social,
  bucket privado): os 32.337 estabelecimentos ativos do PR com coordenada,
  lidos dos brutos do saude-parana (CNES nacional, leitos CGHID/MS, região de
  saúde por município). Cor e filtro pelas 9 famílias de tipo do saude-parana
  (hospital e pronto atendimento maiores). Tooltip com todos os campos do
  cadastro: tipo, SUS, leitos e UTI, serviços, turno, ensino, esfera, gestão,
  natureza jurídica, CNPJ e mantenedora, endereço, região de saúde, telefone,
  e-mail. Consultório de pessoa física traz nome e contato (autorizado).
- Pegadinhas: `['zoom']` não pode ficar dentro de `['*', ...]` no
  circle-radius (só no interpolate de fora); natureza 4000 (pessoa física) é
  código só do CNES, fora da tabela da Receita. 4 sem coordenada ficam fora;
  1.504 empilhados espalhados em espiral.
- QA: qa-cnes-saude 6/6; unitários das camadas 227/227.
- Umidade do solo (`datageo-umidade-solo`, token Ub, aba Recursos hídricos,
  JSON aberto `public/data/umidade-solo-pr.json`): pedido foi o NASA-USDA
  Global Soil Moisture, mas no Earth Engine ele parou (0,25° em 2020-12-31,
  10 km em 2022-08-02) e o HTTPS do GIMMS não tem mais o SMAP; usado o
  sucessor do catálogo, SMAP L4 (`NASA/SMAP/SPL4SMGP/008`, 9 km, 3/3 h).
  Grade 0,09° (75x48) do último dia (média das 8 imagens), 2.446 células no
  PR, cor pelo percentil da zona de raiz (5 classes, seco a úmido), tooltip
  com raiz, percentil, saturação, superfície, anomalia e perfil. **Estático:**
  rerodar `scripts/build_umidade_solo.py` (EE_PROJECT=ee-avnerpaesgomes) para
  atualizar. Pegadinha: `atScale` em EPSG:4326 é em metros (grade explodiu);
  usar `ee.Projection('EPSG:4326', [passo, 0, x0, 0, -passo, y0])` e fixar
  W x H. QA: qa-umidade-solo 6/6.
- Geração distribuída solar (`datageo-gd-solar`, token Ga, aba Energia e
  conectividade, JSON gz aberto `public/data/gd-solar-pr.json.gz`, 9,7 MB):
  330.413 UFV da relação de GD da ANEEL (ref. 07/2026, parquet do projeto
  energy em G:/UPWORK/01-CONTRACTS/energy), data de conexão do SIGEL pelo
  código GD (270 mil). PF já vem mascarada pela ANEEL (CPF, nome, CEP);
  coordenada arredondada a 0,01° na fonte, então os empilhados (até 642 no
  mesmo ponto) saem em espiral de 15 m, avisado no tooltip. Cor pela classe
  de consumo, raio pelo log da potência. 884 sem coordenada no PR ficam fora.
  O leitor aceita o .gz descomprimido ou não (`lerJsonGz`), porque servidor
  pode mandar Content-Encoding. QA: qa-gd-solar 6/6; unitários 235/235.
- Automação (GitHub Actions, padrão do atualiza-dados-mds.yml: commit só se
  mudou + dispara deploy): `atualiza-umidade-solo.yml` diário 07h (conta de
  serviço do Earth Engine no secret `EE_SERVICE_ACCOUNT_KEY`) e
  `atualiza-dados-energia.yml` mensal dia 15 (build da GD baixa direto da
  ANEEL e do SIGEL; ENERGY=<pasta> ainda lê os parquets locais).
- Pegadinhas da ANEEL ref. 10/2026: (1) o parquet não traz mais a coordenada
  do empreendimento: posição agora vem do SIGEL (272 mil, 80%) e o resto vai
  para um ponto interno do município, vazado; (2) ~35 mil sistemas da Copel
  passaram a 75 kW (teto da microgeração) com potência real em 07/2026 e no
  SIGEL (mediana 5 kW), inflando o total em 2,3 GW: quando ANEEL = 75 e SIGEL
  < 75, vale o SIGEL, com aviso no tooltip. Total ficou 4.552 MW (jul: 4.273).
  Gzip com mtime=0 para o mesmo dado dar os mesmos bytes (sem commit à toa).
- No Actions: a conta de serviço `datageo-actions@ee-avnerpaesgomes` (secret
  EE_SERVICE_ACCOUNT_KEY) autenticou na 1ª rodada. O SIGEL dá timeout para os
  runners do GitHub (IP de fora do Brasil; a ANEEL baixa normal): o build cai
  no extrato `data/cache/sigel-gd-pr.csv.gz` (2,9 MB, renovado sempre que o
  build roda daqui), com o mesmo resultado byte a byte.

---

## Sessão 2026-10-09: geologia e recursos minerais; postes e trafos da Copel

- Cinco camadas novas em Aspectos físicos (`geologia.js`, tokens Fi a Fm):
  litologia (GeoPR, padrão SGB), geomorfologia e falhas/diques da ZEE-PR,
  processos minerários da ANM (via GeoPR, sem titular) e ocorrências
  minerais do SGB (WFS com CORS aberto, 233 pontos).
- Pegadinhas: o serviço `Processos_Minerários_ANM` só responde com o nome
  codificado na URL (`encodeURIComponent`); o cache da litologia vai do zoom 7
  ao 16 (404 fora disso).
- Copel: transformadores (UNTRMT, 458 mil) e postes (PONNOT, 3,75 milhões)
  da BDGD 2022 já baixada, a mesma das linhas de MT, em PMTiles escritos
  pelo GDAL do pyogrio (`build_rede_copel_pontos.py`) e lidos pelo protocolo
  `pmtiles://` (dependência `pmtiles`, registrada no engine.js). Trafos
  9,1 MB (zoom 10 a 12), postes 24,5 MB (só zoom 13); contagem conferida
  contra a .gdb (perda só de pontos coincidentes, ~1% em área densa).
- Pegadinhas: o PMTiles lido pelo pyogrio está em EPSG:3857 (bbox em graus
  devolve zero); o MVT do GDAL sai sem id de feição, então não há realce
  por feature-state no hover desses pontos.
- QA: qa-geologia 14/14; qa-rede-copel 7/7; unitários 2928/2928.
- Código MAT=MT dos postes é metálico (coincide com as ~16 mil torres,
  altura mediana 34 m), não madeira; ALT confere com metros.
- Retomada: deploy do Pages ok; em produção os dois PMTiles respondem
  206 Partial Content (Range funciona no GitHub Pages).
- ESF (esforço) e ESTR (estrutura) dos postes seguem em código BDGD: as
  tabelas TESTESF e TESTR estão no Manual de Instruções da BDGD, mas o PDF
  da ANEEL fica atrás de Cloudflare, o item do ArcGIS Hub é privado e as
  cópias abertas (Scribd, repositórios no GitHub) não trazem as tabelas.
  Quem tiver o manual: rotular em `redeCopel.js` (posteTooltip).
- Opcional, não feito: zee_geologia, plerh_geolog_mineropar, unidades aquíferas.
- Pivôs centrais de irrigação (camada `datageo-pivos`, token Ua, aba Recursos
  hídricos): os 302 do projeto pivos-pr (ANA/INPE 2022 × outorgas IAT/ANA),
  ponto no estado e círculo do zoom 10 em diante, cor e filtro pelo vínculo
  com a outorga; sem requerente. QA: qa-pivos 7/7; unitários 2931/2931.
- Empresas do agro (CNPJ, `datageo-cnpj-agro`, token Ea, bucket privado):
  35.203 da extração geocodificada do gestaodeater, com todos os campos da
  Receita relidos dos zips (inclui Simples/MEI; Naturezas, Motivos,
  Qualificações e Simples baixados do WebDAV da Receita, mês 2026-07).
  Usuário autorizou dado sensível completo (plataforma com login e termo).
  Pegadinhas: CSV do gestaodeater com BOM (utf-8-sig); telefone ausente vem
  como '(0000) 00000000'; o primeiro upload levou reset de conexão (repetir
  resolve). QA: qa-cnpj-agro 6/6; unitários 2934/2934.

---

## Sessão 2026-10-07 (noite, 2): ottobacias

- Duas leituras, duas camadas: microbacias do IDR (PROtto, 6.210 ottobacias,
  cor e filtro na legenda pelo manancial Sanepar/IDR, linha na ficha com a
  contagem e os mananciais) e ottobacias por trecho do GeoPR (área de
  contribuição de cada trecho da Hidrografia, mesmo `cobacia`).
- `geoprVista.js`: consulta da vista ao FeatureServer virou fábrica comum
  (trechos da hidrografia e áreas das ottobacias). `geoprRaster.js`: helpers
  de imagem do GeoPR saíram de aspectosFisicos.js; export aceita `simbolo`
  (dynamicLayers) para desenhar só o contorno.
- Pegadinhas: o cache das áreas vem com preenchimento azul opaco (fica só no
  zoom 9 a 11, translúcido; depois, contorno pelo export); `zoom` dentro de
  `case` é inválido no MapLibre, o interpolate tem que estar no topo.
- QA: qa-ottobacias 12/12; unitários 2920/2920.
- Deploy Pages do b7a7adf ok; arquivos das ottobacias servidos (200).
  Pendente: rerodar qa-aspectos-fisicos quando o GeoPR estabilizar
  (curvas de nível sem resposta no fim da sessão).

---

## Sessão 2026-10-07 (noite): filtro de classes pela legenda + tooltip da hidrografia

### Filtro pela legenda (todas as camadas com classes)
- Núcleo (kit/layerHost/managerAdapter/manager): item da legenda com `key` vira
  botão; clique esconde/mostra a classe, Shift+clique mostra só ela (de novo,
  todas). `legendFilter: '<prop>'` (comparado como texto, combinado por "all"
  com o filter de cada layer) ou `onLegend(ocultos, ctx)` para desenho em
  imagem. Legenda de uma classe só segue informativa. Estado não persiste no
  link (YAGNI).
- 5 frentes em paralelo (workflow), cada uma com revisor adversarial:
  A fábrica de pontos (`__grupo`, ~25 camadas); B linhas fatiadas (estradas,
  distribuição, rodovias, conveniadas com chip e legenda num estado só);
  C índices (CAF, CAF PJ, fontes, conectividade, explorações ADAPAR, CAR com
  legenda nova); D GeoPR com modo (outorgas, licenciamento: where do export
  exclui a classe também das camadas de menor prioridade); E imagens
  (altimetria por paint, declividade por layerDefs no export, uso do solo
  repintado em blob, clima histórico e precipitação repintados, terremotos,
  FIRMS com helper único de filtro do rótulo).
- QA: `scripts/qa-legenda-filtro.mjs` (genérico: esconder tudo zera as
  feições, mostrar devolve, Shift deixa só a classe) 64/64 nas camadas que
  carregam sem login; qa-aspectos-fisicos cobre uso do solo e declividade.
  FIRMS não testado no navegador (feed fora no momento).

### Tooltip da hidrografia
- `src/maplibre/layers/hidrografiaTrechos.js`: zoom 12+, trechos da vista do
  FeatureServer (rede_otto 2020) numa linha invisível de hover com realce do
  trecho; nome do rio, Strahler, comprimento, área a montante, domínio,
  ottobacia.

### Pegadinhas
- O GeoPR alterna 500/503 nos MapServer (export e cache) em alguns momentos:
  falha de imagem no QA nessas horas é do servidor, não do código.
- Arquivos com CRLF na cópia de trabalho quebram edição exata; normalizar
  para LF antes (o repositório guarda LF).

---

## Sessão 2026-10-07 (tarde): termo de responsabilidade LGPD

- No login, depois da senha e antes do boot/tutorial, o usuário assina o termo
  (src/data/termoLgpd.js): texto versionado (TERMO_VERSAO), CPF validado (mod
  11), e-mail (pré-preenchido quando o login não é o sintético do SISATER) e
  aceite. Sessão salva também passa pelo termo; versão nova do texto pede nova
  assinatura. Recusar sai da conta.
- Registro JSON (texto completo + SHA-256, CPF, e-mail, matrícula, hora local
  e UTC, user agent) em `datageo-termos/<uid>/<versao>_<instante>.json`. Prova
  de hora: storage.objects.created_at (servidor). Flag `user_metadata.lgpd_termo`
  é só o gate da tela.
- Migration 047 do c2-parana (aplicada com db push em 2026-10-07): bucket
  privado `datageo-termos` (só JSON, 64 KB), política só de INSERT na pasta do
  próprio usuário com acesso DataGeo. Ninguém lê, lista ou sobrescreve; a
  consulta é pela service key. Não usar o `datageo-privado`: todo usuário
  DataGeo lê aquele bucket.
- Verificado com usuários temporários (apagados): própria pasta 200; pasta de
  outro, sem flag, anon, upsert, leitura, listagem e mime errado bloqueados.
  E2E com login real: termo antes do tutorial, validações, registro gravado,
  termo não volta ao recarregar.
- Pegadinha: Path.write_text do Python no Windows grava CRLF; o teste de CSS
  do cockpit usa regex com 
. Arquivos editados assim voltaram para LF.

---

## Sessão 2026-10-07: aspectos físicos, uso do solo em PNG e revisão

- Uso do solo vira PNG paleta de 30 m por município (Web Mercator, image
  source). O vetor recortado passava de 1,5 MB por município mesmo a 60 m
  (4,3 milhões de vértices em Ponta Grossa); em PNG o estado fica em ~20 MB.
  Legenda da camada lê os hectares do `aspectos-fisicos-pr.json` (fonte única
  com a ficha). Sem tooltip: raster não responde a queryRenderedFeatures.
- Revisão adversarial (workflow): hidrografia generalizada sem cache abaixo do
  z8 (agora export), caches de drenagem/curvas param no z14 (fonte com teto),
  make_valid em modo structure, explode duplo, altitude com máscara de nodata,
  Urbana/RIOS da ZEE na ficha, guardas de divisão por zero.
- O build completo foi morto por falta de memória na etapa do uso do solo
  (~15 GB lendo os 650 mil polígonos de uma vez). Reescrita para um município
  por vez com bbox no gpkg; testada em Ponta Grossa e Paranaguá.

### Declividade com o mesmo tooltip (área por polígono + contorno)
- `src/maplibre/layers/manchasRaster.js`: pixel/mancha/contorno saem da camada
  e viram a fábrica `manchasDoMunicipio`, usada pelo uso do solo e pela
  declividade.
- Declividade: o desenho segue ao vivo do GeoPR; um PNG da mesma ZEE recortada
  por município (`public/data/declividade/`, 8,6 MB, não aparece no mapa) diz a
  classe e a mancha sob o cursor. Polígono inteiro da ZEE não serve (o de
  0-10 % chega a 3,2 milhões de ha).
- Build: `py -3 scripts/build_aspectos_fisicos.py --so-declividade` refaz só os
  PNGs e grava `declBbox` no JSON existente.
- QA: qa-aspectos-fisicos 31/31.

### Área de cada polígono e contorno no hover (uso do solo)
- O navegador rotula as manchas do PNG (pixels vizinhos da mesma classe,
  inclusive na diagonal) uma vez por município: ~0,1 s no maior. A área de
  cada mancha soma os pixels com cos²(lat) por linha.
- Tooltip: "Área deste polígono ≈ X ha" + total da classe no município. O
  polígono é a mancha contínua em pixels de 30 m, recortada na divisa; não é o
  polígono original do IAT, que vem cortado por folha de carta.
- Contorno do polígono sob o cursor (amarelo com halo): arestas de borda
  emendadas em anéis e simplificadas (Douglas-Peucker, 1 px), em cache por
  mancha. Pior caso do estado: ~200 ms na primeira vez.
- Revisão adversarial: vizinhança 4 fazia rio em diagonal virar pixel solto
  (agora 8); contorno sem cache passava de 60 mil segmentos; clicar no próprio
  município reprocessava tudo (agora ignora a mesma seleção).
- QA: qa-aspectos-fisicos 29/29; unitários 2879.

### Tooltip do uso do solo
- Classe exata sob o cursor: um polígono invisível da divisa recebe o hover e a
  cor do pixel do PNG (paleta = USO_SOLO) diz a classe; o cartão traz a área da
  classe no município e a parcela.
- layerHost: tooltip vazio passa a vez ao próximo candidato, e a chave nova
  `hoverYield` faz uma camada ceder a qualquer camada normal sob o cursor
  (vence só as bases). Achado da revisão adversarial: sem isso, o alvo do uso
  do solo escondia UCs, TIs, CAR e grades de clima dentro do município.
- QA: qa-aspectos-fisicos 24/24 (inclui UC por cima mantendo o tooltip);
  qa-tooltips-todas sem falhas (28 PASS, privadas em SKIP sem login).

### Concluído (build completo)
- 399 municípios em `aspectos-fisicos-pr.json` (195 KB) e 399 PNGs de uso do
  solo (23 MB). Cobertura sobre a malha: uso e altitude 96-100%; declividade
  cai no litoral (64% em Paranaguá, a ZEE não classifica baía e ilhas), por
  isso o % de relevo forte da ficha é sobre a área classificada.
- 347.545 nascentes e 413.549 km de drenagem dentro da malha; altitude de 0 a 1.855 m.
- `node scripts/qa-aspectos-fisicos.mjs`: 21/21 (camadas GeoPR, altimetria, uso
  do solo seguindo a seleção e a troca de mapa base, ficha municipal e regional).

---

## Sessão 2026-10-06 (tarde): aba Aspectos físicos

### Feito
- Categoria nova **Aspectos físicos** no painel (manager.js, tour do index.html),
  seis camadas em `src/maplibre/layers/aspectosFisicos.js`, tokens de link `Fa`..`Ff`:
  - Altimetria: `color-relief` + hillshade sobre os tiles Terrarium (não há MDE
    estadual no GeoPR), em faixas de 200 m iguais às da ficha.
  - Declividade (`zee_declividade`, export), Hidrografia (rede otto 2020; a
    generalizada antes do zoom 9, cache de tiles), Nascentes FBDS (export, zoom 10+),
    Curvas de nível 10/20 m (cache de tiles, zoom 11+). Todas ao vivo do GeoPR.
  - Uso do solo IAT 2012-2016: só o município selecionado (evento
    `datageo:municipio-selecionado`), lendo `public/data/uso-solo/{ibge}.json`.
- Ficha municipal e regional: seções Relevo, Hidrografia e Uso do solo
  (`src/data/aspectosFisicos.js`, teste em `aspectosFisicos.test.mjs`).
- `scripts/build_aspectos_fisicos.py`: recorta pela malha do app MDE ALOS 12,5 m
  (lido a 25 m), declividade baixada do GeoPR (cache em data/cache), drenagem
  (PRHidro2.gpkg), nascentes e uso do solo (cópias locais em H:/IDR-PARANA/GEOPROCESSAMENTO).
- QA de navegador `scripts/qa-aspectos-fisicos.mjs`: partes do GeoPR e altimetria
  10/10; suíte unitária 2866/2866.

### Pendente (próxima sessão)
- **Rodar o build completo** (`py -3 scripts/build_aspectos_fisicos.py`, ~30 min)
  e commitar `public/data/aspectos-fisicos-pr.json` + `public/data/uso-solo/`.
  Sem esses arquivos a ficha omite as seções e a camada de uso do solo avisa que
  não há dado.
- **Tamanho do uso do solo**: a amostra deu 6,4 MB para 3 municípios (~2 MB cada);
  os 399 dariam centenas de MB. Antes de commitar: subir `USO_TOL_M`, cortar
  polígonos minúsculos ou passar para PMTiles/vector tiles.
- Rodar `node scripts/qa-aspectos-fisicos.mjs` depois do build (as 7 checagens de
  uso do solo e ficha dependem dos dados).
- Pegadinhas: o recorte na divisa gera GeometryCollection (o script explode e
  fica só com polígonos); `zee_declividade` tem classes extras (RIOS, Urbana)
  que ficam fora da legenda; o export do GeoPR para uso do solo leva ~20 s por tile.

---

## Sessão 2026-09-14 (madrugada): navios com ícone e tooltip; assentamentos e UCs

### Navios
- **Tooltip de hover** (`src/data/entityHoverTooltip.js`, genérico, opção
  `tooltip` no `createDatageoLayer`): mesmo desenho do tooltip dos municípios
  (pick com throttle de 40 ms, nada com câmera em movimento). HTML em
  `vesselTooltip.js`, com todo texto externo escapado: nome, berço, IMO, LOA,
  DWT, carga, sentido, operador, agência, atracação, previsão de término e
  andamento da operação (realizado/previsto); ao largo mostra chegada/ETA e o
  aviso de posição ilustrativa.
- **Ícone SVG de navio** (`vesselIcon.js`) no lugar dos pontos. Escala: até
  12 km de câmera o billboard é em METROS (LOA real do line-up, boca ≈ LOA/6,5),
  do tamanho do navio na imagem de satélite; acima disso, em PIXELS (12-22 px,
  leve proporção ao LOA), casando com o tamanho em metros na troca. Cada navio
  vira duas entidades (`id` e `id#m`); o factory ignora `#` na contagem de
  chegadas novas.
- **Rumo**: atracado fica paralelo ao cais/píer (c2-parana: `rumo` por berço em
  `berths.ts`); AIS usa `cog_deg`; fundeio sem rumo usa 45°.

### Assentamentos (Limites) e UCs federais/estaduais (Ambiente)
- `scripts/build_limites_ambientais.py`: INCRA `Assentamento Brasil_PR.zip`
  (certificacao.incra.gov.br, 311 projetos) e MMA/CNUC polígonos 2025-08
  (39 federais + 42 estaduais com UF Paraná; municipais fora). Simplificação
  + 5 casas + validação/reparo depois do arredondamento.
- Camadas `datageo-assentamentos` (token F), `datageo-ucs-federais` (G),
  `datageo-ucs-estaduais` (H) na factory de territórios, agora com categoria
  parametrizável; rótulos das UCs em título (`tituloUc`).
- Testes de integridade dos GeoJSONs (contagens, UF, esfera, coordenadas,
  acentos) em `limitesAmbientais.test.mjs`.

### Pegadinhas
- INCRA: o acervo pede login e `i3geo/geodados` dá 403, mas
  `certificacao.incra.gov.br/csv_shp/zip/Assentamento Brasil_<UF>.zip` segue
  público.
- CNUC: o DBF corta UTF-8 no meio de caractere acentuado. Ler como latin-1 e
  recodificar. No pandas 3 as colunas de texto são StringDtype: não filtrar
  por `dtype == object`, senão nada é recodificado e o filtro por "PARANÁ"
  devolve zero.
- O CNUC 2026-07 existe, mas num SharePoint; o último shapefile com download
  direto é o de 2025-08.
- Não nomear script Python como `inspect.py` (sombra o módulo da stdlib).

---

## Sessão 2026-09-13 (noite): camada de navios passa a usar o line-up da APPA

Sintoma: a camada marítima nunca mostrava navios. `maritime_traffic` tinha 52
linhas, a última de 2026-08-02.

### Diagnóstico (via `supabase db query` + modo dry run do etl-maritimo)
- Conta AISStream OK: bbox mundial deu 2.794 mensagens em 30 s.
- Bbox do Paraná: ~1 mensagem em 120 s. Falta cobertura de receptores AIS na
  costa do PR; as linhas antigas eram da costa de SP (lon −45).
- Bug extra na Edge Function (não afetava a produção, que roda o Python): a
  AISStream manda quadros binários e o `binaryType` padrão do Deno é `blob`;
  100% das mensagens viravam parse_error. Corrigido no c2 (`af2bb1b`).

### Solução
- **c2-parana `c0610a4`:** Edge Function `etl-lineup-appa` + migration 043
  (pg_cron `12,42 * * * *`). Lê o relatório público
  `appaweb.appa.pr.gov.br/...relLineUpRetroativo` (tabelas com rowspan; navio
  com vários operadores é agrupado pela programação) e grava
  `data_cache.appa_lineup_pr` (~37 KB): atracados com posição no berço,
  ao largo em área de fundeio, resumos de programados e próximos esperados.
- **Posições:** o relatório não tem coordenadas. Berços 201-219 distribuídos
  na face do cais comercial (OSM relation 7714317), 141-144 no píer de
  inflamáveis, 200/200A na FOSPAR, 113/114 na Ponta do Félix; fundeadouros
  pelos centróides das áreas `seamark:type=anchorage`. Navio ao largo é
  rotulado "posição ilustrativa".
- **DGP:** `src/data/portLineup.js` (puro, testado) + camada
  `datageo-maritimo` renomeada "Navios (Porto de Paranaguá)": atracados em
  âmbar no berço, ao largo em cinza; rótulos de 2 linhas só abaixo de 3,5 km,
  alternando acima/abaixo (berços a ~180 m). AIS de 24 h continua somando se
  a cobertura voltar. Payload com mais de 3 h não é desenhado.

### Resultado
- Primeiro run agendado (23:42 UTC): success, 16 atracados + 31 ao largo
  posicionados, nenhum berço sem coordenada. E2E local: 47 navios, pontos
  sobre os navios visíveis na imagem de satélite do cais.
- Testes DGP: 2739, mesmas 51 falhas pré-existentes.

### Pegadinhas
- `npx tsc` no c2 resolve para um shim que chama `deno`; usar
  `node node_modules/typescript/bin/tsc`.
- O deploy do front do c2 falha em "Unit tests" desde 2026-08-26
  (`tests/types/index.test.ts`, PLAN_FEATURES): nada do front do c2 publica
  até corrigir. Edge Functions não dependem disso (deploy via CLI).
- A emissão do line-up está em horário de Brasília (conferido contra o
  header `Date`).

---

## Sessão 2026-09-13 (tarde): ventos e precipitação param por cota da Open-Meteo

Sintoma: as duas camadas ficaram "INDISPONÍVEL · Open-Meteo HTTP 503".
Causa: a grade 22x15 custava 330 chamadas por carregamento e o plano gratuito
da Open-Meteo limita por IP (600/min, 5.000/h, 10.000/dia); na prática cada
coordenada conta como chamada (429 depois de ~660 pontos). As recargas dos
testes do dia estouraram a cota; IP compartilhado (rede do IDR) faria o mesmo.

- **Servidor (c2-parana `31d31fd`):** Edge Function `etl-meteo-grade` +
  migration 042 (pg_cron `2,32 * * * *`). Busca slots `minutely_15` (3 h) só
  quando a previsão guardada não cobre a próxima meia hora ou passou de
  110 min (~3.960 chamadas/dia) e grava o slot vigente em
  `data_cache.meteo_grade_pr` (~4 KB). Slot vigente == `current` da API
  (conferido ao vivo).
- **Cliente:** `fetchWeatherGrid` tenta, nesta ordem, grade fresca no
  localStorage (< 25 min), `meteo_grade_pr` (< 75 min), Open-Meteo direta
  (uma nova tentativa em 429/503) e, por fim, a última grade salva de até 6 h,
  rotulada "grade salva (API indisponível)". O painel mostra a hora do dado.

### Pegadinhas
- Supabase CLI e npx no PowerShell: a execution policy bloqueia `npx.ps1`;
  usar `npx.cmd`. `supabase login` não roda via `!` (sem TTY): fazer num
  terminal separado. `db push` continua com o usuário.
- `supabase secrets list` imprime hashes SHA-256, não os valores.
- O repo c2-parana acusa "dubious ownership" neste Windows: usar
  `git -c safe.directory=...` por comando em vez de mexer na config global.

---

## Sessão 2026-09-13: velocidade e features inspiradas no osiris

Origem: estudo do simplifaisoul/osiris (Next + MapLibre). Nada de código ou
stack copiado; só padrões (cache, lazy, polling, render em lote), mantendo a
identidade visual. Três fases, todas testadas.

- **Bundle:** plugin só de `vite build` troca os 10 módulos GEV que produção
  nunca registra por stubs em `src/prodStubs/`. Index 1.362 → 1.021 kB
  (gzip 422 → 306). Voz via import dinâmico em DEV; `preserveDrawingBuffer`
  só em DEV. `GEV_FULL_BUILD=1` desliga os stubs.
- **Rede:** `sourceCache.js` (TTL + voo único + stale-on-error) no
  `dgSelect`; focos em páginas paralelas (`fetchPool.js`) e com cache de 2 min;
  `pollPolicy.js`: poll pula aba oculta, backoff em erro, catch-up no
  `visibilitychange` (manager, ticker, briefing).
- **Dados estáticos:** `scripts/optimize_geojson.py` (simplificação ~5 m +
  5 casas decimais) 12,3 → 8,2 MB, mesmas feições, acentos ok.
  Ver `docs/OTIMIZACAO_GEOJSON.md`; rodar depois de qualquer `build_*.py`.
- **Render:** camadas DataGeo com diff por id (`entityDiff.js`); rodovias
  16 mil entidades → 2 `GroundPolylinePrimitive`; municípios e cobertura em
  `GroundPrimitive` com hover por atributo de instância; rótulos densos só
  com zoom (`LABEL_MAX_DISTANCE`).
- **Features:** vigilância de municípios (VIGIAR na ficha, focos/CEMADEN/
  incidentes novos, CSV/GeoJSON); briefing heurístico quando não há
  relatório do dia; "+N" e contorno ciano por 60 s em itens novos; atalhos
  L/B/P/M/A/? (F, R e V já eram do GEV).

### Resultado
- Testes 2631 → 2725, mesmas 51 falhas pré-existentes, nenhuma nova.
- Benchmark headless (swiftshader, 2 rodadas): 5 camadas pesadas ligam em
  2,2 s vs 2,7 s; frame p95 1,5 s vs 2,1 s; heap 370 vs 675 MB.
- Revisão independente: CSV aceitava DDE com "-1+", vigilância varria sem
  município vigiado; ambos corrigidos, mais 5 latentes.

### Pegadinhas
- A lista de stubs em `vite.config.js` precisa acompanhar
  `PROXY_DEPENDENT_LAYER_IDS` do `main.js`. Import novo de export nomeado de
  um desses módulos quebra o build até o stub exportar também.
- A aba do Chrome controlada por extensão fica `document.hidden`: o app
  suspende o render e o globo sai preto. Validar com puppeteer headless.
- Ligar só a conectividade custa ~0,4 s a mais no 1º frame (empacotamento do
  GroundPrimitive); o saldo com várias camadas é positivo.
- Cache de 60 s nas camadas pode segurar um refresh manual dentro da janela.
- O painel de vigilância fica atrás da ficha aberta (z-index).

---

## Sessão 2026-09-13: clima histórico BR-DWGD (camada + ficha)

Origem: revisão do awesome-gee-community-catalog; o BR-DWGD (Xavier et al.
2022, grade diária 0,1°, 1961–2022, CC BY 4.0) foi o dataset de maior encaixe
com o ecossistema. Contrato dos dados em `docs/CLIMA_BRDWGD.md`.

- `scripts/build_clima_brdwgd.py`: GEE → 3 JSONs em `public/data/` (resumo
  municipal, séries anuais, grade estadual). Normal **1990–2019** (Tmax/Tmin/ETo
  acabam em 2020-07). Sonda escala/offset dos assets antes de tudo e aborta se
  a média de jan/2000 cair fora da faixa física; confere Curitiba, Foz e Maringá
  contra climatologia conhecida antes de gravar.
- `src/data/datageoClimaHistorico.js` (token `E`): campo estático de 0,1°,
  retângulo texturizado a 60 m (abaixo de precipitação 90 m e ventos 120 m),
  seis chips de indicador (CHUVA, TEMP, GEADA, BALANÇO, CALOR, ΔT/DÉC).
  Escala cividis (`climaHistoricoRamp.js`), fora das famílias ciano, violeta,
  verde e fogo; quebras por quantil vêm do JSON.
- Ficha municipal: seção "Clima histórico · BR-DWGD" (normal, balanço, geada,
  calor, barras mensais chuva × ETo, tendência e série de Tméd). Carga em
  paralelo com o Supabase, nunca derruba a ficha.
- Hub `datageoparana.github.io`: referência 18 em `referencias.html`.

### Resultado (gerado e verificado em 2026-09-13)
- `EE_PROJECT=i-freedom-358120`. JSONs: 198 KB + 381 KB + 151 KB. 8/8 testes.
- Conferência: Curitiba 1.555 mm/ano, Tméd 18,7 °C, geada 5,3 d/ano,
  +0,30 °C/década (sig.); Foz 1.815 mm, 22,5 °C; Maringá 1.607 mm, 23,4 °C.
- Browser (:4176): campo alinhado às divisas; chuva máxima no sudoeste/
  Guarapuava, geada máxima no Centro-Sul; token `E` no share link; ficha de
  Curitiba com a seção entre "Clima local" e "Hidrologia".

### Pegadinhas
- **Os assets do BR-DWGD no GEE estão EMPACOTADOS** (banda `b1`, int16):
  chuva bruta de jan/2000 = −32.004. Valor = bruto × escala + offset do
  catálogo. A sonda do script decide sozinha; não remover.
- (Tmax+Tmin)/2 fica ~0,5–1 °C acima da média compensada do INMET: a primeira
  faixa de conferência (Curitiba ≤ 18,5 °C) barrou um dado correto.
- `sampleRectangle` com `defaultValue` exige tipo único: `toFloat()` antes.
- Cache das agregações municipais em `.gev-cache/brdwgd/` (gitignored):
  apagar para recalcular.
- `layerState.test.mjs` já falhava antes desta sessão: espera 16 ids no
  registro e há 40 (agora 41).

---

## Sessão 2026-09-11: municípios como piso, busca por município, precipitação, VBP/ha e conectividade

Quatro entregas, todas commitadas e no ar (`19c208d` → `1d4c263` → `61cdbbe` →
`355a878`). Cada uma revelou defeito real; o que quebrou está em Pegadinhas.

### 1. Municípios sempre ativos + busca por município (commit `19c208d`)
- **Piso de camadas** (`BASELINE_LAYER_IDS` em layerState.js): não existia
  mecanismo de "camada padrão ligada" — num boot limpo `start()` retornava
  cedo e NENHUMA camada subia. O piso é aplicado uma vez em `start()`, e
  deliberadamente NÃO dentro de `normalizeLayerState`: o estado durável
  precisa continuar capaz de dizer "desligada", senão o toggle mentiria no
  localStorage e no share link. Só o próximo boot religa.
- `_restoreBaselineLayers()` é estreito de propósito: liga só o piso, sem
  tocar em nenhuma outra camada nem empurrar params, preservando o contrato
  de que num boot limpo os inicializadores dos módulos são a verdade (o
  invariante do `models3d`).
- **Busca local dos 399** (`src/municipioSearch.js`, módulo puro): resolve o
  nome contra `prCentroids` ANTES do geocoder. O código IBGE que ela devolve
  é o que abre a ficha — o geocoder devolvia ponto sem identidade e por isso
  nunca conseguiu abrir a aba certa. Tolerante a acento, caixa, conectivo
  ("sao jorge do oeste" acha "São Jorge d'Oeste") e sufixo de UF.
- Escolher um município enquadra a câmera na **divisa real** do polígono
  (BoundingSphere unida por CD_MUN, então ilha de Paranaguá entra no
  enquadramento) e abre a ficha.

### 2. Camada de precipitação irmã da de ventos (commit `1d4c263`)
- As duas leem a MESMA grade Open-Meteo 22x15 na MESMA requisição: a lista
  `current=` já aceitava `precipitation` junto com vento. `fetchWindGrid`
  virou `fetchWeatherGrid` com a PROMESSA memoizada (TTL 25 min contra
  updateInterval de 30), o que resolve cache e dedup de concorrentes de uma
  vez. Medido em browser: 3 requisições com as duas ligadas, não 6.
- Render: retângulo comum a altura fixa (90 m) com textura de canvas, ABAIXO
  das partículas de vento (120 m); há teste travando essa relação porque as
  duas constantes moram em arquivos diferentes.
- Escala violeta→fúcsia que PARA em `#e879f9`. Violetas claros colapsam
  contra o ciano do vento sob protanopia/deuteranopia (ΔE 3-4), justamente
  no topo da escala. A magnitude acima do meio é carregada pelo ALPHA, não
  pelo brilho. O teto também evita o `#c084fc` dos quilombolas.

### 3. VBP por hectare na ficha (commit `61cdbbe`)
- Denominador = **área total do município** (IBGE agregado 4714, variável
  6318, Censo 2022), decisão do Avner e correta: metade do VBP do PR vem de
  criações que não declaram área NENHUMA (avicultura R$ 52 bi,
  bovinocultura R$ 32 bi, suinocultura R$ 14 bi). Só 47% do VBP tem área.
- Consequência registrada em teste: área é fixa entre 24 e 25, então a
  variação do R$/ha é IGUAL à do valor. Os dois +14,2% lado a lado não são
  bug — o que o indicador acrescenta é o NÍVEL (Curitiba R$ 297/ha,
  agrícolas intensivos > R$ 50 mil/ha).

### 4. Camada de Conectividade (commit `355a878`)
- 5.803 ERBs por geração mais alta (5G 816 · 4G 4.5K · 3G 407 · 2G 94) +
  o NEGATIVO da cobertura: 132.692 km² sem 3G+, 67% do estado.
- `scripts/build_conectividade.py` converte o acervo do IDR
  (`H:\IDR-PARANA\renovaPR\Conectividade`). Simplificação roda ANTES da
  reprojeção para a tolerância estar em metros; 600 m leva 7,3 MB → 2,6 MB
  mexendo +1,3% na área, e fragmentos < 0,5 km² saem.
- A DATA do levantamento vai na linha do painel ("levantamento 2024-01"),
  com teste travando o campo nos dois arquivos.

### Pegadinhas descobertas (economizam horas na próxima sessão)
- **`overflow` recorta dropdown que abre para CIMA**: `#command-dock
  .location-city-row` tinha `overflow: hidden`, e a lista de sugestões era
  montada, marcada visible, respondia às setas — e não pintava um pixel,
  com o clique atravessando para o globo. **`overflow-x: clip` NÃO resolve**:
  medido em Chrome real a 1440 e 390 px, a lista continua fora do hit-test.
  Só `overflow: visible`. Achado por revisão adversarial, não pelo meu
  smoke test — que passou porque eu dirigia o DOM por script em vez de
  clicar de verdade.
- **Popover do dock nasce fora da borda esquerda em tela estreita** (a 390 px
  a `.location-city-row` começa em x=-36), então qualquer coisa ancorada
  nela herda o deslocamento. A lista agora é presa ao viewport ao abrir.
- **Imagery layer está MORTA no stack photoreal**: `globe.show = false` e o
  `Globe.render()` do Cesium retorna cedo, então `imageryLayers` não desenha
  nada. Retângulo texturizado grudado no terreno também não serve: o próprio
  Cesium desaconselha e degrada EM SILÊNCIO para cor chapada sem a extensão
  WebGL. Retângulo comum a altura fixa é o caminho sem armadilha.
- **Partículas de vento não renderizam em automação**: nem headless com
  SwiftShader, nem aba em segundo plano com `viewer.render()` forçado (o
  rAF estrangulado dá dt≈0 e a advecção não anda). Elas somem MESMO com a
  precipitação desligada, então some ≠ oclusão. O par vento+chuva continua
  sem conferência visual.
- **API do IBGE responde gzip sem pedir** e o `urllib` não desempacota:
  `json.loads` morre com "can't decode byte 0x8b". `fetch()` do gerador
  agora trata Content-Encoding.
- **Falha do TSE APAGAVA o prefeito**, em silêncio: o gerador só acrescenta
  quem responde. Agora o JSON anterior preenche as lacunas. Já valeu nesta
  rodada (um 404, zero prefeitos perdidos).
- **Caminho fixo em `C:`**: o `GH` do build_municipios_info apontava para
  `C:/Users/avner/...` e o checkout vive em `E:`. Agora é derivado da posição
  do próprio arquivo.
- **Área com valor ZERO na base do VBP**: "Pastagens E Forragens" (4,2 mi ha)
  e "MATA NATIVA" (3,1 mi ha) são inventário de uso do solo, não produção.
  Entram no denominador se você somar `ar` sem filtrar por `v > 0`.
- **First-run launcher tapa o dock** numa sessão virgem: em automação,
  `localStorage['gev:first-run-mission:v1'] = 'suppressed'` ANTES do boot
  (`evaluateOnNewDocument`), senão `elementFromPoint` devolve o `<aside>`.
- **Git não está no PATH** desta máquina; o binário utilizável é o do
  GitHub Desktop (`...\GitHubDesktop\app-*\resources\app\git\cmd\git.exe`).
  Não havia `user.name`/`user.email` — foram gravados com `--local`.
- **Interceptação de request no puppeteer precisa devolver CORS**: a resposta
  sintética sem `Access-Control-Allow-Origin` é bloqueada, e o sintoma
  ("Failed to fetch") parece bug do produto.

### Estado ao fim da sessão
- 4 commits, todos com push para `origin/main`. Testes: 2623, 2572 passando.
  As 51 falhas são as MESMAS de antes da sessão (baseline 2587/2536/51) —
  nenhuma nova. Build limpo.
- Tokens de share link usados nesta sessão: `C` (precipitação), `D`
  (conectividade). Livres a partir de `E`.
- **Pendências**: (a) conferir vento + precipitação juntos na tela;
  (b) `particleHeight: 120` do vento é altura absoluta com teste de
  profundidade e o relevo do PR chega a 1877 m — no keyless/Esri o terreno é
  plano e não aparece, com tiles 3D o vento provavelmente está enterrado;
  (c) dado ANATEL mais novo que 2024-01 (dados.gov.br exige chave, Mosaico é
  UI em JS, caminhos de dados abertos dão 404); (d) `.pyc` commitado por
  engano em `scripts/__pycache__/build_energia.cpython-312.pyc`;
  (e) `layerState.test.mjs:158` afirma 16 camadas e o fork tem 39 — corrigir
  expõe a asserção de ordenação logo abaixo, que mudaria a ordem canônica
  dos tokens; (f) `docs/CURRENT-STATE.md` segue 100% upstream, sem DataGeo.

---

## Sessão "gev" (continuação) — 2026-08-26: usinas, TIs e quilombolas

- **Usinas de energia (token 0, Infraestrutura)**: SIGEL/ANEEL do projeto
  energy — 62 UHE + 323 PCH + 239 CGH + 222 UTE + 22 EOL + 3 UFV + 106
  aerogeradores individuais (977 pontos, 145 KB). Cor por fonte, tamanho
  por potência; UHE ≥500 MW tem label na visão estadual (a cascata do
  Iguaçu — Foz do Areia 1.676 MW, Salto Santiago 1.420, Segredo 1.268 —
  conta a história sozinha). Aerogeradores só aparecem < 60 km.
- **Terras indígenas (token A, Limites)**: FUNAI/CMR via seed
  restricted_areas do valor-de-terras (regex sobre WKT + shapely), 57
  polígonos com etapa e hectares, laranja com fill 0.25 + borda por anel.
  Pegadinha: o nome da FUNAI já vem com prefixo "TI " — checar antes de
  prefixar ("TI TI Marrecas" no primeiro screenshot).
- **Territórios quilombolas (token B, Limites)**: o INCRA passou a exigir
  LOGIN no acervo de certificação (o export_shp.py devolve a tela de
  login) — a fonte virou a malha OFICIAL do Censo 2022 do IBGE
  (ftp.ibge.gov.br/.../Quilombolas_Primeiros_resultados_do_universo/
  Arquivos_geoespaciais_vetoriais_2a_apuracao_20231222/BR_TQ_*.zip,
  colunas sg_uf/nom_tq/status). 10 territórios no PR com fase
  (PORTARIA/RTID/DECRETO), roxo. geopandas via zip://...!caminho/arquivo.shp
  (o zip tem subpasta; sem o fragmento o pyogrio não acha o .shp).
- **Espaço de tokens estendido a A-Z**: os 36 [a-z0-9] esgotaram (35 em
  uso + '0'). Encode/decode do hash preservam case de ponta a ponta
  (join/split '.' + Map por token), então maiúscula é segura. Dois testes
  usavam 'z' como "token desconhecido" e quebraram quando o 'z' foi
  atribuído na Fase 2 (falha pré-existente) — migrados para 'Z' e
  voltaram a passar.

## Sessão "gev" (continuação) — 2026-08-26: transmissão de energia (EPE)

- **Linhas de transmissão (token 8)** e **Subestações (token 9)** na
  classe Infraestrutura, segundo saque do backlog §8 (raw EPE do projeto
  energy local, normalizado por `scripts/build_energia.py`):
  - LTs: 248 em operação + **49 planejadas 2025-2037** (731 KB). Cor por
    tensão — 525 kV violeta (o corredor de Itaipu salta), 230 kV azul,
    demais cinza; planejadas TRACEJADAS em âmbar
    (PolylineDashMaterialProperty funciona em polyline clamped).
  - SEs: 83 + 10 planejadas (16 KB), via `makePointsLayer` (agora
    exportada de datageoLogistica.js com `category` parametrizável);
    planejadas maiores, âmbar, com ano previsto no label.
- Encoding: os raw EPE têm acentos corretos (0xE1 = á em "SE Andirá
  Leste"); o `�` no console é só o Git Bash — checar bytes antes de
  "consertar" encoding que não está quebrado.

## Sessão "gev" (continuação) — 2026-08-26: classe "Logística agro"

- **Conjunto novo de camadas** (classe própria no painel, após
  Infraestrutura), primeiro aproveitamento do backlog §8 do PLANO_FUSAO:
  - **Armazéns (CONAB)** — token 5: cadastro CDA/CONAB 2023-11 extraído do
    seed SQL do projeto valor-de-terras (2.458 pontos + porto de
    Paranaguá), 537 KB. Tamanho do ponto proporcional à capacidade
    (≥50 mil t salta na visão regional); label com nome + capacidade
    aparece a < 45 km.
  - **Agroindústrias** — token 6: SIGSIF/MAPA (9 frigoríficos vermelho,
    92 laticínios azul-claro, geocode por centroide municipal) + 28
    serrarias OSM (marrom), 22 KB.
  - **CEASAs** — token 7: 5 unidades da CEASA/PR com label sempre visível.
    Overpass não tem as unidades nomeadas ("ceasa" retornou <3 hits na
    área do PR) — coords hardcoded no build_logistica.py.
- `scripts/build_logistica.py` parseia os INSERTs dos seeds
  (st_makepoint com regex + split ciente de aspas) — o caminho previsto
  no §8 ("extrair INSERTs → JSON") funcionou como planejado.
- `datageoLogistica.js`: factory de pontos estáticos clamped
  (contrato earthquakes: zero CallbackProperty), scaleByDistance,
  distanceDisplayCondition nos labels.

## Sessão "gev" (continuação) — 2026-08-26: Tráfego aéreo ao vivo em produção

- **Causa raiz do feed morto**: airplanes.live respondeu 403 "contact us" a
  partir de 2026-08-12 e o etl-aviacao do c2 parou de gravar. Fonte trocada
  para **adsb.lol** (mesma API v2/readsb, aberta por política, parser
  intacto) — commit 0a78778 no c2, função redeployada, tabela voltou a
  receber snapshots por minuto no mesmo dia.
- **Camada "Tráfego aéreo" (ex Live Flights) em produção, classe
  Infraestrutura**: `_fetchStatesPayload` em flights.js — dev/testes seguem
  no proxy OpenSky; o build de produção lê `aviation_traffic` do Supabase
  (janela 5 min, dedupe por icao24) convertida client-side para o shape
  `/states/all` num Response sintético, então TODO o pipeline GEV
  (billboards, trilha, dead-reckoning, click-to-track) funciona sem tocar.
  ~44 aeronaves no PR em teste.
- Pegadinhas:
  - A string "adsb.lol" no rótulo da fonte dispara a heurística de
    FALLBACK do manager (era a fonte reserva do GEV) — rótulo virou
    "DataGeo PR · etl-aviacao" e o estado lê ATIVA.
  - `import.meta.env` NÃO existe sob node:test: acesso direto crashava o
    LOAD de todo teste que importa datageoClient (flights, firms, voice,
    sprites — falhavam como arquivo desde a ponte de fires). `?.` +
    `DEV !== false` destravou; 6 arquivos voltaram a rodar e expuseram 7
    falhas latentes do FIRMS (pré-existentes, não desta feature).
  - "Aviões parados" na visão estadual é escala, não bug: 240 m/s ≈ 1 px
    a cada ~5 s com o estado inteiro na tela; em zoom próximo o
    dead-reckoning desliza entre os snapshots de 1 min (verificado com
    capturas em T e T+12 s).

## Sessão "gev" (continuação) — 2026-08-26: rodovias em 3 níveis + painel por classes

- **Camada Rodovias (token 4)** em três níveis:
  - Federais (BR-xxx, âmbar) e estaduais (PR/PRC-xxx, azul) estáticas:
    `scripts/build_rodovias.py` consulta o Overpass pela área do PR
    (relation 297640), arredonda a 5 casas e decima vértices — 6,2 MB,
    16,4k trechos, 38 BRs + 268 PRs.
  - **Municipais só com zoom no município** (< 90 km de altura):
    secondary/tertiary/unclassified SEM ref BR/PR, buscadas AO VIVO no
    Overpass por células de 0,25° cacheadas, somem ao afastar o zoom.
    Pegadinha: fan-out paralelo leva 429 do overpass-api.de (limite ~2
    conexões) — a busca é uma FILA SERIAL com 700 ms de respiro e rotação
    de espelho para overpass.kumi.systems em erro. Verificado: 420 vias
    carregadas sobre Guarapuava, show=false ao subir para 500 km.
- **Painel de camadas por classes** (Limites, Infraestrutura, Clima,
  Hidrologia, Ambiente, Saúde e ar, Riscos e alertas, Contexto global):
  módulo declara `category`, `getAll()` expõe, `_renderToggles` agrupa com
  headers estáticos (o refresh só reescreve rows, headers ficam). Fallback
  "Contexto global" para as camadas GEV herdadas. As factories
  (`createDatageoLayer`, `createFirmsHeatmapLayer`) precisaram repassar o
  campo — config com category sem repasse morre em silêncio.
- Teste `cockpitMarkup` pinava a linha literal `if (!layer.showInTogglePanel)
  continue;` do manager — regex atualizada para o novo filter.

## Sessão "gev" (continuação) — 2026-08-26: ficha municipal, UI pt-BR e mobile

- **Ficha municipal ao clique** (`src/datageoFicha.js` + LEFT_CLICK em
  `datageoMunicipios.js`): painel lateral (quase-modal, z=120) com seções
  extensíveis — Economia SEAB (VBP 24→25 + **top-3 produtos** com barras e
  R$), População IBGE (estimativa 2025 + nascidos/óbitos 2024 + saldo
  vegetativo), Segurança SINESP (vítimas 2022 vs 2021 + taxa/100k, com o
  aviso de que a série municipal para em 2022), IRTC com barras por
  domínio, Dengue (série 8 SE + projeção), focos 7/30d, clima, hidro,
  ar, incidentes e notícias. `fetchMunicipioFicha` faz Promise.allSettled
  em 11 fontes Supabase; o resto vem do `municipios-info.json` local.
- **Gerador agrega o ecossistema DataGeo** (o que não está no c2):
  `saude-parana` (populacao_anos/nascidos/obitos, SIDRA D1C/V/D3N) e
  `seguranca-parana` (criminalidade SINESP 2018-2022, soma de vítimas por
  município/ano). 209 KB, cobertura 399/399 em produtos+pop+segurança.
- **UI 100% pt-BR** (pedido: vai para o secretário da agricultura):
  painéis (CAMADAS DE DADOS, CENAS, TELA, MAPA BASE, ESTILOS VISUAIS,
  LOCALIZAÇÃO), estados das camadas (ATIVA/DESLIGADA/CARREGANDO/
  DESATUALIZADA/INDISPONÍVEL...), meta-linhas ("há 2 min", "nova tentativa
  em 30s"), HUD — o "TOP SECRET // SI-TK // NOFORN" fake virou
  "DADOS PÚBLICOS // DATAGEO PR" (mandar classificação falsa para um
  secretário de Estado seria um tiro no pé). Nomes de camadas em pt claro
  (Terremotos, Barragens, Cabos submarinos, Focos de calor (queimadas),
  Nível dos rios, Alertas de desastre...).
- **LOCALIZAÇÃO agora é o Paraná**: Austin/SF/NYC/Tóquio/Londres/Paris/
  Dubai/DC substituídas por Curitiba, Londrina, Maringá, Cascavel, Foz
  (Cataratas/Itaipu/Marco/Ponte), Ponta Grossa (Vila Velha), Guarapuava e
  Paranaguá (porto/Ilha do Mel). Nada referencia as chaves antigas fora de
  testes de voz (dev-only) — 12 testes de voz/cockpit derivaram por citar
  Austin; deriva intencional, documentada aqui.
- **Passe mobile** (screenshot do Android mostrou o estrago): dock sem a
  coluna de voz via `:has()`, ficha em tela quase cheia, painéis da
  esquerda na largura útil, HUD/TELA/CENAS ocultos ≤700px, alvos de toque
  maiores, tooltip municipal desativado em `pointer: coarse` (sem hover em
  touch; o clique abre a ficha).
- **Produção sem cadáveres**: `main.js` remove os painéis CCTV/contexto/
  rádio do DOM e não inicializa a voz (dock "VOICE STANDBY" morto que
  aparecia no celular) fora do dev.
- Testes: rótulos atualizados em manager/traffic/panelStack/mapStackChips/
  locationStatus; suíte sem falhas NOVAS além da deriva de voz acima
  (baseline já tinha dezenas de falhas próprias do fork; 4 do chip esri
  seguem).
- **Inventário de assets** (agente varreu 6 projetos: valor-de-terras,
  3d-land-cover, ndvi/no2-parana, pr-temp, energy) — backlog em
  PLANO_FUSAO.md §7.

## Sessão "gev" (continuação) — 2026-08-26: ventos, VBP 24→25 e bordas

- **`datageo-ventos` (token 3)**: partículas estilo earth.nullschool via
  `cesium-wind-layer` (GPU, 4.096 partículas) alimentada por grade 22×15 do
  **Open-Meteo** (gratuito, sem chave — funciona no deploy estático).
  u/v da direção meteorológica; flipY false com linha 0 = sul. A camada
  segura `holdContinuousRender` enquanto ligada (partícula anima todo
  frame) e libera no disable. No preset Agroambiental.
- **VBP do tooltip agora 24→25 (SEAB/DERAL)**: o gerador trocou a PAM/IBGE
  pela base local do projeto vbp-parana do Avner
  (dashboard/public/data/detailed_municipio_*.json, R$ correntes) — mesma
  fonte do avnergomes.github.io/vbp-parana. Bônus: "cadeia líder" agora usa
  as 26 cadeias SEAB (inclui pecuária) — Toledo virou Suinocultura (antes a
  PAM cegava para pecuária e dizia soja), Curitiba Olericultura.
- **Bordas municipais permanentes**: polyline clamped por anel externo
  (399), cyan 0.32 — contorno "queimado" no satélite o tempo todo; o hover
  ignora o pick da divisa para o tooltip não piscar.
- Painel reordenado (DataGeo primeiro) e, em produção, só camadas com
  backend vivo (proxy-dependentes do GEV ficam fora do build estático).
- Pegadinha nova: heredoc do Git Bash come backslashes em scripts Python
  inline — usar forward slashes em paths Windows.

## Sessão "gev" (continuação) — 2026-08-26: marítimo, ferrovias e a verdade sobre trânsito/CCTV

- **`datageo-maritimo` (token 1)**: lê `maritime_traffic` com janela ESTRITA
  de 24 h — mostra 0 hoje porque a conta AISStream segue cortada (health de
  hoje: total_vessels 0; tabela parada em 2026-08-02 com 52 linhas). Plotar
  navio velho como posição atual seria desinformação. Reativação = conta
  nova em aisstream.io → `supabase secrets set AISSTREAM_API_KEY` →
  reagendar o cron do etl-maritimo (ação do usuário; a camada acorda
  sozinha).
- **`datageo-ferrovias` (token 2)**: malha ferroviária via Overpass/OSM
  (railway=rail, 1.819 trechos, 1,1 MB em public/data/ferrovias-pr.geojson),
  clamped, no preset Agroambiental. CONTEXTO, não fluxo: não existe posição
  de trem pública no Brasil (Rumo não expõe GPS).
- **Trânsito**: fluxo ao vivo tokenless para o PR NÃO existe. EPR Paraná tem
  mapa "tempo real" (obras/acidentes/interdições) sem API pública; rota real
  é TomTom BYOK via Edge Function (Fase 3) ou parceria Waze CCP (nota: órgão
  público pode pleitear). Nada fingido com simulação.
- **CCTV**: o pack do GEV (Austin/TfL/Caltrans) depende de open data de
  câmeras com CORS — não existe equivalente no PR. URBS tem CCO/câmeras mas
  sem catálogo público acessível (site 403 para fetch externo; streams
  municipais sem CORS não embedam client-side). Camada CCTV segue sem fonte
  PR; candidata a ocultar do painel em produção (item Fase 3).
- Tokens a-z esgotaram; validador aceita [a-z0-9] — passamos aos dígitos.

## Sessão "gev" (continuação) — 2026-08-26: tooltip municipal

- **Camada `datageo-municipios` (token v)**: 399 polígonos do
  municipios-pr.geojson (207 KB, clamped) com hover → highlight + tooltip
  DOM: prefeito atual (partido), variação do VBP de lavouras entre os dois
  últimos anos da PAM e lavoura líder. Incluída nos 3 presets de missão.
- **Dataset `public/data/municipios-info.json`** (73 KB) gerado por
  `scripts/build_municipios_info.py`: prefeitos dos resultados OFICIAIS do
  TSE 2024 (JSONs de resultados.tse.jus.br — o CDN de dados abertos
  bloqueia curl/urllib com 403; a rota de resultados não), 1º e 2º turno;
  VBP e lavoura líder do SIDRA t5457 v215 (2023→2024 — PAM 2025 ainda não
  existe; o tooltip rotula o biênio real). 398/399 prefeitos — São Tomé
  (4126108) deu 404 no TSE (provável pleito anulado/suplementar), tooltip
  mostra "—".
- Nota SIDRA: na t5457, v214 é QUANTIDADE (t) e **v215 é o valor da
  produção** — o etl_agro do c2 usa v214 como VBP (bug latente anotado).
- Verificado com hover real: Prudentópolis → Adelmo (PSD), VBP ▼ -17,3%,
  Soja (em grão).
- **Fix do seletor de basemaps**: o tray usava a allowlist original do GEV
  (Google/Bing/OSM) — o `esri` não aparecia e, ao escolher OSM, não havia
  volta. Agora `esri` está na lista e o tray renderiza SÓ os stacks
  disponíveis (keyless = SAT + OSM; com chaves, Google/Bing reaparecem).

## Sessão "gev" (continuação) — 2026-08-26: publicação

- **Org GitHub `DGP-comando` criada** (via browser — criação de org não tem
  API pública; form preenchido com a conta do Avner, plano Free).
- **Repo `DGP-comando/dgp-comando.github.io`** criado via gh CLI; main
  pushado (histórico completo da fusão).
- **GitHub Pages no ar: https://dgp-comando.github.io/** com o workflow
  `.github/workflows/deploy-pages.yml` (Node 26, npm ci + vite build +
  actions/deploy-pages).
- Pegadinha de Pages em repo `<org>.github.io`: o Pages se auto-ativa em
  modo BRANCH (Jekyll) e o build automático serve o fonte cru por cima do
  artifact do workflow (`Failed to resolve module specifier "cesium"` foi o
  sintoma — o HTML publicado era o `/src/main.js` fonte). Fix:
  `gh api repos/.../pages -X PUT -f build_type=workflow` + re-dispatch.

## Sessão "gev" — 2026-08-25 → 2026-08-26

A sessão que criou este repo. Arco completo, do estudo ao produto:

### 1. Estudo do God's Eye View (2026-08-25)
- Repo `bilawalsidhu/gods-eye-view` (MIT, 3.7k stars) estudado: globo
  CesiumJS + 13 camadas live + HUD tático + voz. Clone completo estoura
  timeout (~80 MB de GIFs em docs/media); usar `--filter=blob:none` +
  sparse-checkout sem `docs/media`.
- Conclusão do estudo: o GEV é a "sala de comando" que o pivô C4ISR do
  c2-parana abandonou; o c2 tem o backend que o GEV não tem. Fusão óbvia.

### 2. Ponte piloto no fork (`gods-eye-view` local)
- Plugin `datageoFiresProxy` no vite.config.js servindo `fire_spots` do
  Supabase no contrato de `/api/firms` — 368 focos renderizados no heatmap
  FIRMS sem tocar o cliente. Janela de 48 h (cadência do cron é 12 h).
- Boot keyless: chave Google placeholder → fallback globo Cesium + OSM
  (comportamento já previsto em main.js).
- Stack `esri` criado (Esri World Imagery + labels de referência, receita
  tokenless do webgis Serra do Mar) e promovido a fallback keyless default.
- Dev hooks: `__gevViewer`, `__gevDataManager`, `__gevMapStack`.

### 3. Contexto paralelo: cutover do c2 (registrado no repo do c2)
- A migração Actions→Supabase do c2 foi concluída na mesma sessão: 13 Edge
  Functions deployadas + migrations 039-041 (pg_cron). Relevante aqui porque
  ESTE repo consome esses pipelines — inclusive o cache
  `infohidro_estacoes_pr` que a nova `scrape-infohidro` gravou às 06:33.

### 4. Fusão — Fase 1 (repo criado, commit 81c70af)
- Decisão arquitetural verificada antes de codar: as 12 tabelas do c2 têm
  RLS anon-read ⇒ leitura direto do browser, sem proxy ⇒ deployável estático.
- `datageoClient.js`, `prCentroids.js` (399 municípios por IBGE), 5 camadas
  (clima/rios/cemaden/irtc/dengue), fires client-side, `flyToParana`,
  `dynamicAtmosphereLighting=false` (o dia/noite apagava o satélite à
  noite), branding Sala de Situação.
- Verificação em browser: clima 12 · rios 8 · cemaden 0 (válido) · IRTC 399
  · dengue 399 · focos 368, zero erros.

### 5. Fusão — Fase 2 (commit 8cec1ed)
- 4 camadas novas: ar (AQICN, 12), anomalias (z-score 7 d, âncora por nome,
  12 reais no teste), incidentes (0, tabela vazia), infohidro (1.312
  estações). Tokens y/p/o/l nos share links.
- `datageoTicker.js` (notícias no rodapé) e `datageoBriefing.js` (relatório
  situacional diário, card colapsável).
- Presets de missão no first-run: Defesa Civil / Epidemiológico /
  Agroambiental. Testado com clique real: preset ligou 4 camadas e o share
  link serializou `l=w.k.h.n`.
- Build estático validado (`vite build` + `preview` :4175, zero erros).

### 6. Mapa das 26 páginas do c2 (commit da seção 5b do plano)
- Cada página do console React ganhou destino explícito: absorvida pelo
  globo, feature da Fase 3, ou permanece no console (auth/billing/CRUD).
  Ver `PLANO_FUSAO.md` §5b.

### Pegadinhas descobertas (economizam horas na próxima sessão)
- **Vite no Windows**: `--host localhost` binda só em IPv6 `[::1]` e o
  Chrome não conecta; usar `--host 127.0.0.1`.
- **Aba em background**: o GEV suspende o render loop (`visibilitychange`) —
  tela preta e fila de tiles travada. Em automação, sobrescrever
  `document.hidden` e religar `useDefaultRenderLoop`. Screenshots borrados
  em background NÃO são bug do produto.
- **Estado persistido**: localStorage + sessionStorage reidratam
  `map=osm`/dismissals de sessões velhas; teste limpo exige limpar os dois e
  recarregar sem hash.
- **flyTo do boot** sobrescreve `setView` feito durante o voo; usar
  `camera.cancelFlight()` antes.
- **IRTC**: "médio" cobre quase o estado — label/outline só em alto/crítico,
  senão são 300+ labels de ruído.
- **`fire_spots` sem `frp`**: cards mostram "0.0 MW" até o ETL do c2 gravar
  o campo (fix conhecido, 1 coluna + 1 linha no ETL).
- **Anon key**: a válida vem do bundle publicado do console
  (`avnergomes.github.io/c2-parana`); a do `.env.local` do c2 está
  rotacionada.

### Estado ao fim da sessão
- Commits: `81c70af` (Fase 1) → `8cec1ed` (Fase 2) → docs §5b. Sem remoto.
- Dev: `npm run dev -- --host 127.0.0.1 --port 4174`.
- Próximo (Fase 3): card de clique no município (ReconhecimentoPage no
  globo), KPIs agro no HUD, auth compartilhada, deep links para o console,
  publicação do `dist/` (aguarda decisão de hospedagem/domínio).
