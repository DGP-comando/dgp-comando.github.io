"""composition.html (pt-BR) -> composition-en.html (en-US) por substituição de strings.

Falha alto se alguma string de origem não for encontrada (a composição mudou).
Uso: py -3 scripts/reel/translate_en.py <dir>
"""
import sys
from pathlib import Path

DIR = Path(sys.argv[1])
s = DIR.joinpath('composition.html').read_text(encoding='utf-8')

T = [
    ('<html lang="pt-BR">', '<html lang="en">'),
    ('DGP Comando <small>DataGeo PR · sala de situação</small>', 'DGP Command <small>DataGeo PR · situation room</small>'),
    ("SALA DE SITUAÇÃO · 399 MUNICÍPIOS", "SITUATION ROOM · 399 MUNICIPALITIES"),
    # rótulos dos capítulos
    ("label: 'Abertura'", "label: 'Opening'"), ("label: 'O que é'", "label: 'Overview'"), ("label: 'Camadas'", "label: 'Layers'"),
    ("label: 'A rede'", "label: 'The network'"), ("label: 'Logística'", "label: 'Logistics'"), ("label: 'Tempo real'", "label: 'Real time'"),
    ("label: 'Localização'", "label: 'Search'"), ("label: 'Ficha'", "label: 'Profile'"), ("label: 'De perto'", "label: 'Up close'"),
    ("label: 'Familiar · Defesa'", "label: 'Family · Defense'"), ("label: 'Vigilância'", "label: 'Monitoring'"), ("label: 'Encerramento'", "label: 'Closing'"),
    # o que é
    ("'eyebrow', 'Sala de situação'", "'eyebrow', 'Situation room'"),
    ('Os <span class="ac">399 municípios</span> do Paraná numa sala de comando.', 'Paraná\\\'s <span class="ac">399 municipalities</span> in one command room.'),
    ("'lead', 'Dados públicos, pipelines próprios, tudo ao vivo.'), { x: 120, y: 560 }", "'lead', 'Public data, in-house pipelines, all live.'), { x: 120, y: 560 }"),
    ("Mapa MapLibre GL JS 6.7 · globo ou mapa 2D · satélite Esri World Imagery, OpenStreetMap, relevo opcional · o mapa não precisa de chave de API",
     "MapLibre GL JS 6.7 map · globe or 2D · Esri World Imagery satellite, OpenStreetMap, optional terrain · the map needs no API key"),
    # camadas
    ("const GRUPOS = ['Limites e regiões', 'Territórios e povos', 'Agricultura familiar e CAR', 'IDR-Paraná', 'Defesa Agropecuária', 'Logística agro', 'Transporte',\n  'Energia e conectividade', 'Saúde e proteção social', 'Clima', 'Recursos hídricos', 'Ambiente', 'Riscos e alertas', 'Contexto global'];",
     "const GRUPOS = ['Boundaries and regions', 'Territories and peoples', 'Family farming and CAR', 'IDR-Paraná', 'Agricultural Defense', 'Agri logistics', 'Transport',\n  'Energy and connectivity', 'Health and social protection', 'Climate', 'Water resources', 'Environment', 'Risks and alerts', 'Global context'];"),
    ("'eyebrow', 'Camadas de dados'", "'eyebrow', 'Data layers'"),
    ("'Tudo o que aparece no mapa sai de um painel.'", "'Everything on the map comes from one panel.'"),
    ("l: 'camadas DataGeo', s: 'mais 16 de contexto global (voos, navios, satélites, terremotos…)'", "l: 'DataGeo layers', s: 'plus 16 global-context layers (flights, ships, satellites, earthquakes…)'"),
    ("Cada linha mostra a fonte, a contagem e a última atualização. Busca pelo nome e três modos de exibição: grupos, lista compacta, grade de ícones.",
     "Each row shows the source, the count and the last update. Search by name and three display modes: groups, compact list, icon grid."),
    # rede
    ("'eyebrow', 'Visão do estado'", "'eyebrow', 'State view'"),
    ("'A rede pública no território.'", "'The public network across the territory.'"),
    ("l: 'regionais do IDR-Paraná', s: 'dissolvidas dos 399 municípios · clique abre a ficha regional'", "l: 'IDR-Paraná regional offices', s: 'dissolved from the 399 municipalities · click opens the regional profile'"),
    ("l: 'unidades do IDR-Paraná', s: '396 UMEs · 23 regionais · 19 estações · 7 polos · 2 sedes · endereços auditados contra o site'", "l: 'IDR-Paraná units', s: '396 local offices · 23 regionals · 19 research stations · 7 hubs · 2 headquarters · addresses audited against the official site'"),
    ("l: 'escritórios da ADAPAR', s: '22 regionais · 126 locais · endereço, contato e circunscrição'", "l: 'ADAPAR offices', s: '22 regional · 126 local · address, contact and jurisdiction'"),
    ("l: 'CEASAs', s: 'Centrais de Abastecimento do Paraná'", "l: 'CEASAs', s: 'Paraná\\\'s wholesale food supply centers'"),
    # logística
    ("'eyebrow', 'Logística agro · energia e conectividade'", "'eyebrow', 'Agri logistics · energy and connectivity'"),
    ("'Do armazém à subestação.'", "'From the warehouse to the substation.'"),
    ("l: 'Rodovias (DNIT/DER) · ferrovias · armazéns (CONAB) · CEASAs · navios no Porto de Paranaguá (line-up da APPA, posição ao vivo)'", "l: 'Highways (DNIT/DER) · railways · CONAB warehouses · CEASAs · ships at the Port of Paranaguá (APPA line-up, live positions)'"),
    ("unit: 'mil trechos', l: 'rede de distribuição de média tensão da Copel', s: '13,8 e 34,5 kV · ANEEL · BDGD COPEL-DIS 2022 · fatiada em células de 0,25°'", "unit: 'thousand segments', l: 'Copel medium-voltage distribution grid', s: '13.8 and 34.5 kV · ANEEL · BDGD COPEL-DIS 2022 · tiled in 0.25° cells'"),
    ("l: 'Linhas de transmissão · subestações · usinas · cobertura e torres de conectividade'", "l: 'Transmission lines · substations · power plants · connectivity coverage and towers'"),
    # tempo real
    ("['🌡️', 'Estações de clima', 'INMET · temperatura e umidade agora']", "['🌡️', 'Weather stations', 'INMET · temperature and humidity now']"),
    ("['🌊', 'Nível dos rios', 'ANA · situação por estação']", "['🌊', 'River levels', 'ANA · status per station']"),
    ("['🚨', 'Alertas de desastre', 'CEMADEN']", "['🚨', 'Disaster alerts', 'CEMADEN']"),
    ("['🔥', 'Focos de calor', 'NASA FIRMS · VIIRS, últimas 24 h']", "['🔥', 'Fire hotspots', 'NASA FIRMS · VIIRS, last 24 h']"),
    ("['⚠️', 'Incidentes ativos', 'por severidade']", "['⚠️', 'Active incidents', 'by severity']"),
    ("['🦟', 'Dengue', 'InfoDengue · nível por município']", "['🦟', 'Dengue', 'InfoDengue · level per municipality']"),
    ("['🌫️', 'Qualidade do ar', 'índice AQI por cidade']", "['🌫️', 'Air quality', 'AQI index per city']"),
    ("['📡', 'Telemetria hídrica', 'InfoHidro']", "['📡', 'Hydro telemetry', 'InfoHidro']"),
    ("['🚢', 'Navios', 'Porto de Paranaguá · APPA']", "['🚢', 'Ships', 'Port of Paranaguá · APPA']"),
    ("'eyebrow', 'Monitoramento em tempo real'", "'eyebrow', 'Real-time monitoring'"),
    ("'O que muda sozinho, muda no mapa.'", "'What changes on its own, changes on the map.'"),
    ("Pipelines próprios atualizam as bases; o mapa recarrega sem intervenção. Camadas de tempo real e cadastros com dado pessoal só para usuário autenticado.",
     "In-house pipelines refresh the databases; the map reloads on its own. Real-time layers and registries with personal data require an authenticated user."),
    # busca
    ("'eyebrow', 'Pesquisa de localização'", "'eyebrow', 'Location search'"),
    ("'Digite o município. <span class=\"ac\">Enter</span> enquadra e abre a ficha.'", "'Type the municipality. <span class=\"ac\">Enter</span> frames it and opens the profile.'"),
    ("l: 'municípios na busca local', s: 'resolve o nome contra a tabela do IBGE: devolve o código, sem geocoder, sem chave, sem homônimos de outro estado'", "l: 'municipalities in the local search', s: 'resolves the name against the IBGE table: returns the code, no geocoder, no API key, no same-name towns from other states'"),
    ("'<kbd>B</kbd> abre a busca'", "'<kbd>B</kbd> opens the search'"),
    ("'<kbd>↑</kbd><kbd>↓</kbd><kbd>Enter</kbd> escolhe e enquadra'", "'<kbd>↑</kbd><kbd>↓</kbd><kbd>Enter</kbd> pick and frame'"),
    ("'<kbd>P</kbd> volta ao Paraná inteiro'", "'<kbd>P</kbd> back to the whole of Paraná'"),
    ("l: 'Endereço ou lugar fora da lista também funciona.'", "l: 'An address or place outside the list works too.'"),
    # ficha
    ("['Território', 'IDR/SEAB'], ['Extensionistas', 'IDR'], ['Assistência técnica', 'GETEC'], ['SUSAF-PR', 'SEAB/ADAPAR'], ['Módulo fiscal', 'INCRA'],",
     "['Territory', 'IDR/SEAB'], ['Extension agents', 'IDR'], ['Technical assistance', 'GETEC'], ['SUSAF-PR', 'SEAB/ADAPAR'], ['Fiscal module', 'INCRA'],"),
    ("['Economia agropecuária', 'SEAB/DERAL · VBP'], ['Agricultura familiar', 'MDA · CAF'], ['Estrutura fundiária', 'CAR ativos'], ['População', 'IBGE'],",
     "['Agricultural economy', 'SEAB/DERAL · GVP'], ['Family farming', 'MDA · CAF'], ['Land structure', 'active CAR'], ['Population', 'IBGE'],"),
    ("['Proteção social', 'MDS'], ['Segurança pública', 'SINESP'], ['Ambiente', 'FIRMS + detector'], ['Clima histórico', 'BR-DWGD'], ['Outorgas de água', 'IAT'],",
     "['Social protection', 'MDS'], ['Public safety', 'SINESP'], ['Environment', 'FIRMS + detector'], ['Historical climate', 'BR-DWGD'], ['Water permits', 'IAT'],"),
    ("['Proteção de fontes', 'IDR'], ['Hidrologia', 'ANA + CEMADEN'],", "['Spring protection', 'IDR'], ['Hydrology', 'ANA + CEMADEN'],"),
    ("'eyebrow', 'Ficha municipal'", "'eyebrow', 'Municipal profile'"),
    ("'Um município, todas as bases, uma ficha.'", "'One municipality, every database, one profile.'"),
    ("Clique no mapa ou na busca. O botão <b>aproximar</b> desce ao município e libera as camadas que só aparecem de perto; <b>VIGIAR</b> o põe na lista de vigilância.",
     "Click the map or search. The <b>zoom-in</b> button descends to the municipality and unlocks the close-range layers; <b>WATCH</b> adds it to the monitoring list."),
    # de perto
    ("'eyebrow', 'Estudo situacional · Prudentópolis'", "'eyebrow', 'Situational study · Prudentópolis'"),
    ("'De perto, o território aparece.'", "'Up close, the territory shows.'"),
    ("unit: 'mil', l: 'imóveis ativos do CAR no Paraná', s: 'SICAR · divisas generalizadas a 30 m · porte por módulos fiscais · sem CPF ou nome'", "unit: 'thousand', l: 'active CAR rural properties in Paraná', s: 'SICAR · boundaries generalized to 30 m · size by fiscal modules · no CPF or names'"),
    ("unit: 'mil trechos', l: 'de estradas municipais', s: 'OpenStreetMap · 190 mil urbanas, 204 mil rurais · mais as rurais conveniadas SEAB 2026'", "unit: 'thousand segments', l: 'of municipal roads', s: 'OpenStreetMap · 190k urban, 204k rural · plus the SEAB 2026 rural road agreements'"),
    ("l: 'faxinais (ZEE-PR 2010)', s: 'e 29 territórios inscritos no CAR, com situação na ARESUR · IAT/GeoPR'", "l: 'faxinais (ZEE-PR 2010)', s: 'plus 29 territories registered in CAR, with ARESUR status · IAT/GeoPR'"),
    ("l: 'unidades de conservação', s: '39 federais · 42 estaduais · MMA/CNUC · outorgas de água consultadas ao vivo no GeoPR/IAT'", "l: 'conservation units', s: '39 federal · 42 state · MMA/CNUC · water permits queried live from GeoPR/IAT'"),
    # familiar
    ("'eyebrow', 'Agricultura familiar · Defesa Agropecuária'", "'eyebrow', 'Family farming · Agricultural Defense'"),
    ("'Da família ao rebanho.'", "'From the family to the herd.'"),
    ("l: 'CAF (MDA): um ponto por família no imóvel principal. O clique abre o cadastro completo e destaca o imóvel do CAR que contém o ponto.'", "l: 'CAF (MDA): one point per family at the main property. Clicking opens the full record and highlights the CAR property that contains the point.'"),
    ("l: 'CAF jurídicas', s: 'cooperativas, associações e empreendimentos · o clique traça a rede até as famílias sócias'", "l: 'CAF legal entities', s: 'cooperatives, associations and enterprises · clicking traces the network down to the member families'"),
    ("unit: 'mil', l: 'propriedades com exploração pecuária', s: 'ADAPAR · 256,6 mil no mapa · cor pela DAP/CAF informada'", "unit: 'thousand', l: 'properties with livestock', s: 'ADAPAR · 256.6k on the map · colored by declared DAP/CAF'"),
    ("l: 'Estabelecimentos registrados na ADAPAR: produtos veterinários, animais vivos, agrotóxicos, fertilizantes, Unidades de Consolidação, indústrias de origem animal.'", "l: 'Establishments registered with ADAPAR: veterinary products, live animals, pesticides, fertilizers, Consolidation Units, animal-origin industries.'"),
    ("LGPD · dado pessoal (CPF, contato) só para usuário liberado, para o técnico localizar e conferir o cadastro · arquivos privados fora do repositório",
     "LGPD (Brazilian data protection law) · personal data (CPF, contact) only for authorized users, so field technicians can locate and verify records · private files kept out of the repository"),
    ("toLocaleString('pt-BR', { maximumFractionDigits", "toLocaleString('en-US', { maximumFractionDigits"),
    ("const fmt = (n) => Math.round(n).toLocaleString('pt-BR');", "const fmt = (n) => Math.round(n).toLocaleString('en-US');"),
    # vigilância
    ("'eyebrow', 'Vigilância · compartilhamento · atalhos'", "'eyebrow', 'Monitoring · sharing · shortcuts'"),
    ("'O que fica rodando depois que você sai.'", "'What keeps running after you leave.'"),
    ("l: 'entre varreduras da vigilância', s: 'focos de calor, alertas CEMADEN e incidentes novos nos municípios vigiados · até 10 municípios · exporta CSV · tecla A'", "l: 'between monitoring sweeps', s: 'new fire hotspots, CEMADEN alerts and incidents in the watched municipalities · up to 10 · CSV export · key A'"),
    ("l: 'O link compartilhado leva câmera, estilo visual, camadas ligadas e até um alvo rastreado: quem abre vê exatamente a mesma tela.'", "l: 'The share link carries camera, visual style, enabled layers and even a tracked target: whoever opens it sees exactly the same screen.'"),
    ("[['L', 'camadas'], ['B', 'busca'], ['P', 'Paraná'], ['A', 'vigilância'], ['M', 'tela cheia'], ['?', 'atalhos'], ['1–7', 'estilos visuais'], ['H', 'HUD'], ['V', 'visão limpa']]",
     "[['L', 'layers'], ['B', 'search'], ['P', 'Paraná'], ['A', 'monitoring'], ['M', 'full screen'], ['?', 'shortcuts'], ['1–7', 'visual styles'], ['H', 'HUD'], ['V', 'clean view']]"),
    # fim
    ("'eyebrow', 'Estilos visuais · teclas 1 a 7'", "'eyebrow', 'Visual styles · keys 1 to 7'"),
    ("'Normal · Retro · Vigilância · Térmico · Anime · Noir · Neve.'", "'Normal · Retro · Surveillance · Thermal · Anime · Noir · Snow.'"),
    ("'lead', 'Dados públicos. Pipelines próprios. Tudo ao vivo.'", "'lead', 'Public data. In-house pipelines. All live.'"),
    # sem trilho de capítulos: a faixa de baixo fica para as legendas
    ("#rail { position: absolute;", "#rail { display: none; position: absolute;"),
    ("#chapters { position: absolute;", "#chapters { display: none; position: absolute;"),
]
for a, b in T:
    assert a in s, f'não achei: {a[:80]}'
    s = s.replace(a, b)
DIR.joinpath('composition-en.html').write_text(s, encoding='utf-8')
print('composition-en.html ok,', len(T), 'substituições')
