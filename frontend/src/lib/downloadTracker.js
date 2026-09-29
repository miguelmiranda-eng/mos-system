// Registro de descargas en UN solo punto.
//
// Los Excel/PDF/CSV del MOS se generan en el navegador (XLSX.writeFile,
// file-saver, jsPDF.save, <a download>) y no dejaban rastro: se sabía quién
// entraba, no qué bajaba. En vez de tocar las ~30 llamadas una por una, aquí
// se intercepta el mecanismo común a todas: un <a download> al que se le hace
// click (casi siempre un ancla suelta, fuera del DOM), más los window.open a
// endpoints de exportación del backend. Cada descarga se reporta a
// POST /api/activity/download y queda en activity_logs como "download".
//
// El reporte es "dispara y olvida": nunca bloquea ni rompe la descarga.
import { API } from './constants';

const EXPORT_URL = /\/api\/.*(export|download|pdf|report|excel|xlsx|csv)/i;
let installed = false;

const moduleName = () => {
  const { pathname, hash } = window.location;
  return `${pathname}${hash || ''}`.slice(0, 120);
};

const report = (filename, via) => {
  try {
    fetch(`${API}/activity/download`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true, // sobrevive si la descarga navega o cierra la pestaña
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, module: moduleName(), via }),
    }).catch(() => {});
  } catch {
    // nunca romper la descarga por el registro
  }
};

// Un mismo click puede llegar por dos caminos (el .click() parchado y el
// listener del documento si el ancla está montada): se reporta una sola vez.
const seen = new WeakSet();
const track = (a) => {
  if (!a || seen.has(a) || !a.hasAttribute('download')) return;
  seen.add(a);
  const name = a.getAttribute('download') || (a.href || '').split('/').pop() || '';
  report(name.slice(0, 200), 'client');
};

export function installDownloadTracker() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // 1) Anclas sueltas: XLSX.writeFile, file-saver y jsPDF crean un <a download>
  //    fuera del DOM y le hacen .click() o dispatchEvent(click).
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    track(this);
    return origClick.apply(this, args);
  };
  const origDispatch = HTMLAnchorElement.prototype.dispatchEvent;
  HTMLAnchorElement.prototype.dispatchEvent = function (ev) {
    if (ev && ev.type === 'click') track(this);
    return origDispatch.call(this, ev);
  };

  // 2) Anclas montadas que el usuario pulsa a mano (<a download={...}>).
  document.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest && ev.target.closest('a[download]');
    if (a) track(a);
  }, true);

  // 3) Exportaciones que arma el backend y se abren con window.open.
  const origOpen = window.open;
  window.open = function (url, ...rest) {
    try {
      const u = String(url || '');
      if (u.startsWith(API) && EXPORT_URL.test(u)) {
        report(u.slice(API.length).split('?')[0].slice(0, 200), 'server');
      }
    } catch {
      // ignorar
    }
    return origOpen.call(this, url, ...rest);
  };
}
