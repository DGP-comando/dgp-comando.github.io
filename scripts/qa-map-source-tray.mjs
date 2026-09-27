#!/usr/bin/env node
/**
 * Focused browser proof for the responsive, accessible Map Source tray
 * (`#map-stack-chips`, src/mapStackChips.js) on the MapLibre engine.
 *
 * The tray presents the three base maps of src/maplibre/basemaps.js (Satélite
 * `esri`, `osm`, `osm-vector` — none needs a key) followed by the three
 * presentation toggles (`labels`, `globe`, `terrain`). Cesium-era ids
 * (`photoreal`, `bing-aerial`, `bing-labels`) and unknown ids in a shared link
 * land on `esri` (`normalizeStackId`).
 *
 *   npm run qa:map-source-tray                       # QA_BASE_URL or :4173
 *   node scripts/qa-map-source-tray.mjs --url http://localhost:4400 [--headful]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { DEFAULT_APP_URL, appUrl, argValue, hasFlag, launchQaBrowser } from './lib/qaBrowser.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(repoRoot, 'qa-shots', 'map-source-tray');
const baseUrl = argValue('--url', DEFAULT_APP_URL);
const headful = hasFlag('--headful');
const DEFAULT_STACK = 'esri';
fs.mkdirSync(shotsDir, { recursive: true });

const { browser, page, errors: consoleErrors } = await launchQaBrowser({
  headful,
  viewport: { width: 1000, height: 900 },
});
const failures = [];

const check = (name, passed, detail = '') => {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(name);
};

// The tray hands focus to the active tile once it has opened; under software
// GL that can take longer than one animation, so wait for it (bounded).
const waitTileFocus = () => page.waitForFunction(
  () => Boolean(document.activeElement?.dataset?.stackId),
  { timeout: 2_000 },
).catch(() => {});

const trayMetrics = () => page.evaluate(() => {
  const panel = document.getElementById('control-panel');
  const popover = document.getElementById('control-panel-popover');
  const row = document.getElementById('map-stack-chips');
  const popoverRect = popover.getBoundingClientRect();
  const chips = [...row.children].map((chip) => {
    const rect = chip.getBoundingClientRect();
    return {
      id: chip.dataset.stackId,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      pressed: chip.getAttribute('aria-pressed'),
      ariaDisabled: chip.getAttribute('aria-disabled'),
      ariaLabel: chip.getAttribute('aria-label'),
    };
  });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    pinned: panel.classList.contains('dock-pinned'),
    popover: {
      left: popoverRect.left,
      right: popoverRect.right,
      top: popoverRect.top,
      bottom: popoverRect.bottom,
      width: popoverRect.width,
    },
    columns: getComputedStyle(row).gridTemplateColumns,
    rows: new Set(chips.map((chip) => chip.top)).size,
    chips,
  };
});

try {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === appOrigin && url.pathname === '/api/openai/hud-summary') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: 'Map Source tray QA' }),
      });
      return;
    }
    request.continue();
  });
  const appOrigin = new URL(baseUrl).origin;
  await page.goto(appUrl(baseUrl), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 120_000 });
  await page.waitForFunction(
    () => document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120_000 },
  );

  const presentation = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('.map-stack-chip[data-stack-id]')].map((chip) => chip.dataset.stackId),
    toggles: [...document.querySelectorAll('.map-stack-chip[data-toggle-id]')].map((chip) => chip.dataset.toggleId),
    retiredPanel: Boolean(document.getElementById('stack-panel')),
    toggleTag: document.getElementById('control-panel-toggle')?.tagName,
    controls: document.getElementById('control-panel-toggle')?.getAttribute('aria-controls'),
  }));
  check(
    'exact three-source + three-toggle presentation; the retired left Map Stack panel is gone',
    JSON.stringify(presentation.ids) === JSON.stringify(['esri', 'osm', 'osm-vector'])
      && JSON.stringify(presentation.toggles) === JSON.stringify(['labels', 'globe', 'terrain'])
      && !presentation.retiredPanel,
    JSON.stringify(presentation),
  );
  check(
    'compact wing is a semantic disclosure',
    presentation.toggleTag === 'BUTTON' && presentation.controls === 'control-panel-popover',
    JSON.stringify(presentation),
  );

  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await waitTileFocus();
  const keyboardOpen = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
    // Diagnostic: a toggle chip (Rótulos/Globo/Relevo) also carries `.active`.
    focusedToggle: document.activeElement?.dataset?.toggleId || null,
    focusedId: document.activeElement?.id || document.activeElement?.tagName || null,
  }));
  check(
    'Enter opens the tray and hands focus to a Map Source tile',
    keyboardOpen.expanded === 'true' && keyboardOpen.activeStack === DEFAULT_STACK,
    JSON.stringify(keyboardOpen),
  );

  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.getElementById('control-panel-toggle').getAttribute('aria-expanded') === 'false',
    { timeout: 1_500 },
  ).catch(() => {});
  const keyboardClose = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeId: document.activeElement?.id || null,
  }));
  check(
    'Escape closes the tray and restores disclosure focus',
    keyboardClose.expanded === 'false' && keyboardClose.activeId === 'control-panel-toggle',
    JSON.stringify(keyboardClose),
  );

  await page.keyboard.press('Space');
  await waitTileFocus();
  const spaceOpen = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
    focusedToggle: document.activeElement?.dataset?.toggleId || null,
    focusedId: document.activeElement?.id || document.activeElement?.tagName || null,
  }));
  check(
    'Space opens the tray through the same keyboard path',
    spaceOpen.expanded === 'true' && spaceOpen.activeStack === DEFAULT_STACK,
    JSON.stringify(spaceOpen),
  );

  await page.keyboard.press('Escape');
  await page.keyboard.down('Enter');
  await new Promise((resolve) => setTimeout(resolve, 320));
  await page.keyboard.up('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await waitTileFocus();
  const longHoldRecovery = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
  }));
  check(
    'long Enter hold cannot strand the disclosure keyboard path',
    longHoldRecovery.expanded === 'true' && longHoldRecovery.activeStack === DEFAULT_STACK,
    JSON.stringify(longHoldRecovery),
  );

  // No base map needs a key any more (the Cesium ion / Google 3D sources are
  // gone): every source tile is enabled, none carries a requirement badge.
  const keyless = await page.evaluate(() => [...document.querySelectorAll('.map-stack-chip[data-stack-id]')]
    .map((chip) => ({
      id: chip.dataset.stackId,
      ariaDisabled: chip.getAttribute('aria-disabled'),
      badge: Boolean(chip.querySelector('.map-stack-chip-req')),
    })));
  check(
    'every base-map source is available without a key',
    keyless.length === 3 && keyless.every((chip) => chip.ariaDisabled === 'false' && !chip.badge),
    JSON.stringify(keyless),
  );

  // The toggles flip their pressed state from controller truth and back.
  const toggleRoundTrip = await page.evaluate(async () => {
    const chip = document.querySelector('.map-stack-chip[data-toggle-id="labels"]');
    const before = chip.getAttribute('aria-pressed');
    chip.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const flipped = document.querySelector('.map-stack-chip[data-toggle-id="labels"]').getAttribute('aria-pressed');
    document.querySelector('.map-stack-chip[data-toggle-id="labels"]').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const restored = document.querySelector('.map-stack-chip[data-toggle-id="labels"]').getAttribute('aria-pressed');
    return { before, flipped, restored };
  });
  check(
    'the satellite-labels toggle flips aria-pressed and restores it',
    toggleRoundTrip.before !== toggleRoundTrip.flipped && toggleRoundTrip.restored === toggleRoundTrip.before,
    JSON.stringify(toggleRoundTrip),
  );

  const switching = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const controller = styleManager.mapStackController;
    const originalSetStack = controller.setStack.bind(controller);
    const before = controller.getActiveId();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    controller.setStack = async (stackId) => {
      await gate;
      return originalSetStack(stackId);
    };
    const switchPromise = styleManager._setMapStack('osm', { syncShare: false });
    const during = {
      status: document.getElementById('map-stack-status').textContent,
      active: [...document.querySelectorAll('.map-stack-chip[data-stack-id]')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    };
    release();
    // Bounded: a switch whose promise never settles must FAIL, not hang the run.
    const settled = await Promise.race([
      switchPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    const after = {
      settled,
      status: document.getElementById('map-stack-status').textContent,
      active: [...document.querySelectorAll('.map-stack-chip[data-stack-id]')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    };
    controller.setStack = originalSetStack;
    await Promise.race([
      styleManager._setMapStack(before, { syncShare: false }),
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
    return { before, during, after };
  });
  check(
    'switching feedback is truthful and active state moves only after commit',
    switching.after.settled
      && switching.during.status === '...'
      && JSON.stringify(switching.during.active) === JSON.stringify([switching.before])
      && JSON.stringify(switching.after.active) === JSON.stringify(['osm']),
    JSON.stringify(switching),
  );

  // The ACQUIRING notice shares the global status line with layer/tile
  // loading feedback; start from a quiet line so only this lifecycle shows.
  await page.waitForFunction(
    () => document.getElementById('global-loading-status')?.hidden === true,
    { timeout: 60_000 },
  ).catch(() => {});
  const acquiringLifecycle = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const status = document.getElementById('global-loading-status');
    const snapshot = () => ({
      hidden: status.hidden,
      state: status.dataset.state || null,
      label: document.getElementById('global-loading-label').textContent.trim(),
      detail: document.getElementById('global-loading-detail').textContent.trim(),
    });
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'pending',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const pending = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'followed',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    const followed = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'pending',
      layerId: 'military',
      targetId: 'qa-military',
      label: 'military flight',
    });
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'source-unavailable',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const staleTerminal = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'cancelled',
      layerId: 'military',
      targetId: 'qa-military',
      label: 'military flight',
    });
    const cancelled = snapshot();
    return { pending, followed, staleTerminal, cancelled };
  });
  check(
    'ACQUIRING DOM notice persists, ignores stale terminals, and clears on ownership completion',
    acquiringLifecycle.pending.hidden === false
      && acquiringLifecycle.pending.state === 'acquiring'
      && acquiringLifecycle.pending.label === 'ACQUIRING'
      && acquiringLifecycle.pending.detail === 'SHARED FLIGHT'
      && acquiringLifecycle.followed.hidden === true
      && acquiringLifecycle.staleTerminal.hidden === false
      && acquiringLifecycle.staleTerminal.state === 'acquiring'
      && acquiringLifecycle.staleTerminal.detail === 'SHARED MILITARY FLIGHT'
      && acquiringLifecycle.cancelled.hidden === true,
    JSON.stringify(acquiringLifecycle),
  );

  const acquiringFailureArbitration = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const dataManager = styleManager._dataManager;
    const status = document.getElementById('global-loading-status');
    const originalGetAll = dataManager.getAll;
    const snapshot = () => ({
      hidden: status.hidden,
      state: status.dataset.state || null,
      label: document.getElementById('global-loading-label').textContent.trim(),
      detail: document.getElementById('global-loading-detail').textContent.trim(),
    });
    const waitForQueuedNotice = async (label, timeoutMs = 1000) => {
      const deadline = performance.now() + timeoutMs;
      while (styleManager._globalStatusNotice?.label !== label
          && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      return styleManager._globalStatusNotice?.label === label;
    };
    const baseNow = performance.now();
    try {
      styleManager._loadingFeedbackState = {
        phase: 'idle', visible: false, startedAt: 0, showAt: 0, hideAt: 0,
        activeIds: [], batchOutcome: null, terminal: null, operation: null,
      };
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'pending',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
      dataManager.getAll = () => [{
        id: 'qa-unrelated-layer',
        name: 'QA unrelated layer',
        lifecycleState: 'enabling',
        enabled: false,
        stats: {},
      }];
      styleManager._updateGlobalLoadingFeedback(baseNow);
      styleManager._updateGlobalLoadingFeedback(baseNow + 200);
      dataManager.getAll = () => [];
      styleManager._loadingFeedbackEvent = {
        type: 'visibility-failed',
        layerId: 'qa-unrelated-layer',
        error: new Error('QA offline'),
      };
      styleManager._updateGlobalLoadingFeedback(baseNow + 300);
      const failureStart = snapshot();
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'source-unavailable',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
      const queuedNoticeReady = await waitForQueuedNotice(
        'Shared flight could not be restored — feed unavailable',
      );
      const shareFailureQueued = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 5299);
      const failureEnd = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 5300);
      const shareFailureStart = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 10299);
      const shareFailureEnd = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 10300);
      const settled = snapshot();
      return {
        failureStart,
        queuedNoticeReady,
        shareFailureQueued,
        failureEnd,
        shareFailureStart,
        shareFailureEnd,
        settled,
      };
    } finally {
      dataManager.getAll = originalGetAll;
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'cancelled',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
    }
  });
  check(
    'manager failure then queued share failure each receives its full visible dwell',
    acquiringFailureArbitration.failureStart.hidden === false
      && acquiringFailureArbitration.failureStart.state === 'error'
      && acquiringFailureArbitration.failureStart.label === 'LOAD FAILED'
      && acquiringFailureArbitration.queuedNoticeReady === true
      && acquiringFailureArbitration.shareFailureQueued.state === 'error'
      && acquiringFailureArbitration.shareFailureQueued.label === 'LOAD FAILED'
      && acquiringFailureArbitration.failureEnd.state === 'error'
      && acquiringFailureArbitration.failureEnd.label === 'LOAD FAILED'
      && acquiringFailureArbitration.shareFailureStart.state === 'error'
      && acquiringFailureArbitration.shareFailureStart.label === 'Shared flight could not be restored — feed unavailable'
      && acquiringFailureArbitration.shareFailureEnd.label === 'Shared flight could not be restored — feed unavailable'
      && acquiringFailureArbitration.settled.hidden === true,
    JSON.stringify(acquiringFailureArbitration),
  );

  // Unpinned mouse-away dismissal AFTER a tile click. Chromium focuses a
  // <button> on mouse press, so a close-guard reading plain
  // `document.activeElement` left the tray permanently open once Map Source
  // moved into it — switch a basemap and the popover never went away again
  // (field report). The pin samples the exact mechanism: focus IS parked
  // inside the panel and is NOT `:focus-visible`, and the tray closes anyway.
  const setControlPanelPinned = (wanted) => page.evaluate((want) => {
    const panel = document.getElementById('control-panel');
    if (panel.classList.contains('dock-pinned') !== want) {
      document.querySelector('.dock-pin-btn[data-pin-target="control-panel"]').click();
    }
    return panel.classList.contains('dock-pinned');
  }, wanted);
  const readTrayState = () => page.evaluate(() => {
    const panel = document.getElementById('control-panel');
    const active = document.activeElement;
    let focusVisible = null;
    try { focusVisible = active?.matches?.(':focus-visible') ?? null; } catch { focusVisible = null; }
    return {
      collapsed: panel.classList.contains('collapsed'),
      expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
      focusInside: panel.contains(active),
      focusVisible,
    };
  });
  const clickTileThenLeave = async (stackId) => {
    await page.evaluate(() => window.__godsEyeView.styleManager
      .setPanelCollapsed('control-panel', false, { explicit: true }));
    await new Promise((resolve) => setTimeout(resolve, 240));
    await page.click(`[data-stack-id="${stackId}"]`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterClick = await readTrayState();
    await page.mouse.move(20, 20); // leave the dock entirely → pointerleave
    // Past the 420 ms unpinned close delay with room for a slow frame.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { afterClick, afterLeave: await readTrayState() };
  };

  // The OTHER half of the same rule, asserted positively: a KEYBOARD user who
  // tabbed to a tile and pressed Enter must keep the tray, because closing it
  // out from under them would strand the caret in a hidden surface. Same
  // mouse-away that dismisses after a click, opposite outcome — so a fix that
  // simply deleted the focus guard would fail here.
  await setControlPanelPinned(false);
  await page.evaluate(() => window.__godsEyeView.styleManager
    .setPanelCollapsed('control-panel', true, { explicit: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter'); // opens and hands focus to the active tile
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.keyboard.press('Tab'); // tab ONTO a tile, keyboard modality
  await page.keyboard.press('Enter'); // activate it from the keyboard
  await new Promise((resolve) => setTimeout(resolve, 200));
  const keyboardAfterActivate = await page.evaluate(() => ({
    focusedStack: document.activeElement?.dataset?.stackId || null,
    isChip: !!document.activeElement?.classList?.contains('map-stack-chip'),
  }));
  // Enter the tray with the pointer and leave again, so a real pointerleave
  // schedules the close this pin expects to be declined.
  const chipPoint = await page.$eval('#map-stack-chips .map-stack-chip', (chip) => {
    const rect = chip.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(chipPoint.x, chipPoint.y);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await page.mouse.move(20, 20);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const keyboardHold = await readTrayState();
  check(
    'keyboard activation of a tile HOLDS the tray open through the same mouse-away',
    keyboardAfterActivate.isChip === true
      && keyboardHold.collapsed === false
      && keyboardHold.expanded === 'true'
      && keyboardHold.focusInside === true
      && keyboardHold.focusVisible === true,
    JSON.stringify({ keyboardAfterActivate, keyboardHold }),
  );

  await setControlPanelPinned(false);
  // A tile OTHER than the one the keyboard test just focused (Tab from the
  // active tile lands on `osm`): clicking the already-focused tile would keep
  // its keyboard focus ring and prove nothing about mouse modality.
  const dismissAfterTileClick = await clickTileThenLeave('osm-vector');
  const pinnedForHold = await setControlPanelPinned(true);
  const pinnedHold = await clickTileThenLeave(DEFAULT_STACK);
  await setControlPanelPinned(false);
  await page.evaluate((id) => {
    void window.__godsEyeView.styleManager._setMapStack(id, { syncShare: false });
  }, DEFAULT_STACK);
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Hand the tray back OPEN and unpinned — the responsive block below starts by
  // clicking the pin control, which is only hittable while the tray is showing.
  await page.evaluate(() => window.__godsEyeView.styleManager
    .setPanelCollapsed('control-panel', false, { explicit: true }));
  await new Promise((resolve) => setTimeout(resolve, 240));
  check(
    'a tile click does not exempt the unpinned tray from mouse-away auto-dismiss',
    dismissAfterTileClick.afterClick.collapsed === false
      && dismissAfterTileClick.afterClick.focusInside === true
      && dismissAfterTileClick.afterClick.focusVisible === false
      && dismissAfterTileClick.afterLeave.collapsed === true
      && dismissAfterTileClick.afterLeave.expanded === 'false'
      && pinnedForHold === true
      && pinnedHold.afterLeave.collapsed === false,
    JSON.stringify({ dismissAfterTileClick, pinnedForHold, pinnedHold }),
  );

  // The pointer was parked outside the dock; under a slow software-GL host the
  // unpinned tray can still be mid-transition. Wait until the pin control is
  // actually hittable before the real click.
  // Park the pointer on the tray's own toggle so the unpinned close timer
  // cannot fire, re-open explicitly and wait until the pin is laid out.
  const togglePoint = await page.$eval('#control-panel-toggle', (toggle) => {
    const rect = toggle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(togglePoint.x, togglePoint.y);
  await page.evaluate(() => window.__godsEyeView.styleManager
    .setPanelCollapsed('control-panel', false, { explicit: true }));
  await page.waitForSelector('.dock-pin-btn[data-pin-target="control-panel"]', { visible: true, timeout: 5_000 })
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.click('.dock-pin-btn[data-pin-target="control-panel"]');
  const desktop = await trayMetrics();
  check(
    'desktop tray is two rows (sources, then toggles) and fully inside the viewport',
    desktop.rows === 2
      && desktop.popover.left >= 0
      && desktop.popover.right <= desktop.viewport.width,
    JSON.stringify(desktop),
  );

  await page.setViewport({ width: 620, height: 900, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const at620 = await trayMetrics();
  check(
    '620 px tray wraps (≤3 rows) without clipping',
    at620.expanded === 'true'
      && at620.pinned
      && at620.rows >= 2 && at620.rows <= 3
      && at620.popover.left >= 0
      && at620.popover.right <= at620.viewport.width,
    JSON.stringify(at620),
  );

  await page.setViewport({ width: 480, height: 900, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const at480 = await trayMetrics();
  const allRectsInside = at480.chips.every((chip) => (
    chip.left >= 0 && chip.right <= at480.viewport.width
      && chip.top >= 0 && chip.bottom <= at480.viewport.height
  ));
  check(
    '480 px live resize keeps the open tray and every tile in bounds',
    at480.expanded === 'true'
      && at480.pinned
      && at480.rows >= 2 && at480.rows <= 3
      && at480.popover.left >= 0
      && at480.popover.right <= at480.viewport.width
      && allRectsInside,
    JSON.stringify(at480),
  );
  await page.screenshot({ path: path.join(shotsDir, '480-open.png') });

  await page.click('.dock-pin-btn[data-pin-target="control-panel"]');
  await page.click('#control-panel-toggle');
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const toggleRect = await page.$eval('#control-panel-toggle', (toggle) => {
    const rect = toggle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.touchscreen.tap(toggleRect.x, toggleRect.y);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const touchOpen = await page.$eval('#control-panel-toggle', (toggle) => toggle.getAttribute('aria-expanded'));
  check('coarse-pointer tap opens the compact wing', touchOpen === 'true', `aria-expanded=${touchOpen}`);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // Cesium-era and unknown stack ids take the SAME path: `normalizeStackId()`
  // maps `photoreal` / `bing-aerial` / `bing-labels` (and anything it does not
  // know, like the long-retired `bing-road`) to the default Satélite map, with
  // that tile lit — never a hidden source whose status reads something else.
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  for (const legacyId of ['photoreal', 'bing-aerial', 'bing-road', 'garbage']) {
    await page.goto(appUrl(baseUrl, { hash: `v=2&lat=-25.43&lon=-49.27&map=${legacyId}` }), {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 120_000 });
    await page.waitForFunction(
      () => document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 120_000 },
    );
    await page.waitForFunction(
      () => window.__godsEyeView.styleManager.mapStackController.getState()?.status !== 'switching',
      { timeout: 20_000 },
    ).catch(() => {});
    const restored = await page.evaluate(() => ({
      activeId: window.__godsEyeView.styleManager.mapStackController.getActiveId(),
      lastError: window.__godsEyeView.styleManager.mapStackController.getState()?.lastError || null,
      status: document.getElementById('map-stack-status').textContent.trim(),
      pressed: [...document.querySelectorAll('.map-stack-chip[data-stack-id]')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    }));
    check(
      `a map=${legacyId} link restores to ${DEFAULT_STACK} with the ${DEFAULT_STACK} tile lit`,
      restored.activeId === DEFAULT_STACK
        && restored.lastError === null
        && JSON.stringify(restored.pressed) === JSON.stringify([DEFAULT_STACK]),
      JSON.stringify(restored),
    );
    await page.screenshot({ path: path.join(shotsDir, `legacy-${legacyId}.png`) });
  }

  check('no new page or console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nMap Source tray QA failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nMap Source tray QA passed.');
}
