import { createContext, useContext, useState, useEffect } from "react";
import { toast } from "sonner";
import { apiFetch, onHttpBusyChange } from "../../lib/http";

// True while any HTTP request is in flight. Lets components show a busy hint.
export const useHttpBusy = () => {
  const [busy, setBusy] = useState(false);
  useEffect(() => onHttpBusyChange(count => setBusy(count > 0)), []);
  return busy;
};

// ─── API constants ───────────────────────────────────────────────────────────
export const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
export const AUTH_API = `${process.env.REACT_APP_BACKEND_URL}/api/auth`;

// ─── HTTP helpers (use apiFetch → TTL cache + dedup + 401 handling) ─────────
// Default behavior: parse JSON, reject on !ok. Mutations (poster/putter) return
// the raw Response so callers can branch on res.ok and read errors.
export const fetcher = (url, options = {}) => {
  if (options.method && options.method !== 'GET' && options.body && !options.headers) {
    options.headers = { 'Content-Type': 'application/json' };
  }
  return apiFetch(`${API}${url}`, options).then(r => r.ok ? r.json() : Promise.reject(r));
};
export const poster = (url, body) => apiFetch(`${API}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const putter = (url, body) => apiFetch(`${API}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const deleter = (url) => apiFetch(`${API}${url}`, { method: 'DELETE' }).then(r => r.ok ? r.json() : Promise.reject(r));

// ─── Scanner input sanitizer ────────────────────────────────────────────────
// Some handheld scanners are configured with a preamble/prefix (e.g. "%-") or
// transmit an AIM symbology identifier before the payload. The label barcodes
// themselves are clean Code128 of the raw name/LPN, so we strip any leading
// non-alphanumeric junk before matching. Safe: every location/LPN/SKU starts
// with a letter or digit (RP10-A26, CARRO 1, BOX-000143, style 2000…).
// Only the leading prefix is removed; interior dashes/spaces (e.g. "CARRO 1")
// are preserved, and trailing whitespace is trimmed.
export const cleanScan = (raw) => (raw || "").toUpperCase().replace(/^[^A-Z0-9]+/, "").trimEnd();

// ─── Feedback de escaneo (compartido por todos los flujos que escanean caja) ─
// El operador mira la caja, no la pantalla: un aviso solo visual se pierde.
// Beep con WebAudio (no requiere archivo) + vibración donde exista.
//   ok   → un tono agudo corto
//   dup  → DOS tonos medios (distinto de error, para que se reconozca de oído)
//   error→ tono grave largo
const SCAN_TONES = {
  ok:    { pattern: [[880, 0.12]],                 vibrate: 60 },
  dup:   { pattern: [[440, 0.10], [440, 0.10]],    vibrate: [60, 40, 60] },
  error: { pattern: [[200, 0.35]],                 vibrate: [120, 60, 120] },
};
export const scanFeedback = (kind = 'ok') => {
  const tone = SCAN_TONES[kind] || SCAN_TONES.ok;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      let at = ctx.currentTime;
      tone.pattern.forEach(([hz, secs], i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = hz;
        gain.gain.value = 0.08;
        osc.start(at);
        osc.stop(at + secs);
        if (i === tone.pattern.length - 1) osc.onended = () => ctx.close();
        at += secs + 0.06;
      });
    }
  } catch { /* sin audio no pasa nada */ }
  try { if (navigator.vibrate) navigator.vibrate(tone.vibrate); } catch { /* idem */ }
};

// Caja escaneada por segunda vez en el mismo flujo. REGLA: nunca se procesa
// dos veces ni se deselecciona en silencio — se avisa igual en todos los
// módulos (mismo texto, mismo color, mismo sonido). `t` es el traductor del
// módulo que llama; el mensaje vive en i18n (`wms_scan_duplicate`).
// Con `onRemove`, el aviso pregunta "¿seguro que quieres removerla?" y ofrece
// el botón Quitar: re-escanear NUNCA quita por sí solo (los muchachos le dan
// vuelta a la tarima y vuelven a escanear), pero quitar queda a un toque.
export const duplicateScan = (t, box, onRemove) => {
  toast.warning(t('wms_scan_duplicate', { box }), onRemove ? {
    description: t('wms_scan_duplicate_ask'),
    action: { label: t('wms_remove'), onClick: onRemove },
    duration: 6000,
  } : undefined);
  scanFeedback('dup');
};

// Resumen vivo de una ubicación: cajas con piezas y unidades. Para que al
// escanear un destino se vea "N cajas · M unidades" y el operador confirme que
// movió lo correcto. Solo cuenta cajas con units > 0 (las depleted son
// residuo del FIFO viejo) y exige coincidencia EXACTA del nombre (el endpoint
// hace substring: "CARRO 1" trae "CARRO 10").
export const summarizeBoxes = (boxes, name) => {
  const up = (name || '').toUpperCase();
  const live = (boxes || []).filter(b => (b.units ?? b.qty ?? 0) > 0 && (b.location || '').toUpperCase() === up);
  return { boxes: live.length, units: live.reduce((s, b) => s + (b.units ?? b.qty ?? 0), 0) };
};
export const useLocationSummary = (name) => {
  const [summary, setSummary] = useState(null); // null = sin ubicación / cargando
  useEffect(() => {
    const clean = (name || '').trim();
    if (!clean) { setSummary(null); return undefined; }
    let alive = true;
    setSummary(null);
    fetcher(`/boxes?location=${encodeURIComponent(clean)}`)
      .then(boxes => { if (alive) setSummary(summarizeBoxes(boxes, clean)); })
      .catch(() => { if (alive) setSummary({ boxes: 0, units: 0, error: true }); });
    return () => { alive = false; };
  }, [name]);
  return summary;
};

// ─── Error helpers — replace silent `catch {}` patterns ─────────────────────
export const logLoadError = (what) => (err) => console.error(`[WMS] Failed to load ${what}:`, err);
export const toastActionError = (what) => (err) => { console.error(`[WMS] ${what} failed:`, err); toast.error(`No se pudo ${what}`); };

// ─── Shared constants ───────────────────────────────────────────────────────
// Notación canónica ÚNICA del sistema: tallas grandes como 2X/3X/4X/5X (NO 2XL).
// Es la forma que se guarda en Mongo Y la que se muestra en todo selector. Los
// importadores (SIZES_MAP en import_router.py) normalizan cualquier variante
// (2XL, XXL, "2 XL") a esta forma.
export const SIZES_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X'];
// Youth sizes. Kept separate so adult pick tickets are never shown youth rows
// (operators would get confused). The picking grid only switches to these when
// the selected style's inventory is actually youth.
export const YOUTH_SIZES = ['YXS', 'YS', 'YM', 'YL', 'YXL'];
// Toddler sizes (2T–5T). Llegan de Printavo/imports; se muestran como fila
// propia en los grids cuando el ticket/estilo las trae (igual que youth).
export const TODDLER_SIZES = ['2T', '3T', '4T', '5T'];
export const ALL_SIZES = [...SIZES_ORDER, ...YOUTH_SIZES, ...TODDLER_SIZES];

// Clasificadores de grupo compartidos (una sola definición para todo el WMS).
export const isYouthSize = (s) => String(s || '').toUpperCase().startsWith('Y');
export const isToddlerSize = (s) => /^[2-5]T$/.test(String(s || '').toUpperCase());
export const isAdultSize = (s) => !!s && !isYouthSize(s) && !isToddlerSize(s);

// ─── Configurable sizes (single source of truth) ────────────────────────────
// Admins add extra sizes in "Configuración WMS → Tallas" (catalog type "sizes").
// useWmsSizes() merges those into the standard sets so EVERY size selector in the
// system (Receiving, Picking, PDA, Operator, New Order, Movements) grows without
// a deploy. Extras starting with 'Y' join youth, los NT (2T–5T) van a toddler,
// el resto a adult. Los arreglos estándar son el fallback antes del fetch.
const _dedupeSizes = (arr) => {
  const seen = new Set(), out = [];
  for (const s of arr) { const v = String(s || '').trim().toUpperCase(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
};
let _sizeExtras = null;        // cached across components
let _sizeExtrasPromise = null;
const _sizeSubs = new Set();
const _loadSizeExtras = () => {
  if (_sizeExtrasPromise) return _sizeExtrasPromise;
  _sizeExtrasPromise = fetcher('/catalogs')
    .then(d => { _sizeExtras = (d?.sizes || []).map(s => String(s.value || '').trim().toUpperCase()).filter(Boolean); })
    .catch(() => { _sizeExtras = []; })
    .finally(() => { _sizeSubs.forEach(fn => fn()); });
  return _sizeExtrasPromise;
};
// Call after adding/removing a size in the catalog UI so open screens refresh.
export const refreshWmsSizes = () => { _sizeExtras = null; _sizeExtrasPromise = null; _loadSizeExtras(); };

export const useWmsSizes = () => {
  const [extras, setExtras] = useState(_sizeExtras || []);
  useEffect(() => {
    let alive = true;
    const sync = () => { if (alive) setExtras(_sizeExtras || []); };
    _sizeSubs.add(sync);
    _loadSizeExtras().then(sync);
    return () => { alive = false; _sizeSubs.delete(sync); };
  }, []);
  const adult = _dedupeSizes([...SIZES_ORDER, ...extras.filter(isAdultSize)]);
  const youth = _dedupeSizes([...YOUTH_SIZES, ...extras.filter(isYouthSize)]);
  const toddler = _dedupeSizes([...TODDLER_SIZES, ...extras.filter(isToddlerSize)]);
  const all = _dedupeSizes([...adult, ...youth, ...toddler]);
  return { adult, youth, toddler, all, extras };
};

// ─── Configurable colors (curated catalog) ──────────────────────────────────
// Los colores viven en "Configuración WMS → Colores" (catalog type "colors").
// useWmsColors() los expone para que TODO selector de color (Receiving, UPC,
// etc.) muestre los colores curados aunque todavía no existan en inventario
// (ej. "ANCHORE", "FLAX" recién dados de alta). Mismo patrón que useWmsSizes.
let _colorCatalog = null;          // cached across components
let _colorCatalogPromise = null;
const _colorSubs = new Set();
const _loadColorCatalog = () => {
  if (_colorCatalogPromise) return _colorCatalogPromise;
  _colorCatalogPromise = fetcher('/catalogs')
    .then(d => { _colorCatalog = (d?.colors || []).map(c => String(c.value || '').trim()).filter(Boolean); })
    .catch(() => { _colorCatalog = []; })
    .finally(() => { _colorSubs.forEach(fn => fn()); });
  return _colorCatalogPromise;
};
// Call after adding/removing a color in the catalog UI so open screens refresh.
export const refreshWmsColors = () => { _colorCatalog = null; _colorCatalogPromise = null; _loadColorCatalog(); };

export const useWmsColors = () => {
  const [colors, setColors] = useState(_colorCatalog || []);
  useEffect(() => {
    let alive = true;
    const sync = () => { if (alive) setColors(_colorCatalog || []); };
    _colorSubs.add(sync);
    _loadColorCatalog().then(sync);
    return () => { alive = false; _colorSubs.delete(sync); };
  }, []);
  return colors;
};

// ─── Catálogo curado COMPLETO (todos los tipos) ─────────────────────────────
// Un solo /catalogs expone customers/colors/styles/sizes/descriptions/countries/
// fabrics curados. useWmsCatalogs() los entrega ya en arreglos de strings, para
// FUSIONARLOS con las listas del sistema/inventario en cualquier módulo y no
// ocultar valores reales no catalogados. El líder limpia typos en la config.
let _catalogs = null;               // { type: [{value,...}] } crudo de /catalogs
let _catalogsPromise = null;
const _catSubs = new Set();
const _loadCatalogs = () => {
  if (_catalogsPromise) return _catalogsPromise;
  _catalogsPromise = fetcher('/catalogs')
    .then(d => { _catalogs = d || {}; })
    .catch(() => { _catalogs = {}; })
    .finally(() => { _catSubs.forEach(fn => fn()); });
  return _catalogsPromise;
};
export const refreshWmsCatalogs = () => { _catalogs = null; _catalogsPromise = null; _loadCatalogs(); };

export const useWmsCatalogs = () => {
  const [cat, setCat] = useState(_catalogs || {});
  useEffect(() => {
    let alive = true;
    const sync = () => { if (alive) setCat(_catalogs || {}); };
    _catSubs.add(sync);
    _loadCatalogs().then(sync);
    return () => { alive = false; _catSubs.delete(sync); };
  }, []);
  const vals = (type) => (cat[type] || []).map(x => String(x?.value ?? x ?? '').trim()).filter(Boolean);
  return {
    customers: vals('customers'), colors: vals('colors'), styles: vals('styles'),
    sizes: vals('sizes'), descriptions: vals('descriptions'),
    countries: vals('countries'), fabrics: vals('fabrics'),
    manufacturers: vals('manufacturers'),
  };
};

// Fusiona listas (curado + sistema) sin duplicados (case-insensitive). Curado
// primero, luego lo del sistema que falte. Compartido por los módulos WMS.
export const mergeUnique = (...lists) => {
  const seen = new Set(), out = [];
  for (const l of lists) for (const c of (l || [])) {
    const v = String(c || '').trim(), k = v.toUpperCase();
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
};

// ─── WMS Context (badges + cross-module actions) ────────────────────────────
export const WmsContext = createContext({ badges: {}, refreshBadges: () => {}, openAsn: null });
export const useWms = () => useContext(WmsContext);
