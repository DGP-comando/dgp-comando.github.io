// MAP STACK source chips — the always-visible replacement for the `<select>`
// that used to sit in the Map Stack panel. One button per stack, rendered from
// `MapStackController.getStacks()`. The three accepted sources below (the
// MapLibre basemaps: Satélite, OSM, OSM vetorial) are the whole shipped set;
// keeping the allowlist explicit means a stack added to `MAP_STACKS` for
// internal use cannot reach the tray until someone names it here.
//
// After the sources come the presentation TOGGLES (rótulos, globo/2D, relevo
// 3D): same chip look, `data-toggle-id` instead of `data-stack-id`, lit when on.
//
// The chips are a control SURFACE only: selecting one calls back into the same
// `_setMapStack()` path the dropdown's `change` handler used, and the active
// state is re-synced from controller state (never optimistically), so a failed
// or superseded switch still leaves the truly-active stack lit.

export const MAP_STACK_CHIP_CLASS = 'map-stack-chip';
export const PRESENTED_MAP_STACK_IDS = Object.freeze([
  'esri',
  'osm',
  'osm-vector',
]);
export const MAP_TOGGLE_CHIP_CLASS = 'map-stack-toggle';

/**
 * Presentation model for one map-stack chip.
 *
 * Unavailable is NOT the same as needs-an-ion-token: `photoreal` is unavailable
 * whenever the Google tileset failed to load (the startup fallback-to-OSM
 * case), and a future stack may have its own reason. The ION badge is therefore
 * gated on the stack's own `requiresIon` flag, and the tooltip quotes the
 * controller's `unavailableReason` rather than assuming one.
 * @param {{id: string, label: string, available?: boolean, requiresIon?: boolean, unavailableReason?: string|null}} stack - Stack descriptor from `getStacks()`.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {{id: string, label: string, available: boolean, active: boolean, requiresIon: boolean, requirement: string, unavailableHint: string, title: string}}
 */
export function mapStackChipModel(stack, activeId) {
  const available = stack?.available !== false;
  const label = String(stack?.label ?? stack?.id ?? '');
  const requiresIon = stack?.requiresIon === true;
  const fallbackReason = requiresIon
    ? 'Chave necessária'
    : `${label || 'Este mapa base'} indisponível`;
  const unavailableHint = available ? '' : String(stack?.unavailableReason || fallbackReason);
  return {
    id: String(stack?.id ?? ''),
    label,
    available,
    active: !!stack?.id && stack.id === activeId,
    requiresIon,
    // Dropdown parity: unavailable options read "<label> · ion key". A chip has
    // no room for that, so an ion-backed stack gets a compact badge; every
    // unavailable chip carries the real reason in its tooltip.
    requirement: !available && requiresIon ? 'ION' : '',
    unavailableHint,
    title: available ? label : unavailableHint,
  };
}

/**
 * @param {Array<object>} stacks - `MapStackController.getStacks()` output.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {Array<object>} One chip model per approved presentation id, in
 *   `PRESENTED_MAP_STACK_IDS` order; internal and future stacks stay hidden.
 */
export function mapStackChipModels(stacks, activeId) {
  const stacksById = new Map((Array.isArray(stacks) ? stacks : [])
    .map((stack) => [stack?.id, stack]));
  return PRESENTED_MAP_STACK_IDS
    .map((id) => stacksById.get(id))
    .filter(Boolean)
    .map((stack) => mapStackChipModel(stack, activeId))
    // DataGeo: so stacks DISPONIVEIS viram chip. Um chip desabilitado de
    // Google/Bing num deploy keyless e ruido sem acao possivel — quem
    // configurar as chaves passa a ver os stacks correspondentes aparecerem.
    .filter((model) => model.available);
}

/**
 * Renders the chip row into `container`, replacing any previous chips.
 * @param {HTMLElement} container - Row element.
 * @param {Array<object>} stacks - `MapStackController.getStacks()` output.
 * @param {object} [options]
 * @param {string|null} [options.activeId] - Currently active stack id.
 * @param {(stackId: string) => void} [options.onSelect] - Selection callback.
 * @param {Array<{id: string, label: string, title?: string, active?: boolean, available?: boolean, onToggle?: (on: boolean) => void}>} [options.toggles]
 *   Presentation toggles rendered after the sources (rótulos, globo/2D, relevo).
 * @param {Document} [options.doc] - Document override (tests).
 * @returns {Array<object>} The rendered chip models.
 */
export function renderMapStackChips(container, stacks, { activeId = null, onSelect = null, toggles = [], doc } = {}) {
  if (!container) return [];
  const ownerDoc = doc || container.ownerDocument || globalThis.document;
  if (!ownerDoc?.createElement) return [];

  container.innerHTML = '';
  const models = mapStackChipModels(stacks, activeId);

  for (const model of models) {
    const chip = ownerDoc.createElement('button');
    chip.type = 'button';
    chip.className = [
      MAP_STACK_CHIP_CLASS,
      model.active ? 'active' : '',
      model.available ? '' : 'unavailable',
    ].filter(Boolean).join(' ');
    chip.dataset.stackId = model.id;
    chip.title = model.title;
    chip.setAttribute('aria-pressed', String(model.active));
    chip.setAttribute('aria-disabled', String(!model.available));
    if (!model.available) {
      chip.setAttribute('aria-label', `${model.label} unavailable: ${model.unavailableHint}`);
    }

    const label = ownerDoc.createElement('span');
    label.className = 'map-stack-chip-label';
    label.textContent = model.label;
    chip.appendChild(label);

    if (model.requirement) {
      const requirement = ownerDoc.createElement('span');
      requirement.className = 'map-stack-chip-req';
      requirement.textContent = model.requirement;
      chip.appendChild(requirement);
    }

    chip.addEventListener('click', () => {
      if (!model.available) return;
      onSelect?.(model.id);
    });
    container.appendChild(chip);
  }

  for (const toggle of Array.isArray(toggles) ? toggles : []) {
    if (!toggle?.id) continue;
    const available = toggle.available !== false;
    const active = !!toggle.active;
    const chip = ownerDoc.createElement('button');
    chip.type = 'button';
    chip.className = [
      MAP_STACK_CHIP_CLASS,
      MAP_TOGGLE_CHIP_CLASS,
      active ? 'active' : '',
      available ? '' : 'unavailable',
    ].filter(Boolean).join(' ');
    chip.dataset.toggleId = String(toggle.id);
    chip.title = String(toggle.title || toggle.label || toggle.id);
    chip.setAttribute('aria-pressed', String(active));
    chip.setAttribute('aria-disabled', String(!available));
    const label = ownerDoc.createElement('span');
    label.className = 'map-stack-chip-label';
    label.textContent = String(toggle.label || toggle.id);
    chip.appendChild(label);
    chip.addEventListener('click', () => {
      if (chip.getAttribute('aria-disabled') === 'true') return;
      const next = chip.getAttribute('aria-pressed') !== 'true';
      toggle.onToggle?.(next);
    });
    container.appendChild(chip);
  }

  return models;
}

/**
 * Re-points the active chip at controller state. Availability never changes at
 * runtime (it tracks the ion token), so only the active/pressed pair is synced.
 * Toggle chips follow `toggleState` ({[toggleId]: {active, available}}) when
 * given.
 * @param {HTMLElement} container - Row element.
 * @param {string|null} activeId - Currently active stack id.
 * @param {Record<string, {active?: boolean, available?: boolean}>} [toggleState]
 * @returns {void}
 */
export function syncMapStackChips(container, activeId, toggleState = null) {
  const chips = container?.children;
  if (!chips) return;
  for (const chip of Array.from(chips)) {
    const toggleId = chip?.dataset?.toggleId;
    if (toggleId) {
      const entry = toggleState?.[toggleId];
      if (!entry) continue;
      if (typeof entry.active === 'boolean') {
        chip.classList?.toggle('active', entry.active);
        chip.setAttribute?.('aria-pressed', String(entry.active));
      }
      if (typeof entry.available === 'boolean') {
        chip.classList?.toggle('unavailable', !entry.available);
        chip.setAttribute?.('aria-disabled', String(!entry.available));
      }
      continue;
    }
    const stackId = chip?.dataset?.stackId;
    if (!stackId) continue;
    const active = stackId === activeId;
    chip.classList?.toggle('active', active);
    chip.setAttribute?.('aria-pressed', String(active));
  }
}
