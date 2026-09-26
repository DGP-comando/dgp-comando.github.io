/**
 * Lazily create the shared white contact pip used by aircraft layers while the
 * cockpit is active. The pip is white so the owning layer tints it with its
 * provenance color (civilian cyan-white, military amber) without separate
 * assets. MapLibre: register it once with
 * `map.addImage(COCKPIT_CONTACT_DOT_ID, cockpitContactDotImageData())` and
 * tint per feature with `icon-color` only if the layer adds it as SDF; a
 * plain RGBA image keeps its own white.
 *
 * @returns {string} One stable data-URL identity shared by every billboard.
 */
export function cockpitContactDotImage() {
  if (cockpitContactDotImage._dataUrl) return cockpitContactDotImage._dataUrl;

  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 16, 16);

  // Match the visor's fine-line symbology: a restrained luminous ring with a
  // crisp center fix, rather than a solid map-marker blob. The layer tint
  // supplies civilian cyan-white or military amber provenance.
  ctx.save();
  ctx.shadowBlur = 2.5;
  ctx.shadowColor = 'rgba(255, 255, 255, 0.55)';
  ctx.beginPath();
  ctx.arc(8, 8, 4.25, 0, Math.PI * 2);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.stroke();
  ctx.shadowBlur = 1.5;
  ctx.beginPath();
  ctx.arc(8, 8, 1.55, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
  ctx.fill();
  ctx.restore();

  // A stable URL is keyed once and shared by the entire fleet (renderers that
  // key textures by source identity upload it a single time).
  cockpitContactDotImage._dataUrl = canvas.toDataURL('image/png');
  return cockpitContactDotImage._dataUrl;
}

cockpitContactDotImage._dataUrl = null;

/** Image id sugerido para o pip no sprite do MapLibre. */
export const COCKPIT_CONTACT_DOT_ID = 'dg-cockpit-contact-dot';

/**
 * The same pip as ImageData (16×16 RGBA), for `map.addImage`.
 * @returns {ImageData|null} Null where no 2D canvas is available.
 */
export function cockpitContactDotImageData() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.shadowBlur = 2.5;
  ctx.shadowColor = 'rgba(255, 255, 255, 0.55)';
  ctx.beginPath();
  ctx.arc(8, 8, 4.25, 0, Math.PI * 2);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.stroke();
  ctx.shadowBlur = 1.5;
  ctx.beginPath();
  ctx.arc(8, 8, 1.55, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
  ctx.fill();
  return ctx.getImageData(0, 0, 16, 16);
}
