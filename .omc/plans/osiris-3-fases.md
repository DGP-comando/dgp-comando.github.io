# Plano: aprendizados do osiris aplicados ao DGP Comando (3 fases)

Data: 2026-09-13. Origem: estudo de simplifaisoul/osiris (Next + MapLibre).
Restrição: não alterar a identidade visual; só padrões (cache, lazy, polling, render).

## Linha de base (antes)
- Build: `dist/assets/index-*.js` 1.362 kB (421,9 kB gzip); build 2,3 s.
- Testes: 2631 total, 2577 pass, 51 fail (pré-existentes; lista em scratchpad/test_base.log).
- Árvore com mudanças não commitadas de outra sessão (clima histórico): preservar.

## Fase 1: velocidade de rede e bundle
| Item | Arquivos | Teste |
|---|---|---|
| 1.1 Módulos GEV fora do bundle de produção (alias de build para stubs; voz via import dinâmico só em DEV) | vite.config.js, src/main.js, src/prodStubs/* | build: index chunk menor; boot em preview sem erros de console |
| 1.2 `cachedSource` (TTL + dedup em voo + stale-on-error) no dgSelect | src/data/sourceCache.js (+test), datageoClient.js | unit test do cache |
| 1.3 Polling: pula aba escondida, backoff exponencial em erro; ticker/briefing idem | manager.js, datageoTicker.js, datageoBriefing.js, src/data/pollPolicy.js (+test) | unit test da política |
| 1.4 Focos em páginas paralelas (pool 4) | datageoClient.js, src/data/fetchPool.js (+test) | unit test do pool |
| 1.5 preserveDrawingBuffer só se necessário | main.js | grep por toDataURL/readPixels |

## Fase 2: dados estáticos e renderização
| Item | Arquivos | Teste |
|---|---|---|
| 2.1 Simplificar + quantizar GeoJSON grandes | scripts/optimize_geojson.py, public/data/*.geojson | tamanhos antes/depois; contagem de feições igual; acentos UTF-8 preservados |
| 2.2 Rótulos só perto (distanceDisplayCondition) e update por diff em vez de removeAll | datageoLayers.js | unit test do diff; visual no preview |
| 2.3 Rodovias/conectividade sem clampToGround caro (altura fixa) e cores cacheadas | datageoRodovias.js, datageoConectividade.js | visual no preview |

## Fase 3: features
| Item | Arquivos | Teste |
|---|---|---|
| 3.1 Vigiar área (município): alerta de focos/CEMADEN/incidentes novos | src/data/areaWatch.js (+test), src/datageoAreaWatch.js, datageoFicha.js (botão) | unit test do diff enter/exit |
| 3.2 Contagem ao vivo por camada no painel | manager.js (buildTogglePanel) | visual |
| 3.3 Pulso em item novo | datageoLayers.js | visual |
| 3.4 Atalhos + overlay `?` | src/datageoShortcuts.js (+test) | unit + visual |
| 3.5 Briefing heurístico quando não há relatório | datageoBriefing.js, src/data/briefingHeuristic.js (+test) | unit test |
| 3.6 Exportar CSV/GeoJSON do município vigiado | src/data/areaExport.js (+test) | unit test |

## Resultado (2026-09-13, executado)
- Bundle index: 1.362 kB → 1.021 kB (gzip 422 → 306 kB), já incluindo features novas e a camada de clima histórico de outra sessão.
- GeoJSON estáticos: 12,3 MB → 8,2 MB (mesmas feições, desvio ≤ 7 m, acentos ok).
- Testes: 2631 → 2725; falhas 51 → 51 (mesmo conjunto, zero novas).
- Benchmark headless (swiftshader, 2 rodadas): 5 camadas pesadas ligam em 2,2 s vs 2,7 s; frame p95 1,54 s vs 2,1 s; heap 370 MB vs 675 MB; heap no boot ~46 vs ~75 MB.
- Conectividade isolada liga ~0,4 s mais devagar (empacotamento do GroundPrimitive no 1º frame), compensado no uso total.
- 3.2 (contagem por camada) já existia no GEV; complementado com "+N" de itens novos.
- Revisão independente: 2 bugs confirmados (CSV DDE com "-1+", polling de vigilância ocioso/focos buscados 3x) e 5 latentes corrigidos; item "cache de 60 s ignora refresh manual" deixado documentado (polls ≥ 5 min).
- Teclas finais: L camadas, B busca, P Paraná, M tela cheia, A vigilância, ? ajuda.

## Verificação final
- `npm run build` sem erro; comparar tamanhos.
- `npm test`: nenhuma falha nova além das 51 da linha de base.
- `vite preview` + navegador: boot, municípios, ficha, camadas, atalhos, vigiar área, console sem erros novos.
- Revisão de código em passe separado.
