// src/data/getecFichaProdutor.js
//
// Prontuário de atendimento do produtor no GETEC, chaveado pela CAF
// (data/privado/getec-ficha-produtor.json, de scripts/build_getec_fichas.py):
// programas (projetos dos grupos), técnicos e vínculos de grupo do ano. O nº
// histórico de atendimentos e os últimos atendimentos datados ficam em
// `atendimentosDatados` (null até sair da view do banco do SISATER; o GETEC web
// não expõe o evento de atendimento em massa). BUCKET PRIVADO (nomes): sem
// sessão o loader devolve null.

import { dgFetchData } from './datageoClient.js';

const URL = '/privado/getec-ficha-produtor.json';

let _promessa = null;

/** Payload ou null (sem sessão/arquivo). Nunca lança. */
export function loadGetecFichaProdutor() {
  _promessa ??= dgFetchData(URL)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d) => {
      if (!d) _promessa = null; // tenta de novo depois do login
      return d;
    });
  return _promessa;
}

/** Prontuário de um produtor pelo nº da CAF, ou null. */
export function prontuario(dados, caf) {
  return dados?.produtores?.[String(caf)] ?? null;
}
