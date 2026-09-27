// src/data/localInfraLabels.js
//
// Rótulos e cards das camadas de infraestrutura local (datacenters, barragens),
// sem Cesium: título, linha de detalhe e prioridade a partir das propriedades
// GeoJSON já "planas". Movido de localGeojson.js para o protótipo MapLibre
// reaproveitar a MESMA regra (localGeojson.js importa daqui).

/**
 * Card (título + detalhes) de uma feição de propriedades planas.
 * @param {object} props Propriedades GeoJSON (sem Cesium Property).
 * @param {string} layerId Id da camada local.
 * @returns {{title:string,details:string[]}}
 */
export function localInfrastructureCopyFromPlain(props, layerId) {
  props = props || {};
  const tags = props.tags || {};
  const title = featureLabelFromProperties(props, layerId);
  const details = [];

  if (layerId === 'local-datacenters') {
    const operator = firstClean([
      tags.operator,
      props.operator,
      tags['operator:short'],
    ]);
    const capacity = firstClean([
      tags['capacity:it_load'],
      tags.it_load,
      tags.capacity,
      props.capacity,
    ]);
    const line = [operator, capacity]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .filter((value) => value.toLocaleLowerCase() !== title.toLocaleLowerCase())
      .join(' · ');
    if (line) details.push(clampCardLine(line));
  } else if (layerId === 'local-dams') {
    const river = firstClean([
      tags.associated_river,
      props.associated_river,
      tags.river,
      props.river,
      tags['river:name'],
    ]);
    if (river && river.toLocaleLowerCase() !== title.toLocaleLowerCase()) {
      details.push(clampCardLine(river));
    }
  }

  return { title, details };
}

export function featureLabelFromProperties(props, layerId) {
  const tags = props.tags || {};

  const candidates = [
    props.name,
    tags.name,
    tags['name:en'],
    tags.official_name,
    tags.operator,
    tags['operator:short'],
    props.operator,
    props.output ? `${layerTitle(layerId)} ${props.output}` : '',
    props.osm_id ? `${layerTitle(layerId)} ${props.osm_id}` : '',
  ];

  const text = candidates.map(cleanLabel).find(Boolean);
  return clampLabel(text || layerTitle(layerId));
}

export function labelPriorityFromProperties(props, layerId) {
  const tags = props.tags || {};

  let score = 0;
  if (cleanLabel(props.name) || cleanLabel(tags.name)) score += 1000;
  if (cleanLabel(tags['name:en'])) score += 700;
  if (cleanLabel(tags.operator) || cleanLabel(props.operator)) score += 180;
  if (props.output || tags['plant:output:electricity']) score += 120;
  if (layerId === 'local-dams') score += 80;
  if (layerId === 'local-datacenters') score += 60;
  return score;
}

export function cleanLabel(value) {
  const text = String(value || '').trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  return text;
}

function firstClean(values) {
  return values.map(cleanLabel).find(Boolean) || '';
}

function clampLabel(value) {
  const text = cleanLabel(value);
  return text.length > 34 ? `${text.slice(0, 31)}...` : text;
}

function clampCardLine(value) {
  const text = cleanLabel(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

export function layerTitle(layerId) {
  if (layerId === 'local-datacenters') return 'Datacenter';
  if (layerId === 'local-dams') return 'Dam';
  return 'Feature';
}
