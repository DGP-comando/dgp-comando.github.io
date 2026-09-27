#!/usr/bin/env node
/**
 * qa-cables-shot — capture the submarine-cables layer at two fixed cameras for
 * before/after visual-identity comparison. Writes to gitignored qa-shots/.
 * Usage: node scripts/qa-cables-shot.mjs [--url http://localhost:4400] [--tag before]
 */
import { mkdirSync } from 'node:fs';
import {
  DEFAULT_APP_URL, argValue, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', DEFAULT_APP_URL);
const tag = argValue('--tag', 'shot');
const LAYER_ID = 'telegeography-submarine-cables';
mkdirSync(new URL('../qa-shots', import.meta.url), { recursive: true });

const { browser, page } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });
try {
  await openApp(page, url);
  await page.evaluate(async (layerId) => {
    const gev = window.__godsEyeView;
    gev.engine.cancelFlight();
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled && id !== layerId) {
        try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* shot only */ }
      }
    }
    await gev.dataManager.setEnabled(layerId, true, { origin: 'user' });
  }, LAYER_ID);

  const views = [
    { name: 'atlantic', lon: -40, lat: 35, alt: 4_500_000 },
    { name: 'ny-coast', lon: -73.5, lat: 40.4, alt: 500_000 },
  ];
  for (const view of views) {
    await setCamera(page, view);
    await waitMapIdle(page);
    await sleep(1_000);
    const path = new URL(`../qa-shots/cables-${tag}-${view.name}.png`, import.meta.url).pathname;
    await page.screenshot({ path });
    console.log(`saved ${path}`);
  }
} finally {
  await browser.close();
}
