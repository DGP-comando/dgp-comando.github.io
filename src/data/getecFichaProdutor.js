// src/data/getecFichaProdutor.js
//
// Prontuário de atendimento do produtor no GETEC, chaveado pela CAF:
//   getec-ficha-produtor.json     programas (projetos dos grupos), técnicos e
//                                 vínculos de grupo do ano (build_getec_fichas.py)
//   getec-atendimentos/<ibge>.json  histórico de atendimentos individuais do
//                                 banco do SISATER, somado entre os membros da
//                                 família, e participações em eventos
//                                 (build_getec_atendimentos.py), um por município
// BUCKET PRIVADO (nomes): sem sessão os loaders devolvem null.

import { dgFetchData } from './datageoClient.js';

const URL = '/privado/getec-ficha-produtor.json';

/** JSON privado com cache; falha/sem sessão devolve null e libera nova tentativa. */
function cacheado(url) {
  let p = null;
  return () => {
    p ??= dgFetchData(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => {
        if (!d) p = null; // tenta de novo depois do login
        return d;
      });
    return p;
  };
}

/** Payload ou null (sem sessão/arquivo). Nunca lança. */
export const loadGetecFichaProdutor = cacheado(URL);

const porMunicipio = new Map();
/** Atendimentos das famílias de um município: {periodo, produtores: {caf: {...}}} ou null. */
export function loadGetecAtendimentos(ibge) {
  const k = String(ibge);
  if (!porMunicipio.has(k)) porMunicipio.set(k, cacheado(`/privado/getec-atendimentos/${k}.json`));
  return porMunicipio.get(k)();
}

/**
 * Prontuário de um produtor pelo nº da CAF, ou null. `atendimentos` (opcional)
 * é o payload do município: preenche `atendimentosDatados`, e uma família com
 * atendimento mas fora dos grupos do ano ganha prontuário só com o histórico.
 * Sem o payload (sem sessão, falha de rede), `historicoIndisponivel` avisa o
 * card para não afirmar que a família nunca foi atendida.
 */
export function prontuario(dados, caf, atendimentos = null) {
  const k = String(caf);
  const grupo = dados?.produtores?.[k] ?? null;
  const at = atendimentos?.produtores?.[k] ?? null;
  if (!at) return grupo && !atendimentos ? { ...grupo, historicoIndisponivel: true } : grupo;
  const datados = { ...at, periodo: atendimentos.periodo ?? null };
  return grupo ? { ...grupo, atendimentosDatados: datados } : { caf: k, nVinculos: 0, atendimentosDatados: datados };
}
