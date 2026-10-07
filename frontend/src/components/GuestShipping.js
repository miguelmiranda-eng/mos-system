import React, { useState, useEffect, useCallback, useMemo } from "react";
import { LogOut, RefreshCw, Loader2, Truck } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../contexts/LanguageContext";
import { STATUS_COLORS as MOS_COLORS } from "../lib/constants";

// Vista del INVITADO SHIPPING (rol shipping_guest): un proveedor externo ve todas
// las órdenes programadas (todo el historial) y sólo llena SHIPPING FROM y CARRIER.
// La seguridad vive en el backend (deps.GUEST_SURFACE: default-deny a todo lo
// demás; routers/guest_shipping.py). Esta pantalla es lo único que App le
// muestra a ese rol.
const API = `${process.env.REACT_APP_BACKEND_URL}/api/guest-shipping`;
const ROOT_ID = 'guest-shipping';
// El tema global pisa inputs/tablas con !important: estilos acotados por id.
const SCOPED_CSS = `
#${ROOT_ID} { background:#f1f5f9 !important; color:#1e293b !important; }
#${ROOT_ID} .gs-sheet { background:#fff !important; color:#1e293b !important; }
#${ROOT_ID} .gs-sheet thead th { background:#d9ead3 !important; color:#1e293b !important; }
#${ROOT_ID} .gs-sheet tbody tr { background:#fff !important; }
#${ROOT_ID} input.gs-in { background:#fffbeb !important; color:#0f172a !important; border:1px solid #fcd34d; }
#${ROOT_ID} input.gs-in:focus { background:#fff !important; border-color:#2563eb; }
`;
const pad = (n) => String(n).padStart(2, '0');
const parseIso = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const MONTHS = { es: ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'],
  en: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] };
const DAYS = { es: ['LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO', 'DOMINGO'],
  en: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] };
const to12h = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${pad(((h + 11) % 12) + 1)}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};
const LOCAL_COLORS = { ENVIADO: { bg: '#16a34a', text: '#FFFFFF' } }; // packing ya sembrado
const pill = (s) => {
  const c = s && (LOCAL_COLORS[s] || MOS_COLORS[s]);
  return c ? { background: c.bg, color: c.text } : { background: '#e2e8f0', color: '#64748b' };
};
const PRIORITY_LABEL = { 1: '1RA', 2: '2DA', 3: '3RA', 4: '4TA' };

// Celda editable: guarda al salir o con Enter, sólo si cambió.
const Field = ({ value, list, onSave, placeholder }) => {
  const [v, setV] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setV(value ?? ''); }, [value, focused]);
  return (
    <input value={v} list={list} placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { setFocused(false); if (v.trim() !== (value ?? '')) onSave(v.trim()); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setV(value ?? ''); }}
      className="gs-in w-full min-w-[140px] px-2 py-1 rounded-md text-[12px] font-bold outline-none" />
  );
};

const GuestShipping = ({ user, onLogout }) => {
  const { t, lang } = useLang();
  const L = lang === 'en' ? 'en' : 'es';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (document.getElementById(`${ROOT_ID}-css`)) return;
    const el = document.createElement('style');
    el.id = `${ROOT_ID}-css`;
    el.textContent = SCOPED_CSS;
    document.head.appendChild(el);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`${API}/lines`, { credentials: 'include' });
      if (res.ok) setData(await res.json());
      else if (!silent) toast.error(t('gs_load_err'));
    } catch { if (!silent) toast.error(t('ceo_err_connection')); }
    finally { if (!silent) setLoading(false); }
  }, [t]);
  useEffect(() => { load(); }, [load]);
  // Sin canal en vivo: se refresca al volver a la pestaña.
  useEffect(() => {
    const onFocus = () => load(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const save = async (line, patch) => {
    try {
      const res = await fetch(`${API}/lines/${line.shipment_id}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.detail || t('gs_save_err')); return; }
      setData((p) => ({ ...p, lines: p.lines.map((l) => (l.shipment_id === d.shipment_id ? d : l)) }));
      toast.success(t('gs_saved', { order: line.order_number }));
    } catch { toast.error(t('ceo_err_connection')); }
  };

  const byDay = useMemo(() => {
    const exps = data?.exports || [];
    const lines = data?.lines || [];
    const out = [];
    exps.forEach((e) => {
      let day = out.find((d) => d.date === e.date);
      if (!day) { day = { date: e.date, exports: [] }; out.push(day); }
      day.exports.push({ ...e, lines: lines.filter((l) => l.export_id === e.export_id)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) });
    });
    return out.map((d) => ({ ...d, exports: d.exports.filter((e) => e.lines.length) })).filter((d) => d.exports.length);
  }, [data]);
  const suggest = useMemo(() => {
    const s = { ship_from: new Set(['ST ANDREWS']), carrier: new Set(['UPS GROUND', 'FEDEX GROUND']) };
    (data?.lines || []).forEach((l) => { if (l.ship_from) s.ship_from.add(l.ship_from); if (l.carrier) s.carrier.add(l.carrier); });
    return { ship_from: [...s.ship_from], carrier: [...s.carrier] };
  }, [data]);
  const dayLabel = (iso) => {
    const d = parseIso(iso);
    return `${DAYS[L][(d.getDay() + 6) % 7]} · ${pad(d.getDate())} ${MONTHS[L][d.getMonth()]} ${d.getFullYear()}`;
  };
  const pending = (data?.lines || []).filter((l) => !l.ship_from || !l.carrier).length;
  // Todo el historial: al cargar se salta al primer día de hoy en adelante.
  const [jumped, setJumped] = useState(false);
  useEffect(() => {
    if (jumped || !byDay.length) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const target = byDay.find((d) => d.date >= today) || byDay[byDay.length - 1];
    document.getElementById(`gs-day-${target.date}`)?.scrollIntoView({ block: 'start' });
    setJumped(true);
  }, [byDay, jumped]);

  return (
    <main id={ROOT_ID} className="min-h-screen w-full">
      <datalist id="gs-from">{suggest.ship_from.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="gs-carrier">{suggest.carrier.map((v) => <option key={v} value={v} />)}</datalist>
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-[1700px] mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center"><Truck className="w-5 h-5" /></div>
          <div className="min-w-0">
            <h1 className="text-lg font-black text-slate-800 leading-tight">{t('gs_title')}</h1>
            <p className="text-[11px] text-slate-500">{t('gs_subtitle')}</p>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-[11px] font-black ${pending ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
            {pending ? t('gs_pending', { n: pending }) : t('gs_all_done')}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[12px] font-bold text-slate-600">{user?.name || user?.email}</span>
            <button onClick={() => load()} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('ship_refresh')}
            </button>
            <button onClick={onLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-white text-[10px] font-black uppercase tracking-widest hover:bg-slate-700">
              <LogOut className="w-3.5 h-3.5" /> {t('gs_logout')}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1700px] mx-auto px-4 py-4 space-y-5">
        <p className="text-[12px] text-slate-600">{t('gs_help')}</p>
        {!data && loading ? (
          <div className="flex justify-center py-24"><Loader2 className="w-8 h-8 text-blue-400 animate-spin" /></div>
        ) : byDay.length === 0 ? (
          <p className="py-16 text-center text-[12px] font-black uppercase text-slate-400">{t('gs_empty')}</p>
        ) : byDay.map((day) => (
          <section key={day.date} id={`gs-day-${day.date}`} className="space-y-2 scroll-mt-20">
            <div className="px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-black tracking-widest">{dayLabel(day.date)}</div>
            {day.exports.map((e) => (
              <div key={e.export_id} className="gs-sheet rounded-xl border border-slate-300 overflow-hidden shadow-sm">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2 bg-slate-100 border-b border-slate-300 text-[12px]">
                  <span className="font-black text-slate-800">EXPORT# {e.export_no || '—'}</span>
                  <span className="font-black text-slate-700">SHIPPING# {e.shipping_no || '—'}</span>
                  {e.pl_numbers && <span className="font-bold text-slate-600">PL {e.pl_numbers}</span>}
                  {e.truck && <span className="font-bold text-slate-600">{e.truck}</span>}
                  <span className="text-slate-600">{t('sch_cutoff')}: <b>{to12h(e.cutoff_time)}</b></span>
                  <span className="text-slate-600">{t('sch_export_hr')}: <b>{to12h(e.export_time)}</b></span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="text-[10px] font-black uppercase tracking-wider">
                        {['ORDER', 'CUSTOMER', 'DELIVER TO', 'BRANDING', 'CUSTOMER PO.', 'DESIGN #', 'PCS', 'STATUS', t('sch_priority'), 'NOTES'].map((c) => (
                          <th key={c} className="px-2 py-1.5 text-left border-r border-slate-200 whitespace-nowrap">{c}</th>
                        ))}
                        <th className="px-2 py-1.5 text-left border-r border-slate-200 whitespace-nowrap">SHIPPING FROM ✎</th>
                        <th className="px-2 py-1.5 text-left whitespace-nowrap">CARRIER ✎</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.lines.map((l) => (
                        <tr key={l.shipment_id} className="border-t border-slate-200">
                          <td className="px-2 py-1.5 font-black text-slate-800 whitespace-nowrap">
                            {l.order_number}
                            {l.late && <span className="ml-1 px-1 rounded bg-red-600 text-white text-[9px]">LATE</span>}
                          </td>
                          <td className="px-2 py-1.5 font-bold">{l.client || '—'}</td>
                          <td className="px-2 py-1.5">{l.delivery_to || '—'}</td>
                          <td className="px-2 py-1.5">{l.branding || '—'}</td>
                          <td className="px-2 py-1.5">{l.customer_po || '—'}</td>
                          <td className="px-2 py-1.5">{l.design_num || '—'}</td>
                          <td className="px-2 py-1.5 text-right font-bold tabular-nums">{l.pcs != null ? Number(l.pcs).toLocaleString('en-US') : '—'}</td>
                          <td className="px-2 py-1.5">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase whitespace-nowrap" style={pill(l.status_effective)}>{l.status_effective || '—'}</span>
                          </td>
                          <td className="px-2 py-1.5">{l.priority ? PRIORITY_LABEL[l.priority] : '—'}</td>
                          <td className="px-2 py-1.5 text-slate-600">{l.ship_notes || ''}</td>
                          <td className="px-2 py-1"><Field value={l.ship_from} list="gs-from" placeholder="ST ANDREWS" onSave={(v) => save(l, { ship_from: v })} /></td>
                          <td className="px-2 py-1"><Field value={l.carrier} list="gs-carrier" placeholder="UPS GROUND" onSave={(v) => save(l, { carrier: v })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
};

export default GuestShipping;
