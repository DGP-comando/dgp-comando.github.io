/**
 * Registra o service worker do PWA (public/sw.js). Só em build de produção:
 * no dev server o cache atrapalharia o HMR e os proxies locais.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] falha ao registrar o service worker:', err);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
