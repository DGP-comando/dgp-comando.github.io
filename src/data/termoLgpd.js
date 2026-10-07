// src/data/termoLgpd.js
//
// Termo de responsabilidade LGPD assinado no login (src/datageoLogin.js),
// antes do boot e do tutorial. O registro (CPF, e-mail, matrícula, data e hora,
// texto do termo) vai para o bucket privado `datageo-termos` do c2-parana, numa
// pasta por usuário em que ele só consegue gravar (migration 047): os demais
// usuários não leem. A hora que vale como prova é a do servidor
// (storage.objects.created_at); a do navegador vai junto no JSON.
//
// Texto mudou? Suba TERMO_VERSAO: todos assinam de novo no próximo acesso.

export const TERMO_VERSAO = '2026-10-07';
export const TERMO_BUCKET = 'datageo-termos';
export const TERMO_TITULO = 'Termo de responsabilidade e confidencialidade (LGPD)';

export const TERMO_TEXTO = Object.freeze([
  'Declaro que acesso a plataforma DataGeo Paraná por credencial pessoal e intransferível, em razão das '
    + 'minhas atribuições no âmbito da SEAGRI.',
  'Estou ciente de que a plataforma reúne dados pessoais, inclusive sensíveis, de produtores rurais, '
    + 'famílias e servidores (como nomes, CPF, endereços, coordenadas de imóveis e participação em '
    + 'programas sociais), protegidos pela Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018).',
  'Comprometo-me a não divulgar, compartilhar, repassar ou publicar esses dados, por nenhum meio '
    + '(inclusive capturas de tela, exportações, planilhas, mensagens e apresentações), a terceiros alheios à '
    + 'SEAGRI, incluídas prefeituras e outros órgãos e entidades de governo municipais, estaduais ou federais, '
    + 'conselhos, associações, cooperativas, empresas e pessoas físicas, salvo autorização formal da SEAGRI '
    + 'com base legal adequada.',
  'Usarei os dados somente para a finalidade institucional que justifica meu acesso, observando os princípios '
    + 'de finalidade, adequação, necessidade, segurança e prevenção (art. 6º da LGPD), sem guardar cópias '
    + 'além do necessário.',
  'Comunicarei de imediato à administração da plataforma qualquer perda de credencial, acesso indevido ou '
    + 'suspeita de vazamento.',
  'Estou ciente de que o descumprimento deste termo pode levar à suspensão do acesso e à responsabilização '
    + 'administrativa, civil e penal, nos termos da legislação vigente.',
  'Autorizo o registro do meu CPF, e-mail, matrícula e da data e hora desta assinatura, com a finalidade '
    + 'exclusiva de comprovar a ciência e a aceitação deste termo. Esse registro fica em área restrita, sem '
    + 'acesso dos demais usuários.',
]);

export const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

/** CPF com dígitos verificadores corretos (mod 11); rejeita sequências repetidas. */
export function cpfValido(valor) {
  const d = soDigitos(valor);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/** 000.000.000-00 enquanto digita. */
export function mascaraCpf(valor) {
  const d = soDigitos(valor).slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3}\.\d{3})(\d)/, '$1.$2').replace(/^(\d{3}\.\d{3}\.\d{3})(\d)/, '$1-$2');
}

export const emailValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v ?? '').trim());

/** E-mail de verdade do usuário para pré-preencher (o SISATER usa um sintético). */
export const emailReal = (user) => (user?.email && !user.email.endsWith('@sisater.local') ? user.email : '');

/** Já assinou a versão atual? (flag no user_metadata; a prova é o arquivo no bucket) */
export const termoAssinado = (user) => user?.user_metadata?.lgpd_termo?.versao === TERMO_VERSAO;

/** SHA-256 hex do texto do termo (Web Crypto: navegador e node). */
export async function hashTermo(texto = TERMO_TEXTO.join('\n')) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const FUSO = 'America/Sao_Paulo';
const horaLocal = (agora) => agora.toLocaleString('pt-BR', { timeZone: FUSO });

/** Caminho do registro no bucket: pasta do usuário (exigência da policy), versão e instante UTC. */
export const caminhoRegistro = (user, agora) =>
  `${user.id}/${TERMO_VERSAO}_${agora.toISOString().replace(/[:.]/g, '-')}.json`;

/** Registro autoexplicativo da assinatura (texto completo junto: não depende do repo). */
export async function montaRegistro(user, { cpf, email }, agora = new Date(), userAgent = '') {
  const texto = TERMO_TEXTO.join('\n');
  return {
    termo: { titulo: TERMO_TITULO, versao: TERMO_VERSAO, sha256: await hashTermo(texto), texto: TERMO_TEXTO },
    usuario: {
      id: user.id,
      matricula: user.user_metadata?.matricula ?? null,
      nome: user.user_metadata?.nome ?? user.user_metadata?.full_name ?? null,
      login: user.email ?? null,
    },
    cpf: soDigitos(cpf),
    email: String(email).trim().toLowerCase(),
    assinado_em: agora.toISOString(),
    assinado_em_local: `${horaLocal(agora)} (${FUSO})`,
    user_agent: userAgent,
  };
}
