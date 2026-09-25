// src/maplibre/navigation.js
//
// Navegação do protótipo, com o comportamento do app Cesium:
//
// - clique no município abre a ficha (camada municipios.js) e o município fica
//   SELECIONADO (evento MUNICIPIO_SELECIONADO_EVENT da ficha): divisa branca;
// - "Aproximar ao município" enquadra a divisa inteira e põe o município em
//   FOCO: camadas que se escondem por escala (estradas, distribuição, CAR...)
//   aparecem dentro dele em qualquer zoom; o foco se desarma sozinho quando o
//   centro da vista sai do retângulo;
// - "Visão do Paraná" (tecla P) volta ao estado inteiro;
// - busca LOCALIZAÇÃO com as sugestões dos 399 municípios (municipioSearch.js,
//   a mesma do app): escolher abre a ficha e voa até o município.

import { MUNICIPIO_SELECIONADO_EVENT, getMunicipioSelecionado } from '../datageoFicha.js';
import { exactMunicipioMatch, municipioByIbge, searchMunicipios } from '../municipioSearch.js';
import { esc } from './kit.js';
import { MUNICIPIOS_URL, openMunicipioFicha } from './layers/municipios.js';

/** Retângulo do Paraná [w, s, e, n] (divisas do IBGE com folga). */
export const PARANA_BBOX = [-54.62, -26.72, -48.02, -22.52];
/** Inclinação do enquadramento municipal: pitch -68° no Cesium = 22° aqui. */
const MUNICIPIO_PITCH = 22;

function bboxOf(geometry) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      if (coords[0] < w) w = coords[0];
      if (coords[0] > e) e = coords[0];
      if (coords[1] < s) s = coords[1];
      if (coords[1] > n) n = coords[1];
      return;
    }
    for (const c of coords) visit(c);
  };
  visit(geometry.coordinates);
  return [w, s, e, n];
}

export function createNavigation(map, registry, { toast } = {}) {
  /** ibge -> {nome, bbox} */
  let municipios = null;
  const ready = fetch(MUNICIPIOS_URL)
    .then((r) => r.json())
    .then((geo) => {
      municipios = new Map(
        geo.features.map((f) => [String(f.properties.CD_MUN), { nome: f.properties.NM_MUN, bbox: bboxOf(f.geometry) }]),
      );
      return municipios;
    })
    .catch((err) => {
      console.warn('[maplibre:nav] divisas indisponíveis', err);
      return null;
    });

  // --------------------------------------------------------- selecionado
  let selected = null;
  function markSelected(ibge) {
    if (selected && map.getSource('dg-municipios')) map.setFeatureState({ source: 'dg-municipios', id: selected }, { selected: false });
    selected = ibge ? String(ibge) : null;
    if (selected && map.getSource('dg-municipios')) map.setFeatureState({ source: 'dg-municipios', id: selected }, { selected: true });
  }
  const focusBtn = document.getElementById('act-focus');
  document.addEventListener(MUNICIPIO_SELECIONADO_EVENT, (e) => {
    const sel = e.detail;
    markSelected(sel?.ibge ?? null);
    focusBtn.disabled = !sel;
    focusBtn.title = sel ? `Aproximar a ${sel.nome}, com todas as camadas visíveis` : 'Aproximar ao município selecionado';
  });
  // A troca de mapa base recria a fonte e apaga os feature-states.
  map.on('style.load', () => {
    if (selected) setTimeout(() => markSelected(selected), 0);
  });

  // --------------------------------------------------------------- foco
  let focusBbox = null;
  function setFocus(bbox) {
    focusBbox = bbox;
    registry.setFocus(bbox);
  }
  map.on('moveend', () => {
    if (!focusBbox) return;
    const { lng, lat } = map.getCenter();
    const [w, s, e, n] = focusBbox;
    if (lng < w || lng > e || lat < s || lat > n) setFocus(null);
  });

  function frame(bbox, { pitch = MUNICIPIO_PITCH, duration = 2600 } = {}) {
    const pad = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.12);
    map.fitBounds(bbox, {
      padding: { top: pad + 40, bottom: pad + 60, left: pad + 40, right: pad + 40 },
      pitch,
      bearing: 0,
      duration,
      essential: true,
      maxZoom: 14,
    });
  }

  async function flyToMunicipio(ibge, { focus = false } = {}) {
    const all = await ready;
    const m = all?.get(String(ibge));
    if (!m) {
      const c = municipioByIbge(ibge);
      if (c) map.flyTo({ center: [c.lon, c.lat], zoom: 10, pitch: MUNICIPIO_PITCH, duration: 2600, essential: true });
      return false;
    }
    frame(m.bbox);
    if (focus) setFocus(m.bbox);
    return true;
  }

  async function focusSelected() {
    const sel = getMunicipioSelecionado();
    if (!sel) {
      toast?.('Selecione um município primeiro');
      return;
    }
    await flyToMunicipio(sel.ibge, { focus: true });
  }

  function flyToParana() {
    setFocus(null);
    map.fitBounds(PARANA_BBOX, { padding: 40, pitch: 0, bearing: 0, duration: 2200, essential: true });
  }

  focusBtn.addEventListener('click', focusSelected);
  document.getElementById('act-parana').addEventListener('click', flyToParana);

  // -------------------------------------------------------------- busca
  const input = document.getElementById('location-search');
  const list = document.getElementById('location-suggestions');
  let items = [];
  let active = -1;

  function renderSuggestions() {
    list.hidden = !items.length;
    list.innerHTML = items
      .map(
        (m, i) =>
          `<li role="option" data-i="${i}" class="${i === active ? 'on' : ''}">${esc(m.name)}<span>IBGE ${esc(m.code)}</span></li>`,
      )
      .join('');
  }
  async function choose(m) {
    if (!m) return;
    input.value = m.name;
    items = [];
    renderSuggestions();
    input.blur();
    openMunicipioFicha(m.code, m.name);
    await flyToMunicipio(m.code, { focus: true });
  }
  input.addEventListener('input', () => {
    items = input.value.trim() ? searchMunicipios(input.value) : [];
    active = items.length ? 0 : -1;
    renderSuggestions();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      renderSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[active] ?? exactMunicipioMatch(input.value));
    } else if (e.key === 'Escape') {
      items = [];
      renderSuggestions();
      input.blur();
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) {
      e.preventDefault();
      choose(items[Number(li.dataset.i)]);
    }
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      items = [];
      renderSuggestions();
    }, 120),
  );

  function openSearch() {
    input.focus();
    input.select();
  }

  return { flyToParana, focusSelected, flyToMunicipio, openSearch, ready };
}
