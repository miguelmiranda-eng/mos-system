import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../App";
import { Toaster, toast } from "sonner";
import {
  ScanLine, Package, Loader2, LogOut, RefreshCw, ChevronLeft, Check, LayoutGrid,
  MapPin, CheckCircle2, AlertTriangle, Boxes, MessageSquare, Tag,
} from "lucide-react";
import { CommentsModal } from "../dashboard/CommentsModal";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
const ORDERS_API = `${process.env.REACT_APP_BACKEND_URL}/api/orders`;
const OPTIONS_URL = `${process.env.REACT_APP_BACKEND_URL}/api/config/options`;
const fetcher = (url) => fetch(`${API}${url}`, { credentials: "include" }).then(r => (r.ok ? r.json() : Promise.reject(r)));
const putter = (url, body) => fetch(`${API}${url}`, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) });

// Adult sizes first, then youth. Views filter to qty>0, so adult tickets never
// show youth rows — only youth tickets surface YS/YM/YL/etc.
const SIZES_ORDER = ["XS", "S", "M", "L", "XL", "2X", "3X", "4X", "5X", "YXS", "YS", "YM", "YL", "YXL"];
const norm = (s) => String(s || "").trim().toUpperCase();

// PDA-optimized picking surface (Zebra/Honeywell). The scanner is configured in
// DataWedge keyboard mode, so it "types" the code + Enter into the focused scan
// box. Big touch targets, one ticket at a time.
export default function PdaPicker() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user === null) navigate("/", { replace: true });
  }, [user, navigate]);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetcher("/operator/my-tickets");
      setTickets(Array.isArray(data) ? data : []);
      setSelected(prev => prev ? (data.find(t => t.ticket_id === prev.ticket_id) || null) : null);
    } catch {
      toast.error("Error al cargar tickets");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { loadTickets(); }, [loadTickets]);

  const pending = tickets.filter(t => t.picking_status !== "completed");

  // Comments: open the SAME CRM CommentsModal. Resolve the pick ticket's
  // order_number to the real CRM order (the modal keys off order_id).
  const [commentsOrder, setCommentsOrder] = useState(null);
  const openComments = async (orderNumber) => {
    try {
      const r = await fetch(`${ORDERS_API}/${encodeURIComponent(orderNumber)}`, { credentials: "include" });
      if (r.ok) setCommentsOrder(await r.json());
      else toast.error("No se encontró la orden");
    } catch { toast.error("Error de conexión"); }
  };

  const handleSave = async (ticketId, pickedSizes, isComplete) => {
    setSaving(true);
    try {
      const res = await putter(`/pick-tickets/${ticketId}/pick-progress`, { picked_sizes: pickedSizes, is_complete: isComplete });
      if (res.ok) {
        toast.success(isComplete ? "Surtido completado" : "Progreso guardado");
        if (isComplete) setSelected(null);
        await loadTickets();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "Error al guardar");
      }
    } catch { toast.error("Error de conexión"); }
    finally { setSaving(false); }
  };

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-slate-100 select-none" style={{ WebkitTapHighlightColor: "transparent" }}>
      <Toaster position="top-center" theme="dark" richColors />
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-b border-white/10 px-3 py-2.5 flex items-center gap-2">
        {selected ? (
          <button onClick={() => setSelected(null)} className="p-2 -ml-1 rounded-xl active:bg-white/10">
            <ChevronLeft className="w-6 h-6" />
          </button>
        ) : (
          <div className="w-9 h-9 rounded-xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center">
            <Boxes className="w-5 h-5 text-blue-300" />
          </div>
        )}
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Surtido PDA</div>
          <div className="text-sm font-black truncate">{selected ? selected.order_number : (user?.name || user?.email || "Picker")}</div>
        </div>
        {!selected && (
          <span className="px-2.5 py-1 rounded-lg bg-blue-500/15 text-blue-300 text-xs font-black">{pending.length} pend.</span>
        )}
        {selected && (
          <button onClick={() => openComments(selected.order_number)} className="p-2 rounded-xl text-sky-300 active:bg-white/10" title="Comentarios"><MessageSquare className="w-5 h-5" /></button>
        )}
        {!selected && (
          <button onClick={() => navigate('/wms')} className="p-2 rounded-xl text-amber-300 active:bg-white/10" title="Menú (Picking / Putaway)"><LayoutGrid className="w-5 h-5" /></button>
        )}
        <button onClick={loadTickets} className="p-2 rounded-xl active:bg-white/10"><RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} /></button>
        <button onClick={logout} className="p-2 rounded-xl text-red-400 active:bg-red-500/10"><LogOut className="w-5 h-5" /></button>
      </header>

      {loading && tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 gap-3 text-slate-400">
          <Loader2 className="w-9 h-9 animate-spin text-blue-400" />
          <span className="text-xs font-bold uppercase tracking-widest">Cargando…</span>
        </div>
      ) : selected ? (
        <PickScreen ticket={selected} onSave={handleSave} saving={saving} />
      ) : (
        <TicketList tickets={pending} onSelect={setSelected} onComments={openComments} />
      )}

      <CommentsModal order={commentsOrder} isOpen={!!commentsOrder} onClose={() => setCommentsOrder(null)} currentUser={user} />
    </div>
  );
}

function TicketList({ tickets, onSelect, onComments }) {
  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-3 text-slate-500">
        <CheckCircle2 className="w-12 h-12 opacity-40" />
        <span className="text-sm font-black uppercase tracking-widest">Sin surtidos pendientes</span>
      </div>
    );
  }
  return (
    <div className="p-3 space-y-2.5">
      {tickets.map(t => {
        const sizes = t.sizes || {};
        const totalQty = Object.values(sizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
        const picked = Object.values(t.picked_sizes || {}).reduce((s, v) => s + (parseInt(v?.total) || 0), 0);
        const pct = totalQty > 0 ? Math.round((picked / totalQty) * 100) : 0;
        return (
          <div key={t.ticket_id} role="button" tabIndex={0} onClick={() => onSelect(t)}
            className="w-full text-left bg-[#131a2b] border border-white/10 rounded-2xl p-4 active:scale-[0.99] transition-transform cursor-pointer">
            <div className="flex items-center justify-between gap-2">
              <div className="text-2xl font-black tracking-tight">{t.order_number}</div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-black uppercase tracking-wider text-slate-400">{totalQty} pz</span>
                <button onClick={(e) => { e.stopPropagation(); onComments?.(t.order_number); }}
                  className="p-2 -my-1 rounded-xl text-sky-300 active:bg-white/10" title="Comentarios">
                  <MessageSquare className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <span className="px-2 py-0.5 rounded-md bg-blue-500/15 text-blue-300 text-xs font-mono font-black">{t.style}</span>
              {t.color && <span className="px-2 py-0.5 rounded-md bg-white/5 text-slate-300 text-xs font-bold">{t.color}</span>}
              {t.customer && <span className="text-[11px] text-slate-500 truncate">{t.customer}</span>}
            </div>
            <div className="mt-2.5 h-2 bg-white/10 rounded-full overflow-hidden">
              <div className={`h-full ${pct >= 100 ? "bg-emerald-500" : pct > 0 ? "bg-amber-500" : "bg-slate-600"}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="text-[10px] font-mono text-slate-500 mt-1">{picked}/{totalQty} · {pct}%</div>
          </div>
        );
      })}
    </div>
  );
}

function PickScreen({ ticket, onSave, saving }) {
  const [pickedSizes, setPickedSizes] = useState({});
  const [openSize, setOpenSize] = useState(null);
  const [scan, setScan] = useState("");
  const [scanHit, setScanHit] = useState(null); // {sz, location}
  const scanRef = useRef(null);
  // True while a qty field is being edited — suspends the scan box's aggressive
  // auto-refocus so the operator can actually type a quantity (instead of being
  // forced to tap −/+ one unit at a time).
  const editingRef = useRef(false);

  // MOS blank status — let the operator update the order's blank_status from the
  // picking screen. Resolved from the real CRM order (the ticket only carries
  // the order_number).
  const [orderId, setOrderId] = useState(null);
  const [blankStatus, setBlankStatus] = useState("");
  const [blankOptions, setBlankOptions] = useState([]);
  const [savingStatus, setSavingStatus] = useState(false);

  useEffect(() => {
    setPickedSizes(ticket.picked_sizes || {});
    setOpenSize(null);
    setScanHit(null);
  }, [ticket]);

  useEffect(() => {
    let alive = true;
    fetch(`${ORDERS_API}/${encodeURIComponent(ticket.order_number)}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(o => { if (alive && o) { setOrderId(o.order_id); setBlankStatus(o.blank_status || ""); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [ticket.order_number]);

  useEffect(() => {
    let alive = true;
    fetch(OPTIONS_URL, { credentials: "include" })
      .then(r => (r.ok ? r.json() : {}))
      .then(o => { if (alive) setBlankOptions(o.blank_statuses || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const updateBlankStatus = async (val) => {
    if (!orderId) { toast.error("Orden aún no carga, intenta de nuevo"); return; }
    const prev = blankStatus;
    setBlankStatus(val);
    setSavingStatus(true);
    try {
      const r = await fetch(`${ORDERS_API}/${orderId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ blank_status: val }),
      });
      if (r.ok) { toast.success("Blank status actualizado"); }
      else { setBlankStatus(prev); toast.error("No se pudo actualizar el status"); }
    } catch { setBlankStatus(prev); toast.error("Error de conexión"); }
    finally { setSavingStatus(false); }
  };

  const sizes = ticket.sizes || {};
  const sizeLocs = ticket.size_locations || {};
  const activeSizes = SIZES_ORDER.filter(sz => parseInt(sizes[sz]) > 0);

  const locsFor = (sz) => {
    const l = sizeLocs[sz]?.locations || sizeLocs[sz] || [];
    return Array.isArray(l) ? l : [];
  };

  const updatePicked = (sz, loc, val) => {
    const target = locsFor(sz).find(l => l.location === loc);
    if (!target) return;
    const numVal = Math.max(0, Math.min(parseInt(val) || 0, target.available));
    setPickedSizes(p => {
      const cur = p[sz] || { total: 0, details: {} };
      const details = { ...cur.details, [loc]: numVal };
      const total = Object.values(details).reduce((a, b) => a + b, 0);
      const required = parseInt(sizes[sz]) || 0;
      if (total > required) { toast.error(`Máximo ${required} para talla ${sz}`); return p; }
      return { ...p, [sz]: { total, details } };
    });
  };

  // Scanner (DataWedge keyboard mode): types the code + Enter into this box.
  const handleScan = (raw) => {
    // Strip any scanner preamble/prefix (e.g. "%-") before matching — the label
    // barcodes are clean Code128 of the location name. Locations always start
    // with a letter/digit, so dropping leading non-alphanumerics is safe.
    const code = norm(raw).replace(/^[^A-Z0-9]+/, "");
    setScan("");
    if (!code) return;
    // A single shelf can hold several sizes of the same style. Collect EVERY
    // active size that has this location so the operator sees all of them, not
    // just the first match (the old loop returned on the first hit).
    const matches = [];
    let matchedLocation = "";
    for (const sz of activeSizes) {
      const hit = locsFor(sz).find(l => norm(l.location) === code);
      if (hit) { matches.push(sz); matchedLocation = hit.location; }
    }
    if (matches.length === 0) {
      toast.error(`Ubicación "${code}" no pertenece a este surtido`);
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      return;
    }
    setOpenSize(matches[0]);
    setScanHit({ location: matchedLocation, sizes: matches });
    toast.success(matches.length > 1
      ? `Ubicación ${matchedLocation} · tallas ${matches.join(", ")}`
      : `Ubicación ${matchedLocation} · talla ${matches[0]}`);
    if (navigator.vibrate) navigator.vibrate(60);
  };

  const totalRequired = activeSizes.reduce((s, sz) => s + (parseInt(sizes[sz]) || 0), 0);
  const totalPicked = activeSizes.reduce((s, sz) => s + (parseInt(pickedSizes[sz]?.total) || 0), 0);
  const isComplete = totalPicked >= totalRequired && totalRequired > 0;

  return (
    <div className="pb-28">
      {/* Ticket info + scan box */}
      <div className="p-3 space-y-3">
        <div className="bg-[#131a2b] border border-white/10 rounded-2xl p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2 py-0.5 rounded-md bg-blue-500/15 text-blue-300 text-sm font-mono font-black">{ticket.style}</span>
            {ticket.color && <span className="px-2 py-0.5 rounded-md bg-white/5 text-slate-200 text-sm font-bold">{ticket.color}</span>}
            <span className="ml-auto text-xs font-black text-slate-400">{ticket.customer}</span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs font-black uppercase tracking-widest text-slate-400">Total</span>
            <span className={`text-sm font-black ${isComplete ? "text-emerald-400" : "text-amber-400"}`}>{totalPicked} / {totalRequired} pz</span>
          </div>
          <div className="mt-1.5 h-2.5 bg-white/10 rounded-full overflow-hidden">
            <div className={`h-full ${isComplete ? "bg-emerald-500" : totalPicked > 0 ? "bg-amber-500" : "bg-slate-600"}`} style={{ width: `${totalRequired > 0 ? Math.round((totalPicked / totalRequired) * 100) : 0}%` }} />
          </div>

          {/* MOS blank status — editable from the picking screen */}
          <div className="mt-3 pt-3 border-t border-white/10">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Tag className="w-3.5 h-3.5 text-blue-300" />
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Blank Status (MOS)</span>
              {savingStatus && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-300 ml-auto" />}
            </div>
            <select
              value={blankStatus}
              onChange={(e) => updateBlankStatus(e.target.value)}
              onFocus={() => { editingRef.current = true; }}
              onBlur={() => { editingRef.current = false; setTimeout(() => { if (!editingRef.current) scanRef.current?.focus(); }, 50); }}
              disabled={savingStatus || !orderId}
              className="w-full h-12 bg-black/30 border border-white/10 rounded-xl px-3 text-base font-bold focus:outline-none focus:border-blue-400 disabled:opacity-50"
            >
              <option value="">— Sin status —</option>
              {blankOptions.map(s => <option key={s} value={s}>{s}</option>)}
              {blankStatus && !blankOptions.includes(blankStatus) && (
                <option value={blankStatus}>{blankStatus}</option>
              )}
            </select>
          </div>
        </div>

        <div className="relative">
          <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-blue-400" />
          <input
            ref={scanRef}
            autoFocus
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleScan(scan); } }}
            onBlur={() => setTimeout(() => { if (!editingRef.current) scanRef.current?.focus(); }, 50)}
            inputMode="none"
            placeholder="Escanea la ubicación…"
            className="w-full h-14 pl-12 pr-3 bg-[#131a2b] border-2 border-blue-500/40 rounded-2xl text-lg font-bold focus:outline-none focus:border-blue-400"
          />
        </div>
      </div>

      {/* Sizes */}
      <div className="px-3 space-y-2">
        {activeSizes.map(sz => {
          const required = parseInt(sizes[sz]) || 0;
          const data = pickedSizes[sz] || { total: 0, details: {} };
          const picked = data.total;
          const done = picked >= required;
          const isOpen = openSize === sz;
          const locs = locsFor(sz);
          return (
            <div key={sz} className={`rounded-2xl border overflow-hidden ${done ? "border-emerald-500/40 bg-emerald-500/5" : "border-white/10 bg-[#131a2b]"}`}>
              <button onClick={() => setOpenSize(isOpen ? null : sz)} className="w-full flex items-center gap-3 p-3.5 active:bg-white/5">
                {done ? <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" /> : <Package className="w-6 h-6 text-slate-400 shrink-0" />}
                <div className="flex-1 text-left">
                  <div className="text-xl font-black">{sz}</div>
                  <div className="text-[11px] text-slate-400">Requerido: {required}</div>
                </div>
                <div className={`min-w-[64px] px-3 py-2 rounded-xl text-center text-xl font-mono font-black ${done ? "bg-emerald-500/20 text-emerald-300" : "bg-white/5"}`}>{picked}</div>
              </button>

              {isOpen && (
                <div className="px-3 pb-3 pt-1 border-t border-white/10 space-y-2">
                  {locs.length === 0 ? (
                    <div className="flex items-center gap-2 text-amber-400 py-2">
                      <AlertTriangle className="w-5 h-5 shrink-0" />
                      <span className="text-xs font-bold">Sin stock para esta talla/color.</span>
                    </div>
                  ) : locs.map((l, i) => {
                    const cur = data.details[l.location] || 0;
                    const hit = scanHit && scanHit.location === l.location;
                    const need = required - picked + cur;
                    return (
                      <div key={i} className={`rounded-xl border p-3 ${hit ? "border-blue-400 ring-2 ring-blue-400/40 bg-blue-500/10" : "border-white/10 bg-black/20"}`}>
                        <div className="flex items-center justify-between">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <MapPin className="w-4 h-4 text-blue-300 shrink-0" />
                              <span className="font-mono font-black text-blue-300 text-base">{l.location}</span>
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">Disp: <b className="text-emerald-400">{l.available}</b>{l.country_of_origin ? ` · ${l.country_of_origin}` : ""}</div>
                          </div>
                          <button onClick={() => {
                              updatePicked(sz, l.location, Math.min(need, l.available));
                              // Drop straight into the field so they can correct the
                              // amount by typing instead of tapping − repeatedly.
                              editingRef.current = true;
                              const el = document.getElementById(`pick-${sz}-${i}`);
                              if (el) { el.focus(); el.select(); }
                            }}
                            className="px-3 py-2 rounded-xl bg-blue-600 active:bg-blue-700 text-white text-xs font-black uppercase tracking-widest">MAX</button>
                        </div>
                        <div className="mt-2.5 flex items-center gap-2">
                          <button onClick={() => updatePicked(sz, l.location, cur - 1)} className="w-12 h-12 rounded-xl bg-white/5 active:bg-white/10 text-2xl font-black">−</button>
                          <input
                            id={`pick-${sz}-${i}`}
                            type="number" inputMode="numeric" min="0" max={l.available}
                            value={cur || ""}
                            onChange={(e) => updatePicked(sz, l.location, e.target.value)}
                            onFocus={(e) => { editingRef.current = true; e.target.select(); }}
                            onBlur={() => { editingRef.current = false; setTimeout(() => { if (!editingRef.current) scanRef.current?.focus(); }, 50); }}
                            placeholder="0"
                            className="flex-1 h-12 bg-black/30 border border-white/10 rounded-xl text-center text-2xl font-mono font-black focus:outline-none focus:border-blue-400"
                          />
                          <button onClick={() => updatePicked(sz, l.location, cur + 1)} className="w-12 h-12 rounded-xl bg-white/5 active:bg-white/10 text-2xl font-black">＋</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-t border-white/10 p-3 flex gap-2">
        <button onClick={() => onSave(ticket.ticket_id, pickedSizes, false)} disabled={saving}
          className="flex-1 h-14 rounded-2xl bg-white/10 active:bg-white/20 text-sm font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-50">
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />} Guardar
        </button>
        <button onClick={() => onSave(ticket.ticket_id, pickedSizes, true)} disabled={saving || totalPicked === 0}
          className={`flex-1 h-14 rounded-2xl text-sm font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-50 ${isComplete ? "bg-emerald-600 active:bg-emerald-700" : "bg-amber-600 active:bg-amber-700"} text-white`}>
          <CheckCircle2 className="w-5 h-5" /> {isComplete ? "Completar" : "Completar parcial"}
        </button>
      </div>
    </div>
  );
}
