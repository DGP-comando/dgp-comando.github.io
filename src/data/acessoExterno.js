// src/data/acessoExterno.js
//
// Usuário externo do DataGeo (app_metadata.datageo_externo, marcado pelo admin
// na aba Usuários do painel de acessos). Vê as camadas abertas e as do
// Supabase, mas não as que leem o bucket privado datageo-privado.
//
// A proteção de verdade é a policy do bucket (migration 051 do c2-parana):
// o externo recebe 403 mesmo chamando a API direto. Aqui só se tira do painel
// o que viria vazio e se evita a requisição.

/** Camadas cujos dados saem do bucket datageo-privado. Camada nova com `/privado/`? Inclua aqui. */
export const CAMADAS_PRIVADAS = new Set([
  'datageo-caf',
  'datageo-caf-pj',
  'datageo-cnes-saude',
  'datageo-cnpj-agro',
  'datageo-radios',
  'datageo-adapar-exploracoes',
  'datageo-adapar-veterinarios',
  'datageo-adapar-animais-vivos',
  'datageo-adapar-agrotoxicos',
  'datageo-adapar-fertilizantes',
  'datageo-adapar-unidades-consolidacao',
  'datageo-adapar-industrias-poa',
  'datageo-agroindustrias',
  'datageo-agroindustrias-idr',
  'datageo-estacoes-idr',
  'datageo-unidades-idr',
  'datageo-fontes-protegidas',
  'datageo-urs-graos',
  'datageo-urs-cafe',
  'datageo-urs-piscicultura',
  'datageo-urs-pecuaria-corte',
  'datageo-estradas-conveniadas',
]);

export const ehExterno = (user) => user?.app_metadata?.datageo_externo === true;

let _externo = false;

/** Fixado no boot com o usuário logado (main.js). */
export function definirExterno(valor) {
  _externo = Boolean(valor);
}

export const semPrivado = () => _externo;
