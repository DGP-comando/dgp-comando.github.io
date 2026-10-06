// src/pessoaSearch.js
//
// Busca por PESSOA, ao lado da busca de localização: produtor (CAF, um ponto
// por família) ou extensionista (servidores do IDR). Os dois vêm do bucket
// privado; sem sessão liberada a lista avisa e não mostra nada.
//
// Escolher um produtor liga a camada CAF, voa até o ponto e abre o cadastro;
// escolher um extensionista liga as Unidades do IDR e abre o escritório dele
// já com a rede de assistidos do GETEC desenhada.

import { loadCafPontos } from './data/cafFamilias.js';
import { loadServidoresIdr } from './data/servidoresIdr.js';
import { municipioByIbge, normalizeMunicipioQuery } from './municipioSearch.js';
import { abrirFamiliaCaf } from './maplibre/layers/caf.js';
import { abrirExtensionista } from './maplibre/layers/estacoesIdr.js';

const LIMITE = 8;
const MIN_CHARS = 3;

/**
 * Itens cujo nome contém todos os termos da consulta como início de palavra,
 * em qualquer ordem ("silva joao" acha "JOÃO DA SILVA"). Quem começa pela
 * consulta vem antes; empate, nome mais curto.
 * @param {Array<{chave: string}>} itens - `chave` = nome já normalizado
 * @param {string} consulta
 */
export function buscarPessoas(itens, consulta, limite = LIMITE) {
  const q = normalizeMunicipioQuery(consulta);
  if (q.length < MIN_CHARS) return [];
  const termos = q.split(' ');
  const achados = [];
  for (const it of itens) {
    const palavras = it.chave.split(' ');
    if (!termos.every((t) => palavras.some((p) => p.startsWith(t)))) continue;
    achados.push(it);
  }
  achados.sort((a, b) => (!a.chave.startsWith(q)) - (!b.chave.startsWith(q)) || a.chave.length - b.chave.length);
  return achados.slice(0, limite);
}

const fontes = {
  produtor: {
    placeholder: 'Buscar produtor (CAF)...',
    rotulo: 'Produtores · CAF',
    async itens() {
      const d = await loadCafPontos();
      return (d?.p ?? []).filter((r) => r[5]).map(([lon, lat, caf, ibge, , nome]) => ({
        chave: normalizeMunicipioQuery(nome),
        nome,
        sub: municipioByIbge(ibge)?.name ?? ibge,
        codigo: `CAF ${caf}`,
        caf,
        lon,
        lat,
      }));
    },
    async abrir(it, { dataManager, layerHost }) {
      await dataManager.setEnabled('datageo-caf', true, { origin: 'user' });
      layerHost.ctx.map.flyTo({ center: [it.lon, it.lat], zoom: 15, duration: 1200 });
      abrirFamiliaCaf(it.caf, layerHost.ctx);
    },
  },
  extensionista: {
    placeholder: 'Buscar extensionista...',
    rotulo: 'Extensionistas · IDR',
    async itens() {
      const d = await loadServidoresIdr().catch(() => null);
      return (d?.servidores ?? []).filter((s) => s.extensionista).map((s) => ({
        chave: normalizeMunicipioQuery(s.nome),
        nome: s.nome,
        sub: [s.municipio, s.formacao].filter(Boolean).join(' · '),
        codigo: s.id,
        servidor: s,
      }));
    },
    async abrir(it, { dataManager, layerHost }) {
      await dataManager.setEnabled('datageo-unidades-idr', true, { origin: 'user' });
      await abrirExtensionista(it.servidor, layerHost.ctx);
    },
  },
};

/** Monta a caixa em #pessoa-search. deps = { dataManager, layerHost }. */
export function initPessoaSearch(deps) {
  const input = document.getElementById('pessoa-search');
  const modo = document.getElementById('pessoa-search-modo');
  const lista = document.getElementById('pessoa-search-results');
  if (!input || !modo || !lista) return;

  const cache = {}; // modo -> Promise<itens>
  let achados = [];
  let ativo = -1;
  let geracao = 0;

  const fechar = () => {
    achados = [];
    ativo = -1;
    lista.hidden = true;
    lista.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const aviso = (texto) => {
    const li = document.createElement('li');
    li.className = 'location-search-results-hint';
    li.setAttribute('role', 'presentation');
    li.textContent = texto;
    return li;
  };

  const escolher = async (it) => {
    fechar();
    input.value = '';
    input.blur();
    try {
      await fontes[modo.value].abrir(it, deps);
    } catch (err) {
      console.warn('[DataGeo] busca por pessoa:', err);
    }
  };

  const pintar = async () => {
    const meu = ++geracao;
    const fonte = fontes[modo.value];
    if (normalizeMunicipioQuery(input.value).length < MIN_CHARS) return fechar();
    cache[modo.value] ??= fonte.itens().catch(() => []);
    const itens = await cache[modo.value];
    if (meu !== geracao) return;
    if (!itens.length) delete cache[modo.value]; // sem sessão: tenta de novo depois do login
    achados = buscarPessoas(itens, input.value);
    ativo = -1;
    lista.replaceChildren(aviso(itens.length
      ? `${fonte.rotulo} · ${achados.length || 'nenhum'}`
      : 'Acesso restrito: entre com usuário liberado'));
    achados.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'location-search-option';
      li.id = `pessoa-search-option-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const nome = document.createElement('span');
      nome.className = 'location-search-option-name';
      nome.textContent = it.sub ? `${it.nome} · ${it.sub}` : it.nome;
      const cod = document.createElement('span');
      cod.className = 'location-search-option-code';
      cod.textContent = it.codigo;
      li.append(nome, cod);
      // mousedown: roda antes do blur que fecharia a lista.
      li.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        void escolher(it);
      });
      lista.appendChild(li);
    });
    lista.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const mover = (passo) => {
    if (!achados.length) return;
    ativo = ativo === -1 ? (passo > 0 ? 0 : achados.length - 1) : (ativo + passo + achados.length) % achados.length;
    lista.querySelectorAll('.location-search-option').forEach((li, i) => {
      li.classList.toggle('active', i === ativo);
      li.setAttribute('aria-selected', String(i === ativo));
      if (i === ativo) {
        li.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', li.id);
      }
    });
  };

  modo.addEventListener('change', () => {
    input.placeholder = fontes[modo.value].placeholder;
    void pintar();
  });
  input.addEventListener('input', () => void pintar());
  input.addEventListener('blur', fechar);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mover(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      fechar();
    } else if (e.key === 'Enter') {
      const it = achados[ativo] ?? (achados.length === 1 ? achados[0] : null);
      if (it) {
        e.preventDefault();
        void escolher(it);
      }
    }
  });
}
