import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, PackageCheck, Loader2, Undo2, Lock, Plus, Minus, CheckCircle2, Settings2,
  Trash2, User, X, Layers, ClipboardCheck, MoreHorizontal, ChevronRight, Calculator, FileSpreadsheet,
} from 'lucide-react';
import { toast } from 'sonner';
import { useLang } from '../contexts/LanguageContext';
import { Toaster } from './ui/sonner';
import { call, useOrderChangeReload, CommentsButton, useComments } from './modules/shared';

// Estación de empaque: un iPad por máquina, en CUATRO pantallas, una decisión
// por pantalla:
//   1. ¿Qué máquina?   2. ¿Qué orden?   3. ¿Qué talla?
//   4. Captura: pallet #, piezas por caja y cuántas cajas, con la CALCULADORA
//      DE CAJAS en vivo (la misma del Excel Calculadora_Cajas: cantidad,
//      pzs por caja → cajas completas, caja parcial, total y desglose), pero
//      sobre lo que FALTA de esa talla. Un toque registra las cajas completas
//      y otro la caja parcial.
// Prepack: en el paso 3 aparece PACKS (packs por caja × proporción).
// Backend: routers/pack_station.py.

const MACHINE_KEY = 'mos_pack_station_machine';
const PACKER_KEY = 'mos_pack_station_packer';
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin storage */ } },
};
const n = (v) => Number(v || 0).toLocaleString('es-MX');
const int = (v) => Math.max(0, parseInt(v, 10) || 0);
const dimsTxt = (d) => (d ? `${d.l}×${d.w}×${d.h}` : '');
const sizesTxt = (sizes) => Object.entries(sizes).map(([s, q]) => `${s} ${q}`).join(' · ');
const BIG_BTN = 'w-full rounded-2xl py-5 text-xl font-black flex items-center justify-center gap-2 active:scale-[0.99] disabled:opacity-40';
const TILE = 'rounded-3xl border-2 bg-card p-5 text-left active:scale-[0.98] transition-transform';

// ── Piezas básicas ──────────────────────────────────────────────────────────

function Sheet({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="w-full sm:max-w-xl max-h-[92vh] overflow-auto rounded-t-3xl sm:rounded-3xl bg-background border border-border p-5 space-y-5"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-black">{title}</h3>
          <button type="button" onClick={onClose} className="p-2 rounded-full hover:bg-secondary"><X size={22} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Stepper({ value, onChange, min = 0, big }) {
  const v = value === '' ? '' : Number(value);
  return (
    <div className="flex items-stretch gap-2">
      <button type="button" onClick={() => onChange(Math.max(min, (Number(v) || 0) - 1))}
        className="w-16 rounded-2xl bg-secondary flex items-center justify-center active:scale-95"><Minus /></button>
      <input type="number" inputMode="numeric" value={v} placeholder="0" onChange={(e) => onChange(e.target.value === '' ? '' : int(e.target.value))}
        className={`flex-1 min-w-0 rounded-2xl border-2 border-border bg-card text-center font-black outline-none focus:border-primary ${big ? 'text-4xl py-4' : 'text-2xl py-3'}`} />
      <button type="button" onClick={() => onChange((Number(v) || 0) + 1)}
        className="w-16 rounded-2xl bg-secondary flex items-center justify-center active:scale-95"><Plus /></button>
    </div>
  );
}

function DimsInputs({ value, onChange }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {['l', 'w', 'h'].map((k) => (
        <input key={k} type="number" inputMode="decimal" placeholder={k.toUpperCase()} value={value[k] || ''}
          onChange={(e) => onChange({ ...value, [k]: e.target.value })}
          className="rounded-2xl border-2 border-border bg-card py-3 text-xl font-bold text-center outline-none focus:border-primary" />
      ))}
    </div>
  );
}

function StepTitle({ n: num, children }) {
  return (
    <h2 className="text-3xl font-black flex items-center gap-3">
      <span className="w-11 h-11 rounded-full bg-primary text-primary-foreground text-xl flex items-center justify-center">{num}</span>
      {children}
    </h2>
  );
}

// ── Hojas ───────────────────────────────────────────────────────────────────

function PackerSheet({ t, packers, current, onPick, onClose }) {
  const [name, setName] = useState('');
  return (
    <Sheet title={t('ps_who')} onClose={onClose}>
      {packers.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {packers.map((p) => (
            <button key={p} type="button" onClick={() => onPick(p)}
              className={`rounded-2xl border-2 py-4 text-lg font-black ${p === current ? 'border-primary bg-primary/10' : 'border-border'}`}>{p}</button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ps_new_name')}
          className="flex-1 rounded-2xl border-2 border-border bg-card px-4 py-3 text-lg font-bold outline-none focus:border-primary" />
        <button type="button" disabled={!name.trim()} onClick={() => onPick(name.trim())}
          className="rounded-2xl bg-primary text-primary-foreground px-5 font-black disabled:opacity-40">{t('ps_ok')}</button>
      </div>
    </Sheet>
  );
}

function BoxSizesSheet({ t, sizes, onSaved, onClose }) {
  const [form, setForm] = useState({ name: '', l: '', w: '', h: '' });
  const save = async () => {
    try {
      await call('/pack-station/box-sizes', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', l: '', w: '', h: '' });
      onSaved();
    } catch (e) { toast.error(e.message); }
  };
  const del = async (id) => {
    try { await call(`/pack-station/box-sizes/${id}`, { method: 'DELETE' }); onSaved(); } catch (e) { toast.error(e.message); }
  };
  return (
    <Sheet title={t('ps_box_catalog')} onClose={onClose}>
      <div className="space-y-2">
        {sizes.length === 0 && <div className="text-muted-foreground">{t('ps_no_box_sizes')}</div>}
        {sizes.map((s) => (
          <div key={s.box_size_id} className="flex items-center gap-3 rounded-2xl border border-border px-4 py-3">
            <span className="font-black flex-1">{s.name}</span>
            <span className="text-muted-foreground">{dimsTxt(s)}</span>
            <button type="button" onClick={() => del(s.box_size_id)} className="p-2 rounded-full hover:bg-secondary text-red-500"><Trash2 size={18} /></button>
          </div>
        ))}
      </div>
      <div className="space-y-2 rounded-2xl border border-dashed border-border p-3">
        <input className="w-full rounded-2xl border-2 border-border bg-card px-4 py-3 font-bold" placeholder={t('ps_box_name')}
          value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <DimsInputs value={form} onChange={(d) => setForm({ ...form, ...d })} />
        <button type="button" onClick={save} className={`${BIG_BTN} bg-primary text-primary-foreground !py-3`}><Plus /> {t('ps_add')}</button>
      </div>
    </Sheet>
  );
}

function RatioSheet({ v, t, onSave, onClose }) {
  const [ratio, setRatio] = useState(() => ({ ...v.prepack_ratio }));
  const total = Object.values(ratio).reduce((s, x) => s + int(x), 0);
  return (
    <Sheet title={t('ps_ratio_title')} onClose={onClose}>
      <p className="text-muted-foreground">{t('ps_ratio_hint')}</p>
      <div className="space-y-3">
        {Object.keys(v.order.ordered).map((s) => (
          <div key={s} className="flex items-center gap-3">
            <div className="w-14 text-2xl font-black">{s}</div>
            <div className="flex-1"><Stepper value={ratio[s] ?? ''} onChange={(x) => setRatio({ ...ratio, [s]: x })} /></div>
          </div>
        ))}
      </div>
      <button type="button" disabled={!total} onClick={() => onSave(ratio)} className={`${BIG_BTN} bg-amber-600 text-white`}>
        {t('ps_ratio_save_n', { n: total })}
      </button>
    </Sheet>
  );
}

function PalletSheet({ v, t, busy, onCloseP, onSelect, onClose }) {
  const active = v.pallets.find((p) => p.no === v.active_pallet && !p.closed);
  const [dims, setDims] = useState({});
  const [weight, setWeight] = useState('');
  return (
    <Sheet title={active ? t('ps_close_pallet', { n: active.no }) : t('ps_pallets')} onClose={onClose}>
      {active && (
        <div className="space-y-3 rounded-2xl border-2 border-primary/40 p-4">
          <div className="text-lg font-black">{t('ps_close_pallet', { n: active.no })} · {t('ps_pallet_info', { b: active.boxes, p: n(active.pcs) })}</div>
          <div className="text-sm font-bold text-muted-foreground">{t('ps_pallet_dims_label')}</div>
          <DimsInputs value={dims} onChange={setDims} />
          <input type="number" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)}
            placeholder={t('ps_pallet_weight', { w: n(active.box_weight) })}
            className="w-full rounded-2xl border-2 border-border bg-card py-3 text-xl font-black text-center outline-none focus:border-primary" />
          <button type="button" disabled={busy || !active.boxes} onClick={() => onCloseP({ dims, weight })} className={`${BIG_BTN} bg-primary text-primary-foreground !py-4`}>
            <Lock /> {t('ps_close_pallet_confirm')}
          </button>
        </div>
      )}
      <div className="space-y-2">
        {v.pallets.map((p) => (
          <div key={p.no} className="flex items-center gap-3 rounded-2xl border border-border px-4 py-3">
            <span className="font-black flex-1 inline-flex items-center gap-2">{p.closed && <Lock size={14} />}{t('ps_pallet_n', { n: p.no })}</span>
            <span className="text-muted-foreground">{t('ps_pallet_info', { b: p.boxes, p: n(p.pcs) })}</span>
            {p.closed && <button type="button" onClick={() => onSelect(p.no)} className="rounded-xl border border-border px-3 py-1.5 font-bold">{t('ps_reopen')}</button>}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

function FinishSheet({ v, t, busy, onSave, onClose }) {
  const [f, setF] = useState(() => ({ damaged_print: '', damaged_garment: '', extra: '', samples: '', notes: '', ...(v.finish || {}) }));
  return (
    <Sheet title={t('ps_finish_title')} onClose={onClose}>
      <div className={`rounded-2xl p-4 font-black text-lg ${v.complete ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
        {v.complete ? t('ps_complete') : v.over ? t('ps_over_warning', { n: n(v.over) }) : t('ps_finish_missing', { n: n(v.missing) })}
      </div>
      {['damaged_print', 'damaged_garment', 'extra', 'samples'].map((k) => (
        <div key={k} className="flex items-center gap-3">
          <div className="w-40 font-bold">{t(`ps_${k}`)}</div>
          <div className="flex-1"><Stepper value={f[k] ?? ''} onChange={(x) => setF({ ...f, [k]: x })} /></div>
        </div>
      ))}
      <input value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder={t('ps_notes')}
        className="w-full rounded-2xl border-2 border-border bg-card px-4 py-3" />
      <button type="button" disabled={busy} onClick={() => onSave(f)} className={`${BIG_BTN} bg-primary text-primary-foreground`}>
        <CheckCircle2 /> {t('ps_finish_save')}
      </button>
    </Sheet>
  );
}

function MenuSheet({ t, v, canEdit, onPick, onClose }) {
  const item = (key, Icon, label) => (
    <button type="button" onClick={() => onPick(key)} className="w-full rounded-2xl border-2 border-border px-5 py-4 flex items-center gap-3 text-lg font-black">
      <Icon /> {label}
    </button>
  );
  return (
    <Sheet title={t('ps_more')} onClose={onClose}>
      <div className="space-y-2">
        {canEdit && v && item('pallet', Layers, t('ps_pallets'))}
        {canEdit && v?.box_count > 0 && item('finish', ClipboardCheck, v.finish ? t('ps_finish_edit') : t('ps_finish_open'))}
        {canEdit && v?.order?.kind === 'prepack' && v.pack_size > 0 && item('ratio', Layers, t('ps_ratio_edit'))}
        {canEdit && item('sizes', Settings2, t('ps_box_catalog'))}
      </div>
    </Sheet>
  );
}

// ── Siempre a la vista: el pallet abierto y el avance de la orden ───────────

// Qué lleva cada pallet (por talla), sacado de las cajas capturadas.
function palletContents(v, no) {
  const bx = v.boxes.filter((b) => b.pallet_no === no);
  const sizes = {};
  bx.forEach((b) => Object.entries(b.sizes).forEach(([s, q]) => { sizes[s] = (sizes[s] || 0) + q; }));
  const ordered = Object.fromEntries(Object.keys(v.order.ordered).filter((s) => sizes[s]).map((s) => [s, sizes[s]]));
  return { boxes: bx.length, pcs: bx.reduce((s, b) => s + (b.total || 0), 0), sizes: ordered };
}

function PalletCard({ t, v, busy, onClosePallet, onNewPallet }) {
  const active = v.pallets.find((p) => p.no === v.active_pallet && !p.closed);
  const closed = v.pallets.filter((p) => p.closed);
  const c = active ? palletContents(v, active.no) : null;
  return (
    <div className="rounded-3xl border-2 border-primary bg-card p-5 space-y-4">
      {active ? (
        <>
          <div className="flex items-center gap-2">
            <Layers className="text-primary" />
            <span className="text-2xl font-black">{t('ps_pallet_n', { n: active.no })}</span>
            <span className="rounded-full bg-emerald-600 text-white px-2 py-0.5 text-xs font-black">{t('ps_open_now')}</span>
            <span className="ml-auto text-lg font-black">{t('ps_pallet_info', { b: c.boxes, p: n(c.pcs) })}</span>
          </div>
          {c.boxes === 0 ? (
            <div className="text-muted-foreground">{t('ps_pallet_empty')}</div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {Object.entries(c.sizes).map(([s, q]) => (
                <div key={s} className="rounded-xl bg-secondary/60 p-2 text-center">
                  <div className="text-lg font-black">{s}</div>
                  <div className="text-sm font-bold">{n(q)}</div>
                </div>
              ))}
            </div>
          )}
          <button type="button" disabled={busy || c.boxes === 0} onClick={onClosePallet}
            className={`${BIG_BTN} bg-primary text-primary-foreground !py-4`}>
            <Lock /> {t('ps_close_pallet', { n: active.no })}
          </button>
        </>
      ) : (
        <>
          <div className="text-xl font-black text-amber-600 dark:text-amber-400">{t('ps_no_open_pallet_short')}</div>
          <button type="button" disabled={busy} onClick={onNewPallet} className={`${BIG_BTN} bg-primary text-primary-foreground !py-4`}>
            <Plus /> {t('ps_new_pallet')}
          </button>
        </>
      )}
      {closed.length > 0 && (
        <div className="space-y-1 border-t border-border pt-3">
          {closed.map((p) => {
            const pc = palletContents(v, p.no);
            return (
              <div key={p.no} className="flex items-center gap-2 text-sm">
                <Lock size={14} className="text-muted-foreground" />
                <span className="font-black">{t('ps_pallet_n', { n: p.no })}</span>
                <span className="text-muted-foreground truncate">{t('ps_pallet_info', { b: pc.boxes, p: n(pc.pcs) })} · {sizesTxt(pc.sizes)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Cómo va el espejo en el DPL de Google (services/dpl_sync.py).
function DplStatus({ t, v, busy, onSync }) {
  const d = v.dpl || {};
  const when = d.at ? new Date(d.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
  const tone = !d.enabled ? 'border-border text-muted-foreground'
    : d.pending ? 'border-amber-500/50 text-amber-600 dark:text-amber-400'
      : d.ok ? 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400'
        : d.error ? 'border-red-500/50 text-red-600 dark:text-red-400' : 'border-border text-muted-foreground';
  const label = !d.enabled ? t('ps_dpl_off')
    : d.pending ? t('ps_dpl_pending')
      : d.ok ? t('ps_dpl_ok', { h: when })
        : d.error ? t('ps_dpl_error', { e: d.error }) : t('ps_dpl_never');
  return (
    <div className={`rounded-2xl border-2 bg-card px-4 py-3 flex items-center gap-3 ${tone}`}>
      <FileSpreadsheet className="shrink-0" />
      <div className="flex-1 min-w-0 font-bold text-sm">
        {label}
        {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className="ml-2 underline">{t('ps_dpl_open')}</a>}
      </div>
      {d.enabled && v.box_count > 0 && (
        <button type="button" disabled={busy} onClick={onSync} className="shrink-0 rounded-xl border border-border px-3 py-1.5 font-bold text-foreground">
          {t('ps_dpl_sync')}
        </button>
      )}
    </div>
  );
}

function OrderProgress({ t, v, current, onPick }) {
  return (
    <div className="rounded-3xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-lg font-black">{t('ps_order_progress')}</span>
        <span className="font-black">{t('ps_packed_of', { p: n(v.total_packed), q: n(v.total_ordered) })}</span>
      </div>
      <div className="grid grid-cols-4 text-xs font-black uppercase text-muted-foreground px-2 py-1">
        <span>{t('ps_size_col')}</span><span className="text-right">{t('ps_calc_ordered')}</span>
        <span className="text-right">{t('ps_calc_packed')}</span><span className="text-right">{t('ps_calc_left')}</span>
      </div>
      {v.audit.map((a) => {
        const left = a.ordered - a.packed;
        return (
          <button key={a.size} type="button" onClick={() => onPick(a.size)}
            className={`w-full grid grid-cols-4 items-center rounded-xl px-2 py-2 text-lg ${a.size === current ? 'bg-primary/15 ring-2 ring-primary' : 'hover:bg-secondary/60'}`}>
            <span className="font-black text-left">{a.size}</span>
            <span className="text-right">{n(a.ordered)}</span>
            <span className="text-right font-bold">{n(a.packed)}</span>
            <span className={`text-right font-black ${left < 0 ? 'text-red-500' : left === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
              {left < 0 ? `+${n(-left)}` : left === 0 ? '✓' : n(left)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Paso 4: captura con la calculadora de cajas ─────────────────────────────

function Capture({ t, v, sizeKey, boxSizes, busy, onRegister, onPallet, onUndo, onPickSize, onClosePallet, onFinish, onDplSync }) {
  const packs = sizeKey === 'PACKS';
  const ratio = v.prepack_ratio || {};
  const row = v.audit.find((a) => a.size === sizeKey);
  // Lo que FALTA de esta talla (PACKS: cuántos packs completos caben aún).
  const left = packs
    ? Math.max(0, Math.min(...Object.entries(ratio).map(([s, r]) => {
      const a = v.audit.find((x) => x.size === s);
      return a ? Math.floor((a.ordered - a.packed) / r) : 0;
    })))
    : Math.max(0, (row?.ordered || 0) - (row?.packed || 0));
  // Al abrir la talla, las cantidades arrancan VACÍAS (traer las de la última
  // carga confundía); sólo se recuerdan la caja y el peso de la última caja.
  const lastOfSize = v.boxes.find((b) => (packs
    ? v.pack_size && b.total % v.pack_size === 0 && Object.keys(b.sizes).every((s) => ratio[s])
    : Object.keys(b.sizes).length === 1 && b.sizes[sizeKey]));
  const [perBox, setPerBox] = useState('');
  const lastBox = lastOfSize || v.boxes[0];   // sin cajas de esta talla: la última de la orden
  const [boxSizeId, setBoxSizeId] = useState(() => lastBox?.box_size_id || boxSizes[0]?.box_size_id || '');
  const [weight, setWeight] = useState(lastBox?.weight ?? '');

  // La calculadora (Excel): completas = INT(cant/pzs), parcial = MOD, total = ROUNDUP.
  const per = int(perBox);
  const full = per ? Math.floor(left / per) : 0;
  const partial = per ? left % per : 0;
  const totalBoxes = per ? Math.ceil(left / per) : 0;
  // Arranca en 1 (lo normal es registrar conforme se cierra cada caja); un
  // toque de más no debe registrar la talla entera.
  const [count, setCount] = useState(1);
  const unit = packs ? t('ps_unit_packs') : t('ps_unit_pcs');
  const active = v.pallets.find((p) => p.no === v.active_pallet && !p.closed);
  const openPallets = v.pallets.filter((p) => !p.closed);
  // PACKS: lo que pide y lo que va, en packs.
  const orderedPacks = packs ? Math.min(...Object.entries(ratio).map(([s, r]) => Math.floor((v.order.ordered[s] || 0) / r))) : 0;
  // Al terminar esta talla: las que faltan, para que elija.
  const pending = v.audit.filter((a) => a.size !== sizeKey && a.ordered - a.packed > 0);

  const register = (qty, boxes) => onRegister({
    ...(packs ? { packs: qty } : { sizes: { [sizeKey]: qty } }), count: boxes, weight,
    ...(boxSizeId ? { box_size_id: boxSizeId } : {}),
  });

  return (
    <div className="grid lg:grid-cols-2 gap-5 items-start">
      <div className="space-y-5">
        {left === 0 && (
          <div className="rounded-3xl border-2 border-emerald-500 bg-emerald-500/10 p-5 space-y-3">
            <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
              <CheckCircle2 size={28} /> {packs ? t('ps_packs_done') : t('ps_size_done_n', { s: sizeKey })}
            </div>
            {pending.length > 0 ? (
              <>
                <div className="text-lg font-bold">{t('ps_pick_next_size')}</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {pending.map((a) => (
                    <button key={a.size} type="button" onClick={() => onPickSize(a.size)}
                      className="rounded-2xl bg-emerald-600 text-white py-4 px-2 active:scale-95">
                      <div className="text-3xl font-black">{a.size}</div>
                      <div className="text-sm font-bold opacity-90">{t('ps_missing_n', { n: n(a.ordered - a.packed) })}</div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                {active && (
                  <button type="button" onClick={onClosePallet} className={`${BIG_BTN} bg-primary text-primary-foreground`}>
                    <Lock /> {t('ps_close_pallet', { n: active.no })}
                  </button>
                )}
                <button type="button" onClick={onFinish} className={`${BIG_BTN} bg-emerald-600 text-white`}>
                  <ClipboardCheck /> {t('ps_finish_open')}
                </button>
              </>
            )}
          </div>
        )}
        {/* Pallet # */}
        <div>
          <div className="text-sm font-black text-muted-foreground mb-2 uppercase tracking-wider">{t('ps_pallet_no')}</div>
          <div className="flex flex-wrap gap-2">
            {openPallets.map((p) => (
              <button key={p.no} type="button" onClick={() => p.no !== v.active_pallet && onPallet(p.no)}
                className={`rounded-2xl border-2 px-5 py-3 text-xl font-black ${p.no === v.active_pallet ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>
                #{p.no}<span className="block text-xs font-bold opacity-80">{t('ps_pallet_info', { b: p.boxes, p: n(p.pcs) })}</span>
              </button>
            ))}
            <button type="button" onClick={() => onPallet(0)} className="rounded-2xl border-2 border-dashed border-border px-5 py-3 text-xl font-black">+</button>
          </div>
        </div>

        {/* Piezas por caja */}
        <div>
          <div className="text-sm font-black text-muted-foreground mb-2 uppercase tracking-wider">{packs ? t('ps_packs_per_box_label') : t('ps_pcs_per_box')}</div>
          <Stepper value={perBox} onChange={setPerBox} big />
          {packs && per > 0 && <div className="text-sm text-muted-foreground mt-1">{t('ps_pack_means', { r: sizesTxt(Object.fromEntries(Object.entries(ratio).map(([s, r]) => [s, r * per]))), p: n(per * v.pack_size) })}</div>}
        </div>

        {/* Caja y peso (opcionales) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-sm font-black text-muted-foreground mb-2 uppercase tracking-wider">{t('ps_which_box')}</div>
            <select value={boxSizeId} onChange={(e) => setBoxSizeId(e.target.value)}
              className="w-full rounded-2xl border-2 border-border bg-card px-3 py-3 text-lg font-bold">
              <option value="">—</option>
              {boxSizes.map((s) => <option key={s.box_size_id} value={s.box_size_id}>{s.name} ({dimsTxt(s)})</option>)}
            </select>
          </div>
          <div>
            <div className="text-sm font-black text-muted-foreground mb-2 uppercase tracking-wider">{t('ps_weight')}</div>
            <input type="number" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="0"
              className="w-full rounded-2xl border-2 border-border bg-card py-3 text-xl font-black text-center outline-none focus:border-primary" />
          </div>
        </div>

      {/* Calculadora de cajas */}
      <div className="rounded-3xl border-2 border-primary/40 bg-card p-5 space-y-4">
        <div className="flex items-center gap-2 text-lg font-black"><Calculator /> {t('ps_calculator')}</div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-2xl bg-secondary/60 p-3"><div className="text-xs font-bold text-muted-foreground">{t('ps_calc_ordered')}</div><div className="text-2xl font-black">{n(packs ? orderedPacks : row?.ordered)}</div></div>
          <div className="rounded-2xl bg-secondary/60 p-3"><div className="text-xs font-bold text-muted-foreground">{t('ps_calc_packed')}</div><div className="text-2xl font-black">{n(packs ? Math.max(0, orderedPacks - left) : row?.packed)}</div></div>
          <div className="rounded-2xl bg-amber-500/15 p-3"><div className="text-xs font-bold text-muted-foreground">{t('ps_calc_left')}</div><div className="text-2xl font-black text-amber-600 dark:text-amber-400">{n(left)} <span className="text-sm">{unit}</span></div></div>
        </div>
        {left === 0 ? (
          <div className="rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 p-4 text-xl font-black text-center">{t('ps_size_done')}</div>
        ) : !per ? (
          <div className="text-muted-foreground">{t('ps_calc_hint')}</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl border border-border p-3"><div className="text-xs font-bold text-muted-foreground">{t('ps_calc_full')}</div><div className="text-3xl font-black">{n(full)}</div></div>
              <div className="rounded-2xl border border-border p-3"><div className="text-xs font-bold text-muted-foreground">{t('ps_calc_partial')}</div><div className="text-3xl font-black">{n(partial)}</div></div>
              <div className="rounded-2xl border border-border p-3"><div className="text-xs font-bold text-muted-foreground">{t('ps_calc_total')}</div><div className="text-3xl font-black">{n(totalBoxes)}</div></div>
            </div>
            <div className="rounded-2xl bg-secondary/60 p-3 text-center text-lg font-black">
              {t('ps_calc_breakdown', { f: n(full), p: n(per), u: unit })}{partial > 0 ? t('ps_calc_breakdown_partial', { r: n(partial), u: unit }) : ''}
            </div>
            {full > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-black text-muted-foreground uppercase tracking-wider">{t('ps_how_many_boxes_now')}</div>
                <Stepper value={count} onChange={(x) => setCount(Math.min(full, Math.max(1, int(x))))} min={1} />
                <button type="button" disabled={busy || !active} onClick={() => register(per, count)} className={`${BIG_BTN} bg-emerald-600 text-white`}>
                  {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} {t('ps_register_boxes', { c: n(count), p: n(per), u: unit })}
                </button>
              </div>
            )}
            {partial > 0 && full === 0 && (
              <button type="button" disabled={busy || !active} onClick={() => register(partial, 1)} className={`${BIG_BTN} bg-emerald-600 text-white`}>
                <CheckCircle2 /> {t('ps_register_partial', { r: n(partial), u: unit })}
              </button>
            )}
            {partial > 0 && full > 0 && (
              <button type="button" disabled={busy || !active} onClick={() => register(partial, 1)} className={`${BIG_BTN} border-2 border-border !py-4 !text-lg`}>
                {t('ps_register_partial', { r: n(partial), u: unit })}
              </button>
            )}
            {!active && <div className="text-sm font-bold text-amber-600 dark:text-amber-400">{t('ps_no_open_pallet')}</div>}
          </>
        )}
        {v.boxes[0] && (
          <div className="flex items-center gap-3 border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground flex-1 truncate">{t('ps_last_box', { n: v.box_count })} {sizesTxt(v.boxes[0].sizes)} · {t('ps_pallet_n', { n: v.boxes[0].pallet_no })}</span>
            <button type="button" disabled={busy} onClick={onUndo} className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 font-bold text-red-500">
              <Undo2 size={16} /> {t('ps_undo')}
            </button>
          </div>
        )}
      </div>
      </div>

      {/* Siempre a la vista: qué lleva el pallet y cómo va la orden */}
      <div className="space-y-5 lg:sticky lg:top-24">
        <PalletCard t={t} v={v} busy={busy} onClosePallet={onClosePallet} onNewPallet={() => onPallet(0)} />
        <OrderProgress t={t} v={v} current={sizeKey} onPick={onPickSize} />
        <DplStatus t={t} v={v} busy={busy} onSync={onDplSync} />
      </div>
    </div>
  );
}

// ── Pantalla ────────────────────────────────────────────────────────────────

export default function PackStation() {
  const { t } = useLang();
  const navigate = useNavigate();
  const params = useParams();
  const [machine, setMachine] = useState(() => (params.machine || store.get(MACHINE_KEY) || '').toUpperCase());
  const [machines, setMachines] = useState(null);
  const [station, setStation] = useState(null);
  const [orderId, setOrderId] = useState('');
  const [sizeKey, setSizeKey] = useState('');
  const [view, setView] = useState(null);
  const [packer, setPacker] = useState(() => store.get(PACKER_KEY));
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState('');
  const loadRef = useRef(null);
  const [openComments, commentsModal] = useComments(() => loadRef.current?.());

  useEffect(() => { call('/pack-station/machines').then((d) => setMachines(d.machines)).catch((e) => toast.error(e.message)); }, []);
  const loadStation = useCallback(async () => {
    if (!machine) return;
    try {
      const d = await call(`/pack-station/station/${machine}`);
      setStation(d);
      setOrderId((cur) => (cur && !d.orders.some((o) => o.order_id === cur) ? '' : cur));
    } catch (e) { toast.error(e.message); }
  }, [machine]);
  const loadOrder = useCallback(async () => {
    if (!orderId) { setView(null); return; }
    try { setView(await call(`/pack-station/order/${orderId}`)); } catch (e) { toast.error(e.message); }
  }, [orderId]);
  loadRef.current = () => { loadStation(); loadOrder(); };
  useEffect(() => { loadStation(); }, [loadStation]);
  useEffect(() => { loadOrder(); }, [loadOrder]);
  useOrderChangeReload(loadRef);

  // Navegación por pasos: atrás = un paso atrás.
  const step = !machine ? 1 : !orderId ? 2 : !sizeKey ? 3 : 4;
  // Al elegir la máquina se pregunta SIEMPRE quién empaca (cambia por turno).
  const pickMachine = (m) => {
    store.set(MACHINE_KEY, m); setMachine(m); navigate(`/empaque/estacion/${m}`, { replace: true });
    setSheet('packer');
  };
  const back = () => {
    if (step === 4) setSizeKey('');
    else if (step === 3) { setOrderId(''); setView(null); }
    else if (step === 2) { store.set(MACHINE_KEY, ''); setMachine(''); setStation(null); navigate('/empaque/estacion', { replace: true }); }
    else navigate('/empaque');
  };

  const post = (path, body, method = 'POST') => call(path, { method, body: JSON.stringify(body || {}) });
  const act = async (fn, okMsg) => {
    setBusy(true);
    try {
      const d = await fn();
      setView(d);
      if (okMsg) toast.success(okMsg);
      setSheet('');
      loadStation();
      return d;
    } catch (e) {
      toast.error(e.message);
      return null;
    } finally { setBusy(false); }
  };

  const canEdit = !!station?.can_edit;
  const order = view?.order;
  const prepack = order?.kind === 'prepack';
  const needsRatio = prepack && !view?.pack_size;

  const syncDpl = () => act(() => post(`/pack-station/order/${orderId}/dpl-sync`), null);
  // Mientras haya escritura pendiente al DPL, refrescar el estado en ~25 s.
  useEffect(() => {
    if (!view?.dpl?.pending) return undefined;
    const id = setTimeout(() => loadRef.current?.(), 25000);
    return () => clearTimeout(id);
  }, [view?.dpl?.pending, view?.dpl?.at]);

  const register = (body) => {
    if (!packer) { setSheet('packer'); return; }
    act(() => post(`/pack-station/order/${orderId}/boxes`, { ...body, machine, packer }), t('ps_box_saved', { n: body.count }));
  };

  const crumbs = [machine && machine.replace('MAQUINA', 'M'), order && `#${order.order_number}`, sizeKey].filter(Boolean);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />
      {commentsModal}
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <button type="button" onClick={back} className="p-3 rounded-full bg-secondary active:scale-95"><ArrowLeft size={24} /></button>
        <PackageCheck className="text-amber-500" />
        <div className="text-xl font-black truncate">{crumbs.length ? crumbs.join(' › ') : t('ps_title')}</div>
        <div className="flex-1" />
        <button type="button" onClick={() => setSheet('packer')}
          className={`inline-flex items-center gap-2 rounded-full px-4 py-2 font-black border-2 ${packer ? 'border-border' : 'border-amber-500 text-amber-600 dark:text-amber-400'}`}>
          <User size={18} /> {packer || t('ps_who')}
        </button>
        {step >= 2 && <button type="button" onClick={() => setSheet('menu')} className="p-2 rounded-full hover:bg-secondary"><MoreHorizontal size={24} /></button>}
      </header>

      <main className="px-4 py-6 max-w-5xl mx-auto space-y-5">
        {/* Comentarios de la orden (los mismos del maestro): el último a la vista. */}
        {view && step >= 3 && (
          <div className="flex items-center gap-3 rounded-2xl border border-sky-500/40 bg-sky-500/5 px-4 py-3">
            <CommentsButton big count={view.comments} t={t} onClick={() => openComments(view.order)} />
            <div className="flex-1 min-w-0 text-sm">
              {view.last_comment ? (
                <span className="line-clamp-2"><b>{view.last_comment.user_name}:</b> {view.last_comment.content}</span>
              ) : <span className="text-muted-foreground">{t('ps_no_comments')}</span>}
            </div>
          </div>
        )}
        {/* 1 · Máquina */}
        {step === 1 && (
          <>
            <StepTitle n={1}>{t('ps_step_machine')}</StepTitle>
            {!machines ? <Loader2 className="animate-spin" /> : (
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {machines.map((m) => (
                  <button key={m} type="button" onClick={() => pickMachine(m)}
                    className="rounded-3xl border-2 border-border bg-card py-8 text-3xl font-black hover:border-primary active:scale-95">
                    {m.replace('MAQUINA', 'M')}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* 2 · Orden */}
        {step === 2 && (
          <>
            <StepTitle n={2}>{t('ps_step_order')}</StepTitle>
            {!station ? <Loader2 className="animate-spin" /> : station.orders.length === 0 ? (
              <div className="text-xl text-muted-foreground py-10">{t('ps_no_orders')}</div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-3">
                {station.orders.map((o) => {
                  const pct = o.quantity ? Math.min(100, Math.floor((100 * (o.packed || 0)) / o.quantity)) : 0;
                  return (
                    <button key={o.order_id} type="button" onClick={() => { setOrderId(o.order_id); setSizeKey(''); }}
                      className={`${TILE} border-border hover:border-primary`}>
                      <div className="flex items-center gap-2">
                        <span className="text-3xl font-black">#{o.order_number}</span>
                        {o.running && <span className="rounded-full bg-emerald-600 text-white px-2 py-0.5 text-xs font-black">{t('ps_running')}</span>}
                        <ChevronRight className="ml-auto text-muted-foreground" />
                      </div>
                      <div className="text-muted-foreground truncate">{o.client}{o.branding ? ` · ${o.branding}` : ''}</div>
                      <div className="text-sm font-bold mt-1">{o.packing_type || '—'} · {o.production_status || '—'}</div>
                      <div className="mt-3 h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full bg-amber-500" style={{ width: `${pct}%` }} /></div>
                      <div className="text-sm text-muted-foreground mt-1">{t('ps_packed_of', { p: n(o.packed), q: n(o.quantity) })}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* 3 · Talla */}
        {step === 3 && (!view ? <Loader2 className="animate-spin" /> : (
          <>
            <StepTitle n={3}>{t('ps_step_size')}</StepTitle>
            <div className="text-muted-foreground -mt-3">{order.client}{order.branding ? ` · ${order.branding}` : ''} · {order.packing_type || ''} · {t('ps_packed_of', { p: n(view.total_packed), q: n(view.total_ordered) })}</div>
            {canEdit && needsRatio && (
              <button type="button" onClick={() => setSheet('ratio')} className={`${BIG_BTN} bg-amber-600 text-white`}>
                <Layers /> {t('ps_setup_ratio')}
              </button>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {prepack && view.pack_size > 0 && (
                <button type="button" onClick={() => setSizeKey('PACKS')} className={`${TILE} border-amber-500/60 bg-amber-500/10`}>
                  <div className="text-4xl font-black">PACKS</div>
                  <div className="text-lg font-black text-amber-600 dark:text-amber-400">{t('ps_pack_of', { p: view.pack_size })}</div>
                  <div className="text-sm text-muted-foreground">{sizesTxt(view.prepack_ratio)}</div>
                </button>
              )}
              {view.audit.map((a) => {
                const left = a.ordered - a.packed;
                const pct = a.ordered ? Math.min(100, Math.floor((100 * a.packed) / a.ordered)) : 0;
                const tone = left < 0 ? 'border-red-500 bg-red-500/10' : left === 0 ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-border';
                return (
                  <button key={a.size} type="button" onClick={() => setSizeKey(a.size)} className={`${TILE} ${tone}`}>
                    <div className="text-5xl font-black">{a.size}</div>
                    <div className={`text-xl font-black ${left < 0 ? 'text-red-500' : left === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {left < 0 ? t('ps_over_n', { n: n(-left) }) : left === 0 ? t('ps_done') : t('ps_missing_n', { n: n(left) })}
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-secondary overflow-hidden"><div className={`h-full ${left <= 0 ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} /></div>
                    <div className="text-sm text-muted-foreground mt-1">{n(a.packed)} / {n(a.ordered)}</div>
                  </button>
                );
              })}
            </div>
            {canEdit && (
              <PalletCard t={t} v={view} busy={busy} onClosePallet={() => setSheet('pallet')}
                onNewPallet={() => act(() => post(`/pack-station/order/${orderId}/pallet/select`, { no: 0 }))} />
            )}
            {canEdit && <DplStatus t={t} v={view} busy={busy} onSync={syncDpl} />}
            {canEdit && view.box_count > 0 && (
              <button type="button" onClick={() => setSheet('finish')} className={`${BIG_BTN} border-2 border-border !py-4 !text-lg`}>
                <ClipboardCheck /> {view.finish ? t('ps_finish_edit') : t('ps_finish_open')}
              </button>
            )}
          </>
        ))}

        {/* 4 · Captura */}
        {step === 4 && view && (
          <>
            <StepTitle n={4}>{sizeKey === 'PACKS' ? t('ps_step_capture_packs') : t('ps_step_capture', { s: sizeKey })}</StepTitle>
            {!canEdit ? <div className="rounded-2xl border border-border bg-card p-4 text-muted-foreground">{t('emp_readonly')}</div> : (
              <Capture key={`${orderId}-${sizeKey}`} t={t} v={view} sizeKey={sizeKey} boxSizes={station?.box_sizes || []} busy={busy}
                onRegister={register}
                onPallet={(no) => act(() => post(`/pack-station/order/${orderId}/pallet/select`, { no }))}
                onPickSize={setSizeKey} onClosePallet={() => setSheet('pallet')} onFinish={() => setSheet('finish')}
                onDplSync={syncDpl}
                onUndo={() => window.confirm(t('ps_void_confirm')) && act(() => call(`/pack-station/boxes/${view.boxes[0].box_id}`, { method: 'DELETE' }), t('ps_box_voided'))} />
            )}
          </>
        )}
      </main>

      {sheet === 'menu' && <MenuSheet t={t} v={view} canEdit={canEdit} onClose={() => setSheet('')} onPick={setSheet} />}
      {sheet === 'packer' && (
        <PackerSheet t={t} packers={station?.packers || []} current={packer} onClose={() => setSheet('')}
          onPick={(p) => { setPacker(p); store.set(PACKER_KEY, p); setSheet(''); }} />
      )}
      {sheet === 'sizes' && <BoxSizesSheet t={t} sizes={station?.box_sizes || []} onSaved={() => loadStation()} onClose={() => setSheet('')} />}
      {sheet === 'ratio' && view && (
        <RatioSheet v={view} t={t} onClose={() => setSheet('')}
          onSave={(r) => act(() => post(`/pack-station/order/${orderId}/ratio`, { ratio: r }, 'PUT'), t('ps_ratio_saved'))} />
      )}
      {sheet === 'pallet' && view && (
        <PalletSheet v={view} t={t} busy={busy} onClose={() => setSheet('')}
          onCloseP={(body) => act(() => post(`/pack-station/order/${orderId}/pallet/close`, body), t('ps_pallet_closed'))}
          onSelect={(no) => act(() => post(`/pack-station/order/${orderId}/pallet/select`, { no }))} />
      )}
      {sheet === 'finish' && view && (
        <FinishSheet v={view} t={t} busy={busy} onClose={() => setSheet('')}
          onSave={(f) => act(() => post(`/pack-station/order/${orderId}/finish`, f, 'PUT'), t('ps_finish_saved'))} />
      )}
    </div>
  );
}
