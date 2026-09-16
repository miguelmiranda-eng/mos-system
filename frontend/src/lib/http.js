// Shared HTTP helpers — used by hooks and module-specific lib files.

// Simple in-memory cache to prevent frontend request flooding.
const reqCache = new Map();
const reqPromises = new Map();

const handleAuthExpiry = () => {
  console.warn('[apiFetch] 401 detected — session expired');
  localStorage.removeItem('mos_user');
  window.location.href = '/';
};

// ─── In-flight request counter ───────────────────────────────────────────────
// Lets the UI show a global "system busy" indicator without each caller
// wiring up its own loading state.
let pendingCount = 0;
const busyListeners = new Set();
const notifyBusy = () => busyListeners.forEach(fn => { try { fn(pendingCount); } catch {} });
export const onHttpBusyChange = (fn) => { busyListeners.add(fn); return () => busyListeners.delete(fn); };
const bump = () => { pendingCount += 1; notifyBusy(); };
const unbump = () => { pendingCount = Math.max(0, pendingCount - 1); notifyBusy(); };

/**
 * Wrapper around fetch with:
 *  - 5s TTL cache on GET responses
 *  - Promise deduplication for concurrent identical GETs
 *  - Automatic 401 handling (redirect to login)
 *  - Cache invalidation on mutations to /orders
 *
 * Always sends `credentials: 'include'`.
 */
export const apiFetch = async (url, options = {}) => {
  const isGet = !options.method || options.method === 'GET';

  if (isGet) {
    const cacheKey = url;
    const now = Date.now();

    // 1. TTL cache (5 seconds)
    if (reqCache.has(cacheKey)) {
      const { data, timestamp } = reqCache.get(cacheKey);
      if (now - timestamp < 5000) {
        return data.clone();
      }
      reqCache.delete(cacheKey);
    }

    // 2. Promise deduplication: if same request is in-flight, reuse it
    if (reqPromises.has(cacheKey)) {
      const res = await reqPromises.get(cacheKey);
      return res.clone();
    }

    // 3. Make the actual request
    bump();
    const fetchPromise = fetch(url, { credentials: 'include', ...options }).finally(unbump);
    reqPromises.set(cacheKey, fetchPromise);

    try {
      const res = await fetchPromise;
      if (res.status === 401) {
        handleAuthExpiry();
        throw new Error('SESSION_EXPIRED');
      }

      if (res.ok) {
        reqCache.set(cacheKey, { data: res.clone(), timestamp: Date.now() });
      }
      return res;
    } finally {
      reqPromises.delete(cacheKey);
    }
  }

  // Non-GET requests (mutations) bypass cache entirely
  bump();
  let res;
  try {
    res = await fetch(url, { credentials: 'include', ...options });
  } finally {
    unbump();
  }
  if (res.status === 401) {
    handleAuthExpiry();
    throw new Error('SESSION_EXPIRED');
  }

  // Invalidate related GET caches after a mutation: the whole /orders family,
  // y en general el RECURSO de la URL mutada (los dos primeros segmentos tras
  // /api/, p. ej. /wms/location-checks/{id}/resolve → todo GET que traiga
  // /wms/location-checks). Sin esto, recargar la lista justo después de
  // escribir devolvía la copia de hasta 5 s atrás.
  const urlStr = url.toString();
  const resource = urlStr.match(/\/api(\/[^/?#]+\/[^/?#]+)/)?.[1];
  for (const key of reqCache.keys()) {
    if ((urlStr.includes('/orders') && key.includes('/orders')) || (resource && key.includes(resource))) reqCache.delete(key);
  }

  return res;
};
