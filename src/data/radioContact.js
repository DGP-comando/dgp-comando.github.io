// src/data/radioContact.js
//
// Contato e localização de uma rádio, para o tooltip do mapa e o card do
// player. Só dado institucional publicado pela própria emissora (telefone do
// estúdio, WhatsApp da rádio, endereço do estúdio, site, redes). Texto externo
// sai sempre escapado: nome, endereço e links vêm de diretórios comunitários.

import { escapeHtml } from './vesselTooltip.js';

const TOOLTIP_MAX_STATIONS = 5;

/** Estação que toca no navegador: stream HTTPS publicado. */
export function isLive(station) {
  return typeof station?.url === 'string' && station.url.startsWith('https://');
}

/** Só dígitos, com DDI 55 para o wa.me. Vazio se não parecer telefone. */
export function whatsappNumber(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 10 || /^0+$/.test(digits.replace(/^55/, ''))) return '';
  return digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits}`;
}

/** 5544999998888 → (44) 99999-8888. */
export function formatPhone(digits) {
  const d = String(digits).replace(/^55/, '');
  return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : d;
}

function safeUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * Linhas de contato, na ordem em que aparecem: onde fica, como falar, onde ler.
 * @returns {{kind: string, icon: string, label: string, href: string}[]}
 */
export function contactLines(station, municipio) {
  const lines = [];
  if (station.endereco) {
    const q = encodeURIComponent(`${station.endereco}, ${municipio} - PR`);
    lines.push({ kind: 'endereco', icon: '📍', label: station.endereco, href: `https://www.google.com/maps/search/?api=1&query=${q}` });
  }
  if (station.telefone) {
    lines.push({ kind: 'telefone', icon: '☎', label: station.telefone, href: `tel:+55${station.telefone.replace(/\D/g, '')}` });
  }
  const wa = whatsappNumber(station.whatsapp);
  const telDigits = String(station.telefone ?? '').replace(/\D/g, '');
  if (wa && !wa.endsWith(telDigits || '-')) lines.push({ kind: 'whatsapp', icon: '💬', label: `WhatsApp ${formatPhone(wa)}`, href: `https://wa.me/${wa}` });
  if (station.email) lines.push({ kind: 'email', icon: '✉', label: station.email, href: `mailto:${station.email}` });
  const site = safeUrl(station.site);
  if (site) lines.push({ kind: 'site', icon: '🌐', label: new URL(site).hostname.replace(/^www\./, ''), href: site });
  const insta = safeUrl(station.instagram);
  if (insta) lines.push({ kind: 'instagram', icon: '📷', label: 'Instagram', href: insta });
  const fb = safeUrl(station.facebook);
  if (fb) lines.push({ kind: 'facebook', icon: 'f', label: 'Facebook', href: fb });
  return lines;
}

/** Selos curtos: comunitária, programa rural, só no dial. */
export function stationBadges(station) {
  return [
    station.comunitaria ? 'Comunitária' : '',
    station.rural ? 'Programa rural' : '',
    isLive(station) ? '' : 'Só no dial',
  ].filter(Boolean);
}

/** HTML do tooltip de um município: cada rádio com frequência, contato e endereço. */
export function placeTooltipHtml(place) {
  const live = place.stations.filter(isLive).length;
  const dial = place.stations.length - live;
  const counts = [live ? `${live} ao vivo` : '', dial ? `${dial} só no dial` : ''].filter(Boolean).join(' · ');
  const rows = place.stations.slice(0, TOOLTIP_MAX_STATIONS).map((s) => {
    const wa = whatsappNumber(s.whatsapp);
    const contato = s.telefone || (wa ? `WhatsApp ${formatPhone(wa)}` : '');
    // Sem contato conhecido, a entidade outorgada é o que distingue duas
    // comunitárias do mesmo canal na mesma cidade.
    const detail = ([contato, s.endereco].filter(Boolean).length ? [contato, s.endereco] : [s.entidade])
      .filter(Boolean).map(escapeHtml).join(' · ');
    const tags = [s.freq, s.comunitaria ? 'comunitária' : '', s.rural ? 'rural' : ''].filter(Boolean).join(' · ');
    return `<div class="rt-st"><b>${isLive(s) ? '●' : '○'} ${escapeHtml(s.name)}</b>`
      + (tags ? ` <span class="rt-tag">${escapeHtml(tags)}</span>` : '')
      + (detail ? `<div class="rt-det">${detail}</div>` : '')
      + '</div>';
  }).join('');
  const more = place.stations.length > TOOLTIP_MAX_STATIONS
    ? `<div class="rt-det">+${place.stations.length - TOOLTIP_MAX_STATIONS} no player</div>` : '';
  return `<div class="vt-nome">📻 ${escapeHtml(place.nome)}</div><div>${counts} · clique para abrir</div>${rows}${more}`;
}
