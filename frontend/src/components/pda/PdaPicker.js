import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../App";
import { Toaster, toast } from "sonner";
import {
  ScanLine, Package, Loader2, LogOut, RefreshCw, ChevronLeft, LayoutGrid,
  MapPin, CheckCircle2, AlertTriangle, Boxes, MessageSquare, Tag, Search, ClipboardCheck,
  QrCode, X, Barcode,
} from "lucide-react";
import { CommentsModal } from "../dashboard/CommentsModal";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
const ORDERS_API = `${process.env.REACT_APP_BACKEND_URL}/api/orders`;
const OPTIONS_URL = `${process.env.REACT_APP_BACKEND_URL}/api/config/options`;
const fetcher = (url) => fetch(`${API}${url}`, { credentials: "include" }).then(r => (r.ok ? r.json() : Promise.reject(r)));
const putter = (url, body) => fetch(`${API}${url}`, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) });

// Size rows are derived from the ticket's own `sizes` (qty>0), so ANY size the
// ticket carries — standard or admin-configured extra — surfaces automatically.
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
  const [locatorOpen, setLocatorOpen] = useState(false); // box→location lookup (Case# 004)
  // Fallo de descuento en tiempo real → modal BLOQUEANTE. Un toast se
  // desvanece y el surtidor puede seguir pickeando creyendo que desconto;
  // el modal obliga a enterarse (era la receta del inventario fantasma).
  const [errorModal, setErrorModal] = useState(null); // { title, message }

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

  // Per-size immediate deduction: the instant the operator OKs a size, the
  // material leaves inventory — no waiting for full/partial completion. Does NOT
  // reload the ticket list (keeps the operator's in-progress local state); the
  // size row flips to "descontado" locally on success.
  const handlePickSize = async (ticketId, size, details) => {
    try {
      const res = await putter(`/pick-tickets/${ticketId}/pick-size`, { size, details });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.success(data.message || `Talla ${size} descontada`);
        if (navigator.vibrate) navigator.vibrate(60);
        return true;
      }
      const err = await res.json().catch(() => ({}));
      setErrorModal({
        title: `NO se descontó la talla ${size}`,
        message: err.detail || "El servidor rechazó el descuento. El inventario NO se movió — verifica el stock de esa talla antes de continuar.",
      });
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      return false;
    } catch {
      setErrorModal({
        title: `NO se descontó la talla ${size}`,
        message: "Sin conexión con el servidor. El inventario NO se movió — reintenta cuando vuelva la señal.",
      });
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      return false;
    }
  };

  const handleSave = async (ticketId, pickedSizes, isComplete) => {
    setSaving(true);
    try {
      const res = await putter(`/pick-tickets/${ticketId}/pick-progress`, { picked_sizes: pickedSizes, is_complete: isComplete });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        // A partial "complete" no longer closes the ticket — it stays active for
        // an admin to reassign on restock (Case# 005). Reflect that honestly.
        if (isComplete && data.partial_closed) {
          toast.success("Cerrado parcial — material descontado, el ticket queda activo");
          setSelected(null);
        } else if (isComplete) {
          toast.success("Surtido completado");
          setSelected(null);
        } else {
          toast.success("Progreso guardado");
        }
        await loadTickets();
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorModal({
          title: "NO se guardó el surtido",
          message: err.detail || "El servidor rechazó el guardado. El progreso y el descuento NO se aplicaron.",
        });
        if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      }
    } catch {
      setErrorModal({
        title: "NO se guardó el surtido",
        message: "Sin conexión con el servidor. El progreso y el descuento NO se aplicaron — reintenta cuando vuelva la señal.",
      });
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    }
    finally { setSaving(false); }
  };

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-slate-100 select-none" style={{ WebkitTapHighlightColor: "transparent" }}>
      <Toaster position="top-center" theme="dark" richColors />

      {/* Modal BLOQUEANTE de fallo de descuento: no desaparece solo, hay que
          tocar ENTENDIDO. Un error de descuento ignorado = inventario fantasma. */}
      {errorModal && (
        <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-5">
          <div className="w-full max-w-sm bg-[#1a0f0f] border-2 border-red-500 rounded-2xl p-5 text-center shadow-[0_0_40px_rgba(239,68,68,0.4)]">
            <div className="mx-auto w-14 h-14 rounded-full bg-red-500/20 border border-red-500/50 flex items-center justify-center mb-3">
              <AlertTriangle className="w-8 h-8 text-red-400" />
            </div>
            <div className="text-lg font-black uppercase tracking-wide text-red-300 mb-2">{errorModal.title}</div>
            <div className="text-sm text-slate-200 leading-snug mb-5">{errorModal.message}</div>
            <button
              onClick={() => setErrorModal(null)}
              className="w-full py-4 rounded-xl bg-red-500 text-white text-base font-black uppercase tracking-widest active:bg-red-600"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-b border-white/10 px-3 py-2.5 flex items-center gap-2">
        {(selected || locatorOpen) ? (
          <button onClick={() => { if (selected) setSelected(null); else setLocatorOpen(false); }} className="p-2 -ml-1 rounded-xl active:bg-white/10">
            <ChevronLeft className="w-6 h-6" />
          </button>
        ) : (
          <div className="w-9 h-9 rounded-xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center">
            <Boxes className="w-5 h-5 text-blue-300" />
          </div>
        )}
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">{locatorOpen ? "Buscar caja" : "Surtido PDA"}</div>
          <div className="text-sm font-black truncate">{selected ? selected.order_number : locatorOpen ? "Localizar caja" : (user?.name || user?.email || "Picker")}</div>
        </div>
        {!selected && !locatorOpen && (
          <span className="px-2.5 py-1 rounded-lg bg-blue-500/15 text-blue-300 text-xs font-black">{pending.length} pend.</span>
        )}
        {selected && (
          <button onClick={() => openComments(selected.order_number)} className="p-2 rounded-xl text-sky-300 active:bg-white/10" title="Comentarios"><MessageSquare className="w-5 h-5" /></button>
        )}
        {!selected && !locatorOpen && (
          <button onClick={() => navigate('/pda-recon')} className="p-2 rounded-xl text-emerald-300 active:bg-white/10" title="Conciliación"><ClipboardCheck className="w-5 h-5" /></button>
        )}
        {!selected && !locatorOpen && (
          <button onClick={() => setLocatorOpen(true)} className="p-2 rounded-xl text-emerald-300 active:bg-white/10" title="Localizar caja"><Search className="w-5 h-5" /></button>
        )}
        {!selected && !locatorOpen && (
          <button onClick={() => navigate('/wms')} className="p-2 rounded-xl text-amber-300 active:bg-white/10" title="Menú (Picking / Putaway)"><LayoutGrid className="w-5 h-5" /></button>
        )}
        {!locatorOpen && (
          <button onClick={loadTickets} className="p-2 rounded-xl active:bg-white/10"><RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} /></button>
        )}
        <button onClick={logout} className="p-2 rounded-xl text-red-400 active:bg-red-500/10"><LogOut className="w-5 h-5" /></button>
      </header>

      {locatorOpen ? (
        <BoxLocator />
      ) : loading && tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 gap-3 text-slate-400">
          <Loader2 className="w-9 h-9 animate-spin text-blue-400" />
          <span className="text-xs font-bold uppercase tracking-widest">Cargando…</span>
        </div>
      ) : selected ? (
        <PickScreen ticket={selected} onSave={handleSave} onPickSize={handlePickSize} saving={saving} />
      ) : (
        <TicketList tickets={pending} onSelect={setSelected} onComments={openComments} />
      )}

      <CommentsModal order={commentsOrder} isOpen={!!commentsOrder} onClose={() => setCommentsOrder(null)} currentUser={user} />
    </div>
  );
}

// Box → location lookup for the floor (Case# 004). Scan a box / LPN and see
// where it is, for which customer and what it holds. Read-only; no movement.
function BoxLocator() {
  const [scan, setScan] = useState("");
  const [box, setBox] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const ref = useRef(null);

  const doSearch = async (raw) => {
    const code = norm(raw).replace(/^[^A-Z0-9]+/, "");
    setScan("");
    if (!code) return;
    setLoading(true);
    setSearched(true);
    try {
      const b = await fetcher(`/boxes/${encodeURIComponent(code)}`);
      const ok = b && b.box_id;
      setBox(ok ? b : null);
      if (!ok && navigator.vibrate) navigator.vibrate([60, 40, 60]);
      else if (ok && navigator.vibrate) navigator.vibrate(60);
    } catch {
      setBox(null);
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    } finally {
      setLoading(false);
      setTimeout(() => ref.current?.focus(), 50);
    }
  };

  return (
    <div className="p-3 space-y-3">
      {/* Scan box */}
      <div className="relative">
        <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-emerald-400" />
        <input
          ref={ref}
          autoFocus
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(scan); } }}
          inputMode="none"
          placeholder="Escanea el número de caja / LPN…"
          className="w-full h-14 pl-12 pr-3 bg-[#131a2b] border-2 border-emerald-500/40 rounded-2xl text-lg font-bold focus:outline-none focus:border-emerald-400"
        />
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-slate-400">
          <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
          <span className="text-xs font-bold uppercase tracking-widest">Buscando…</span>
        </div>
      )}

      {!loading && box && (
        <div className="bg-[#131a2b] border border-white/10 rounded-2xl p-4 space-y-4">
          <div className="text-center">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Ubicación</div>
            <div className="inline-flex items-center gap-2 px-4 py-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/30">
              <MapPin className="w-6 h-6 text-emerald-300" />
              <span className="text-3xl font-mono font-black text-emerald-300">{box.location || "—"}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-1 border-t border-white/10">
            <div className="min-w-0">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Caja</div>
              <div className="text-sm font-mono font-black truncate">{box.box_id}</div>
            </div>
            <div className="min-w-0 text-right">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Unidades</div>
              <div className="text-sm font-black">{box.units ?? box.qty ?? 0}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Cliente</div>
              <div className="text-sm font-bold truncate">{box.customer || "—"}</div>
            </div>
            <div className="min-w-0 text-right">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Estado</div>
              <div className="text-sm font-bold truncate">{box.status || box.state || "—"}</div>
            </div>
            <div className="col-span-2 min-w-0">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Contenido</div>
              <div className="text-base font-black flex items-center gap-2 flex-wrap mt-0.5">
                <span className="px-2 py-0.5 rounded-md bg-blue-500/15 text-blue-300 font-mono">{box.style || box.sku}</span>
                {box.color && <span className="px-2 py-0.5 rounded-md bg-white/5 text-slate-200 text-sm">{box.color}</span>}
                {box.size && <span className="px-2 py-0.5 rounded-md bg-white/5 text-slate-200 text-sm">{box.size}</span>}
              </div>
              {box.description && <div className="text-[11px] text-slate-400 mt-1 truncate">{box.description}</div>}
            </div>
          </div>
        </div>
      )}

      {!loading && searched && !box && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-amber-400">
          <AlertTriangle className="w-10 h-10" />
          <span className="text-sm font-black uppercase tracking-widest">Caja no encontrada</span>
        </div>
      )}

      {!loading && !searched && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-slate-500">
          <Search className="w-10 h-10 opacity-40" />
          <span className="text-xs font-bold uppercase tracking-widest text-center">Escanea una caja para ver su ubicación</span>
        </div>
      )}
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

function PickScreen({ ticket, onSave, onPickSize, saving }) {
  const [pickedSizes, setPickedSizes] = useState({});
  // Sizes already OK'd → deducted from inventory. Locked from further edits
  // unless the operator explicitly re-opens to correct.
  const [committed, setCommitted] = useState(() => new Set());
  const [committing, setCommitting] = useState(null); // size being OK'd right now
  const [openSize, setOpenSize] = useState(null);
  const [scan, setScan] = useState("");
  const [scanHit, setScanHit] = useState(null); // {sz, location}
  const scanRef = useRef(null);
  // Box-scan state: por cada (talla, ubicación) guardamos la caja física
  // identificada por LPN. Sin scan no se puede OK'ear (require_scan=true).
  const [pickedBoxes, setPickedBoxes] = useState({});  // { sz: { loc: {box_id, units} } }
  const [scanningCell, setScanningCell] = useState(null);   // { sz, loc } → abre modal scan
  const [bindingModal, setBindingModal] = useState(null);   // {lpn, location, ticket_context, sizes_needed}
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
    // A size present in the server's picked_sizes with units was already
    // deducted (per-size OK or a prior save) → start it locked.
    setCommitted(new Set(
      Object.entries(ticket.picked_sizes || {})
        .filter(([, v]) => (parseInt(v?.total ?? v) || 0) > 0)
        .map(([k]) => k)
    ));
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
  const activeSizes = Object.keys(sizes).filter(sz => parseInt(sizes[sz]) > 0);

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

  // OK a single size → deduct it from inventory NOW. Locks the row on success.
  const okSize = async (sz) => {
    const data = pickedSizes[sz] || { total: 0, details: {} };
    const details = data.details || {};
    const total = Object.values(details).reduce((a, b) => a + (parseInt(b) || 0), 0);
    if (total <= 0) { toast.error(`Captura cantidades para la talla ${sz}`); return; }

    // Cada celda con qty>0 debe tener una caja escaneada. Sin scan no
    // se descuenta — el sistema rechaza igual el backend.
    const boxes = pickedBoxes[sz] || {};
    const missing = Object.entries(details).filter(([loc, qty]) => (parseInt(qty)||0) > 0 && !boxes[loc]?.box_id);
    if (missing.length) {
      toast.error(`Escanea la caja para ${missing.map(([l])=>l).join(', ')}`);
      return;
    }
    // Estructura nueva: { loc: {qty, box_id} } en lugar de { loc: qty }
    const detailsWithBoxes = Object.fromEntries(
      Object.entries(details).map(([loc, qty]) => [loc, {
        qty: parseInt(qty) || 0,
        box_id: boxes[loc]?.box_id || null,
      }])
    );
    setCommitting(sz);
    const ok = await onPickSize(ticket.ticket_id, sz, detailsWithBoxes);
    setCommitting(null);
    if (ok) {
      setCommitted(prev => new Set(prev).add(sz));
      setOpenSize(null);
    }
  };

  // ── Box scan (por celda) ─────────────────────────────────────────────────
  const handleBoxScan = async (rawLpn) => {
    if (!scanningCell) return;
    const { sz, loc } = scanningCell;
    const lpn = String(rawLpn || "").trim();
    if (!lpn) return;
    try {
      const r = await fetch(`${API}/pick-tickets/${ticket.ticket_id}/scan-box`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lpn, location: loc }),
      });
      const data = await r.json();
      if (!r.ok) { toast.error(data.detail || "Error al escanear"); return; }
      if (data.status === "matched") {
        setPickedBoxes(p => ({
          ...p,
          [sz]: { ...(p[sz]||{}), [loc]: { box_id: data.box.box_id, units: data.box.units, lpn } },
        }));
        setScanningCell(null);
        toast.success(`Caja ${data.box.box_id} identificada (${data.box.units} pz)`);
        if (navigator.vibrate) navigator.vibrate(60);
      } else if (data.status === "wrong_ticket") {
        toast.error(data.message || "La caja escaneada no es de este ticket");
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      } else if (data.status === "needs_binding") {
        setScanningCell(null);
        setBindingModal({ ...data, cell: { sz, loc } });
      }
    } catch (e) { toast.error("Error de conexión al escanear"); }
  };

  const submitBinding = async ({ size, actual_units }) => {
    if (!bindingModal) return;
    const { lpn, location, cell } = bindingModal;
    try {
      const r = await fetch(`${API}/pick-tickets/${ticket.ticket_id}/bind-box`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lpn, location, size, actual_units }),
      });
      const data = await r.json();
      if (!r.ok) { toast.error(data.detail || "Error al ligar caja"); return; }
      // El bind mueve al cell que iniciamos el scan (mantenemos loc + cambiamos sz si hizo falta)
      const targetSz = cell?.sz || size;
      const targetLoc = cell?.loc || location;
      setPickedBoxes(p => ({
        ...p,
        [targetSz]: { ...(p[targetSz]||{}), [targetLoc]: {
          box_id: data.box.box_id, units: data.box.units, lpn,
        }},
      }));
      setBindingModal(null);
      toast.success(data.reconciled
        ? `Caja ligada + inventario ajustado (${data.delta>0?'+':''}${data.delta})`
        : `Caja ${data.box.box_id} ligada`);
      if (navigator.vibrate) navigator.vibrate(80);
    } catch (e) { toast.error("Error de conexión al ligar"); }
  };

  // Reopen an already-deducted size to correct it (re-OK applies the delta).
  const editSize = (sz) => {
    setCommitted(prev => { const n = new Set(prev); n.delete(sz); return n; });
    setOpenSize(sz);
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
  // Deducted = sizes already OK'd. Progress + completion act on THIS, not on
  // typed-but-not-OK'd numbers (those haven't left inventory).
  const totalCommitted = activeSizes.reduce(
    (s, sz) => s + (committed.has(sz) ? (parseInt(pickedSizes[sz]?.total) || 0) : 0), 0);
  const committedPicked = () => {
    const out = {};
    activeSizes.forEach(sz => { if (committed.has(sz) && pickedSizes[sz]) out[sz] = pickedSizes[sz]; });
    return out;
  };
  const isComplete = totalCommitted >= totalRequired && totalRequired > 0;

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
            <span className="text-xs font-black uppercase tracking-widest text-slate-400">Descontado</span>
            <span className={`text-sm font-black ${isComplete ? "text-emerald-400" : "text-amber-400"}`}>{totalCommitted} / {totalRequired} pz</span>
          </div>
          <div className="mt-1.5 h-2.5 bg-white/10 rounded-full overflow-hidden">
            <div className={`h-full ${isComplete ? "bg-emerald-500" : totalCommitted > 0 ? "bg-amber-500" : "bg-slate-600"}`} style={{ width: `${totalRequired > 0 ? Math.round((totalCommitted / totalRequired) * 100) : 0}%` }} />
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
          const isCommitted = committed.has(sz);
          const isOpen = openSize === sz;
          const locs = locsFor(sz);
          return (
            <div key={sz} className={`rounded-2xl border overflow-hidden ${isCommitted ? "border-emerald-500/60 bg-emerald-500/10" : "border-white/10 bg-[#131a2b]"}`}>
              <button onClick={() => isCommitted ? editSize(sz) : setOpenSize(isOpen ? null : sz)} className="w-full flex items-center gap-3 p-3.5 active:bg-white/5">
                {isCommitted ? <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" /> : <Package className="w-6 h-6 text-slate-400 shrink-0" />}
                <div className="flex-1 text-left">
                  <div className="text-xl font-black flex items-center gap-2">{sz}
                    {isCommitted && <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 text-[9px] font-black uppercase tracking-widest">Descontado</span>}
                  </div>
                  <div className="text-[11px] text-slate-400">Requerido: {required}{isCommitted ? " · toca para corregir" : ""}</div>
                </div>
                <div className={`min-w-[64px] px-3 py-2 rounded-xl text-center text-xl font-mono font-black ${isCommitted ? "bg-emerald-500/20 text-emerald-300" : "bg-white/5"}`}>{picked}</div>
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
                        {/* Fila del scan de caja: obligatoria para poder OK-ear */}
                        {(() => {
                          const boxInfo = (pickedBoxes[sz] || {})[l.location];
                          if (boxInfo?.box_id) {
                            return (
                              <div className="mt-2 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
                                <Barcode className="w-4 h-4 text-emerald-300 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] font-black text-emerald-300 truncate">
                                    Caja: {boxInfo.box_id}
                                    {boxInfo.lpn && boxInfo.lpn !== boxInfo.box_id && (
                                      <span className="ml-1 opacity-70 font-mono">({boxInfo.lpn})</span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-emerald-400/80">{boxInfo.units} pz en caja</div>
                                </div>
                                <button onClick={() => {
                                    setPickedBoxes(p => {
                                      const cp = { ...(p[sz]||{}) }; delete cp[l.location];
                                      return { ...p, [sz]: cp };
                                    });
                                    setScanningCell({ sz, loc: l.location });
                                  }}
                                  className="px-2 py-1 rounded-md bg-white/10 active:bg-white/20 text-[10px] font-black uppercase tracking-widest">
                                  Cambiar
                                </button>
                              </div>
                            );
                          }
                          return (
                            <button onClick={() => setScanningCell({ sz, loc: l.location })}
                              className="mt-2 w-full h-12 rounded-xl bg-blue-600/20 border-2 border-dashed border-blue-500/50 active:bg-blue-600/30 text-blue-300 text-sm font-black uppercase tracking-widest flex items-center justify-center gap-2">
                              <QrCode className="w-5 h-5" /> Escanear caja
                            </button>
                          );
                        })()}
                      </div>
                    );
                  })}
                  {locs.length > 0 && (
                    <button
                      onClick={() => okSize(sz)}
                      disabled={committing === sz || (data.total || 0) <= 0}
                      className="w-full h-12 rounded-xl bg-emerald-600 active:bg-emerald-700 text-white text-sm font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40">
                      {committing === sz ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                      OK · Descontar {data.total || 0} pz
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Sticky action bar — material already leaves inventory per-size as it's
          OK'd above; this button only finalizes the ticket (full or partial). */}
      <div className="fixed bottom-0 inset-x-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-t border-white/10 p-3">
        <button onClick={() => onSave(ticket.ticket_id, committedPicked(), true)} disabled={saving || totalCommitted === 0}
          className={`w-full h-14 rounded-2xl text-sm font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-50 ${isComplete ? "bg-emerald-600 active:bg-emerald-700" : "bg-amber-600 active:bg-amber-700"} text-white`}>
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />} {isComplete ? "Completar surtido" : "Cerrar parcial"}
        </button>
      </div>

      {/* Modal: input de scan de caja física */}
      {scanningCell && (
        <BoxScanModal
          cell={scanningCell}
          onClose={() => setScanningCell(null)}
          onScan={handleBoxScan}
        />
      )}

      {/* Modal: cuestionario de binding cuando el LPN no está registrado */}
      {bindingModal && (
        <BoxBindModal
          info={bindingModal}
          onClose={() => setBindingModal(null)}
          onSubmit={submitBinding}
        />
      )}
    </div>
  );
}

// ═════════════ BoxScanModal ═════════════════════════════════════════════════
// Input focused para DataWedge (keyboard mode). El scanner "teclea" el LPN +
// Enter directo en el input. Textbox grande para modo manual también.
function BoxScanModal({ cell, onClose, onScan }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#131a2b] border border-blue-500/40 rounded-2xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-black uppercase tracking-widest text-blue-300 flex items-center gap-2">
            <QrCode className="w-5 h-5" /> Escanear caja
          </h3>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10"><X className="w-5 h-5" /></button>
        </div>
        <div className="text-xs text-slate-400 mb-3">
          Talla <b className="text-slate-200">{cell.sz}</b> · Ubicación <b className="text-blue-300 font-mono">{cell.loc}</b>
        </div>
        <div className="relative">
          <Barcode className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-blue-400" />
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onScan(value); }}}
            placeholder="BOX-000000 o LPN de proveedor…"
            className="w-full h-16 pl-12 pr-3 bg-black/40 border-2 border-blue-500/60 rounded-2xl text-lg font-mono font-black focus:outline-none focus:border-blue-400"
            inputMode="text"
            autoComplete="off"
          />
        </div>
        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed">
          El scanner del PDA lo teclea automático. Si es una caja BOX- ya registrada, se identifica al instante. Si es un LPN de proveedor, se abrirá un cuestionario para atarla.
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 h-12 rounded-xl border border-white/10 text-sm font-black uppercase tracking-widest">Cancelar</button>
          <button onClick={() => onScan(value)} disabled={!value.trim()}
            className="flex-1 h-12 rounded-xl bg-blue-600 active:bg-blue-700 text-white text-sm font-black uppercase tracking-widest disabled:opacity-40">
            Identificar
          </button>
        </div>
      </div>
    </div>
  );
}

// ═════════════ BoxBindModal ═════════════════════════════════════════════════
// Cuando el LPN escaneado no está en sistema. Pide talla (dropdown de las que
// aún faltan en el ticket) y cantidad real que trae la caja. Sirve para atar
// el LPN físico a un box_id de la BD y reconciliar la cuenta.
function BoxBindModal({ info, onClose, onSubmit }) {
  const preset = info.cell?.sz || (info.sizes_needed[0]?.size || "");
  const [size, setSize] = useState(preset);
  const [units, setUnits] = useState(() => {
    const remain = info.sizes_needed.find(s => s.size === preset)?.remaining;
    return remain != null ? String(remain) : "";
  });
  const remaining = info.sizes_needed.find(s => s.size === size)?.remaining || 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#131a2b] border border-amber-500/40 rounded-2xl w-full max-w-md p-5 max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-black uppercase tracking-widest text-amber-300 flex items-center gap-2">
            <Barcode className="w-5 h-5" /> Caja no registrada
          </h3>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10"><X className="w-5 h-5" /></button>
        </div>
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-3">
          <div className="text-[11px] text-amber-300 mb-1">LPN escaneado</div>
          <div className="font-mono font-black text-lg text-amber-200">{info.lpn}</div>
        </div>
        <div className="text-xs text-slate-400 mb-3 leading-relaxed">
          Vamos a atar esta etiqueta a la caja de la BD. El ticket es{" "}
          <b className="text-slate-200">{info.ticket_context.style}</b> ·{" "}
          <b className="text-slate-200">{info.ticket_context.color}</b>{" "}
          en <b className="text-blue-300 font-mono">{info.location}</b>. Confirma:
        </div>

        <div className="mb-3">
          <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 block mb-1">Talla real de la caja</label>
          <select value={size} onChange={e => {
              setSize(e.target.value);
              const r = info.sizes_needed.find(s => s.size === e.target.value)?.remaining;
              if (r != null) setUnits(String(r));
            }}
            className="w-full h-14 bg-black/40 border-2 border-white/10 rounded-xl px-3 text-lg font-mono font-black focus:outline-none focus:border-amber-400">
            {info.sizes_needed.map(s => (
              <option key={s.size} value={s.size}>{s.size} · faltan {s.remaining}</option>
            ))}
          </select>
        </div>

        <div className="mb-3">
          <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 block mb-1">
            Cantidad REAL en la caja (cuenta física)
          </label>
          <input type="number" inputMode="numeric" min="0" value={units} onChange={e => setUnits(e.target.value)}
            placeholder="0"
            className="w-full h-14 bg-black/40 border-2 border-white/10 rounded-xl px-3 text-2xl text-center font-mono font-black focus:outline-none focus:border-amber-400" />
          <div className="text-[10px] text-slate-500 mt-1">
            El sistema ajustará el inventario si difiere de la BD.
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 h-12 rounded-xl border border-white/10 text-sm font-black uppercase tracking-widest">Cancelar</button>
          <button
            onClick={() => onSubmit({ size, actual_units: parseInt(units) || 0 })}
            disabled={!size || !units}
            className="flex-1 h-12 rounded-xl bg-amber-500 active:bg-amber-600 text-black text-sm font-black uppercase tracking-widest disabled:opacity-40">
            Ligar y continuar
          </button>
        </div>
      </div>
    </div>
  );
}
