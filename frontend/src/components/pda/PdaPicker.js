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

  // Per-size immediate deduction: la material sale de inventario apenas el
  // operador OK-ea. Refresca la lista DESPUES del descuento para que si el
  // picker sale del ticket y vuelve, vea el picked_sizes actualizado (el bug
  // del REMPLAZO: backend correcto pero UI mostraba "faltan 10" porque el
  // ticket prop tenia data stale).
  const handlePickSize = async (ticketId, size, details) => {
    try {
      const res = await putter(`/pick-tickets/${ticketId}/pick-size`, { size, details });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.success(data.message || `Talla ${size} descontada`);
        if (navigator.vibrate) navigator.vibrate(60);
        // Refresh silencioso (sin setLoading) para actualizar el ticket local
        // con lo que ya se descontó. No bloquea la UI del picker.
        try {
          const fresh = await fetcher("/operator/my-tickets");
          if (Array.isArray(fresh)) {
            setTickets(fresh);
            setSelected(prev => prev ? (fresh.find(x => x.ticket_id === prev.ticket_id) || prev) : null);
          }
        } catch { /* silencioso: el descuento ya se aplicó, el refresh es best-effort */ }
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
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(e.currentTarget.value); } }}
          inputMode="text"
          autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false}
          placeholder="Escanea o teclea el número de caja / LPN…"
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

// ═════════════════════ PickScreen ════════════════════════════════════════════
// Máquina de estados lineal — una decisión por pantalla, sin scroll infinito:
//   sizes     → lista de tallas a surtir
//   locations → ubicaciones disponibles con input de scan
//   boxes     → escanea la caja física en la ubicación confirmada
//   binding   → cuestionario (solo si LPN externo desconocido)
//   quantity  → captura cuántas piezas de la caja identificada
function PickScreen({ ticket, onSave, onPickSize, saving }) {
  const [pickedSizes, setPickedSizes] = useState({});
  const [committed, setCommitted] = useState(() => new Set());
  const [committing, setCommitting] = useState(false);

  // Máquina de stages
  const [stage, setStage] = useState('sizes');            // sizes|locations|boxes|binding|quantity
  const [activeSize, setActiveSize] = useState(null);
  const [activeLocation, setActiveLocation] = useState(null);
  const [activeBox, setActiveBox] = useState(null);        // {box_id, units, lpn}
  const [bindingInfo, setBindingInfo] = useState(null);    // {lpn, ticket_context, sizes_needed}
  const [takeQty, setTakeQty] = useState(0);

  // Inputs de scan por stage
  const locScanRef = useRef(null);
  const boxScanRef = useRef(null);
  const [locScan, setLocScan] = useState("");
  const [boxScan, setBoxScan] = useState("");

  // Blank status (se conserva)
  const [orderId, setOrderId] = useState(null);
  const [blankStatus, setBlankStatus] = useState("");
  const [blankOptions, setBlankOptions] = useState([]);
  const [savingStatus, setSavingStatus] = useState(false);

  useEffect(() => {
    setPickedSizes(ticket.picked_sizes || {});
    setCommitted(new Set(
      Object.entries(ticket.picked_sizes || {})
        .filter(([, v]) => (parseInt(v?.total ?? v) || 0) > 0)
        .map(([k]) => k)
    ));
    setStage('sizes');
    setActiveSize(null); setActiveLocation(null); setActiveBox(null);
    setBindingInfo(null); setTakeQty(0);
    setLocScan(""); setBoxScan("");
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

  // Focus scanner al entrar a cada stage
  useEffect(() => {
    if (stage === 'locations') setTimeout(() => locScanRef.current?.focus(), 100);
    if (stage === 'boxes')     setTimeout(() => boxScanRef.current?.focus(), 100);
  }, [stage]);

  const updateBlankStatus = async (val) => {
    if (!orderId) { toast.error("Orden aún no carga"); return; }
    const prev = blankStatus;
    setBlankStatus(val); setSavingStatus(true);
    try {
      const r = await fetch(`${ORDERS_API}/${orderId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ blank_status: val }),
      });
      if (r.ok) toast.success("Blank status actualizado");
      else { setBlankStatus(prev); toast.error("No se pudo actualizar"); }
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

  // ── Helpers de progreso ──────────────────────────────────────────────────
  const remainingOf = (sz) => {
    const req = parseInt(sizes[sz]) || 0;
    const done = parseInt(pickedSizes[sz]?.total ?? pickedSizes[sz]) || 0;
    return Math.max(0, req - done);
  };
  const totalRequired = activeSizes.reduce((s, sz) => s + (parseInt(sizes[sz]) || 0), 0);
  const totalCommitted = activeSizes.reduce(
    (s, sz) => s + (parseInt(pickedSizes[sz]?.total) || 0), 0);
  const isComplete = totalCommitted >= totalRequired && totalRequired > 0;
  const committedPicked = () => {
    const out = {};
    activeSizes.forEach(sz => { if (pickedSizes[sz]) out[sz] = pickedSizes[sz]; });
    return out;
  };

  // ── Navegación entre stages ──────────────────────────────────────────────
  const goToLocations = (sz) => {
    setActiveSize(sz); setActiveLocation(null); setActiveBox(null);
    setLocScan(""); setBoxScan(""); setBindingInfo(null);
    setStage('locations');
  };
  const backToSizes = () => {
    setActiveSize(null); setActiveLocation(null); setActiveBox(null);
    setBindingInfo(null); setStage('sizes');
  };
  const backToLocations = () => {
    setActiveLocation(null); setActiveBox(null);
    setBindingInfo(null); setBoxScan("");
    setStage('locations');
  };
  const backToBoxes = () => {
    setActiveBox(null); setBindingInfo(null); setBoxScan("");
    setStage('boxes');
  };

  // ── Scan de UBICACIÓN ─────────────────────────────────────────────────────
  const handleLocationScan = (raw) => {
    const code = norm(raw).replace(/^[^A-Z0-9]+/, "");
    setLocScan("");
    if (!code) return;
    const hit = locsFor(activeSize).find(l => norm(l.location) === code);
    if (!hit) {
      toast.error(`Ubicación "${code}" no es válida para la talla ${activeSize}`);
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      return;
    }
    setActiveLocation(hit);
    setStage('boxes');
    toast.success(`✓ Ubicación ${hit.location} · ${hit.available} pz aquí`);
    if (navigator.vibrate) navigator.vibrate(60);
  };

  // ── Scan de CAJA ─────────────────────────────────────────────────────────
  const handleBoxScan = async (raw) => {
    const lpn = String(raw || "").trim();
    setBoxScan("");
    if (!lpn) return;
    try {
      const r = await fetch(`${API}/pick-tickets/${ticket.ticket_id}/scan-box`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lpn, location: activeLocation.location }),
      });
      const data = await r.json();
      if (!r.ok) { toast.error(data.detail || "Error al escanear"); return; }
      if (data.status === "matched") {
        setActiveBox({ box_id: data.box.box_id, units: data.box.units, lpn });
        // Default = min(caja, restante)
        const remain = remainingOf(activeSize);
        setTakeQty(Math.min(data.box.units, remain));
        setStage('quantity');
        toast.success(`✓ Caja ${data.box.box_id} · ${data.box.units} pz`);
        if (navigator.vibrate) navigator.vibrate(60);
      } else if (data.status === "wrong_ticket") {
        toast.error(data.message || "La caja no es de este ticket");
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      } else if (data.status === "needs_binding") {
        setBindingInfo(data);
        setStage('binding');
      }
    } catch (e) { toast.error("Error de conexión al escanear"); }
  };

  // ── Bind inline (LPN externo no registrado) ──────────────────────────────
  const submitBinding = async ({ size, actual_units }) => {
    try {
      const r = await fetch(`${API}/pick-tickets/${ticket.ticket_id}/bind-box`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lpn: bindingInfo.lpn, location: activeLocation.location,
          size, actual_units,
        }),
      });
      const data = await r.json();
      if (!r.ok) { toast.error(data.detail || "Error al ligar caja"); return; }
      setActiveBox({ box_id: data.box.box_id, units: data.box.units, lpn: bindingInfo.lpn });
      const remain = remainingOf(activeSize);
      setTakeQty(Math.min(data.box.units, remain));
      setBindingInfo(null);
      setStage('quantity');
      toast.success(data.reconciled
        ? `Caja ligada + ajuste (${data.delta > 0 ? '+' : ''}${data.delta})`
        : `Caja ${data.box.box_id} ligada`);
      if (navigator.vibrate) navigator.vibrate(80);
    } catch (e) { toast.error("Error de conexión al ligar"); }
  };

  // ── Descuento final ──────────────────────────────────────────────────────
  const confirmQuantity = async () => {
    const qty = parseInt(takeQty) || 0;
    if (qty <= 0) { toast.error("Ingresa una cantidad"); return; }
    if (qty > activeBox.units) { toast.error(`La caja solo tiene ${activeBox.units} pz`); return; }
    const remain = remainingOf(activeSize);
    if (qty > remain) { toast.error(`Máximo ${remain} pz para talla ${activeSize}`); return; }

    // Estructura para pick-size: incluye todas las locs ya deducted + la nueva
    const prev = pickedSizes[activeSize]?.details || {};
    const nextDetails = { ...prev, [activeLocation.location]: (prev[activeLocation.location] || 0) + qty };
    const detailsWithBoxes = Object.fromEntries(
      Object.entries(nextDetails).map(([loc, q]) => [loc, {
        qty: q,
        box_id: loc === activeLocation.location ? activeBox.box_id : null,
      }])
    );
    setCommitting(true);
    const ok = await onPickSize(ticket.ticket_id, activeSize, detailsWithBoxes);
    setCommitting(false);
    if (ok) {
      // Actualiza el estado local para reflejar el descuento sin re-fetch
      setPickedSizes(p => ({
        ...p,
        [activeSize]: {
          total: (parseInt(p[activeSize]?.total) || 0) + qty,
          details: nextDetails,
        },
      }));

      // Post-descuento: no siempre hay que volver al selector de tallas. Si
      // aun faltan piezas de esta talla Y la ubicacion actual sigue teniendo
      // stock, quedar en `boxes` esperando otra caja de la MISMA locacion
      // (evita re-escanear la ubicacion cada vez). Solo volvemos a `sizes`
      // cuando la talla ya se completo; a `locations` si la ubic se agoto.
      const stillNeed = Math.max(0, remainingOf(activeSize) - qty);
      const remainHere = Math.max(0, (activeLocation.available || 0) - qty);
      if (stillNeed <= 0) {
        setCommitted(prev => new Set(prev).add(activeSize));
        backToSizes();
      } else if (remainHere > 0) {
        // Restamos localmente el available de la ubic para que la UI muestre el nuevo saldo.
        setActiveLocation(prev => prev ? { ...prev, available: remainHere } : prev);
        setActiveBox(null); setBindingInfo(null); setBoxScan(""); setTakeQty("");
        setStage("boxes");
        toast.info(`Faltan ${stillNeed} pz de talla ${activeSize}. Escanea otra caja en ${activeLocation.location}.`);
      } else {
        // La ubic se agoto — al selector de ubicaciones para elegir la siguiente.
        backToLocations();
        toast.info(`Ubic ${activeLocation.location} agotada. Faltan ${stillNeed} pz de talla ${activeSize} — elige otra ubicacion.`);
      }
    }
  };

  // ══════════════════ RENDER ═══════════════════════════════════════════════
  return (
    <div className="pb-28">
      {/* Header fijo con progreso */}
      <div className="p-3">
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
            <div className={`h-full ${isComplete ? "bg-emerald-500" : totalCommitted > 0 ? "bg-amber-500" : "bg-slate-600"}`}
                 style={{ width: `${totalRequired > 0 ? Math.round((totalCommitted / totalRequired) * 100) : 0}%` }} />
          </div>

          {/* Blank status — solo en la lista de tallas */}
          {stage === 'sizes' && (
            <div className="mt-3 pt-3 border-t border-white/10">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Tag className="w-3.5 h-3.5 text-blue-300" />
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Blank Status (MOS)</span>
                {savingStatus && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-300 ml-auto" />}
              </div>
              <select value={blankStatus} onChange={(e) => updateBlankStatus(e.target.value)}
                disabled={savingStatus || !orderId}
                className="w-full h-12 bg-black/30 border border-white/10 rounded-xl px-3 text-base font-bold focus:outline-none focus:border-blue-400 disabled:opacity-50">
                <option value="">— Sin status —</option>
                {blankOptions.map(s => <option key={s} value={s}>{s}</option>)}
                {blankStatus && !blankOptions.includes(blankStatus) && (
                  <option value={blankStatus}>{blankStatus}</option>
                )}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* ══════ STAGE 1: SIZES ══════ */}
      {stage === 'sizes' && (
        <div className="px-3 space-y-2">
          <div className="text-[11px] font-black uppercase tracking-widest text-slate-500 px-1 mb-1">
            Tallas por surtir · toca para escanear
          </div>
          {activeSizes.map(sz => {
            const req = parseInt(sizes[sz]) || 0;
            const done = parseInt(pickedSizes[sz]?.total) || 0;
            const remain = req - done;
            const isDone = remain <= 0;
            return (
              <button key={sz} onClick={() => !isDone && goToLocations(sz)} disabled={isDone}
                className={`w-full rounded-2xl border p-4 flex items-center gap-3 active:bg-white/5 disabled:opacity-50 ${
                  isDone ? "border-emerald-500/40 bg-emerald-500/10" : "border-white/10 bg-[#131a2b]"
                }`}>
                {isDone
                  ? <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
                  : <Package className="w-7 h-7 text-slate-400 shrink-0" />}
                <div className="flex-1 text-left">
                  <div className="text-2xl font-black">{sz}</div>
                  <div className="text-[11px] text-slate-400">
                    {isDone
                      ? `Completo · ${done} descontado`
                      : `Requerido ${req} · descontado ${done} · faltan ${remain}`}
                  </div>
                </div>
                <div className={`min-w-[64px] px-3 py-2 rounded-xl text-center text-xl font-mono font-black ${
                  isDone ? "bg-emerald-500/20 text-emerald-300" : "bg-white/5 text-slate-200"
                }`}>{done}/{req}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* ══════ STAGE 2: LOCATIONS ══════ */}
      {stage === 'locations' && activeSize && (
        <div className="px-3 space-y-3">
          <button onClick={backToSizes}
            className="text-xs font-black uppercase tracking-widest text-slate-400 active:text-slate-200 flex items-center gap-1">
            <ChevronLeft className="w-4 h-4" /> Volver a tallas
          </button>
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-3">
            <div className="text-[10px] font-black uppercase tracking-widest text-blue-300">Talla activa</div>
            <div className="text-3xl font-black text-white">{activeSize}</div>
            <div className="text-xs text-slate-300 mt-1">Faltan <b className="text-amber-300">{remainingOf(activeSize)} pz</b></div>
          </div>

          <div className="relative">
            <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-blue-400" />
            <input ref={locScanRef} autoFocus value={locScan}
              onChange={(e) => setLocScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Toma el valor DIRECTO del input para no depender del state
                  // (evita closure stale cuando DataWedge dispara Enter rapido).
                  handleLocationScan(e.currentTarget.value);
                }
              }}
              inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false}
              placeholder="Escanea o teclea la ubicación…"
              className="w-full h-14 pl-12 pr-3 bg-[#131a2b] border-2 border-blue-500/40 rounded-2xl text-lg font-bold focus:outline-none focus:border-blue-400" />
          </div>
          <button onClick={() => handleLocationScan(locScan)} disabled={!locScan.trim()}
            className="w-full h-11 rounded-xl bg-blue-600 active:bg-blue-700 text-white text-xs font-black uppercase tracking-widest disabled:opacity-40 -mt-1">
            Confirmar ubicación
          </button>

          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 px-1 mb-1">
              Ubicaciones disponibles
            </div>
            <div className="space-y-1.5">
              {locsFor(activeSize).length === 0 ? (
                <div className="flex items-center gap-2 text-amber-400 py-4 justify-center">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <span className="text-xs font-bold">Sin stock para esta talla/color</span>
                </div>
              ) : locsFor(activeSize).map((l, i) => (
                <div key={i} className="rounded-xl border border-white/10 bg-black/20 p-3 flex items-center gap-3">
                  <MapPin className="w-5 h-5 text-blue-300 shrink-0" />
                  <div className="flex-1">
                    <div className="font-mono font-black text-blue-300 text-lg">{l.location}</div>
                    {l.country_of_origin && <div className="text-[10px] text-slate-500">{l.country_of_origin}</div>}
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-mono font-black text-emerald-400">{l.available}</div>
                    <div className="text-[9px] uppercase text-slate-500 font-black tracking-widest">pz</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════ STAGE 3: BOXES ══════ */}
      {stage === 'boxes' && activeSize && activeLocation && (
        <div className="px-3 space-y-3">
          <button onClick={backToLocations}
            className="text-xs font-black uppercase tracking-widest text-slate-400 active:text-slate-200 flex items-center gap-1">
            <ChevronLeft className="w-4 h-4" /> Volver a ubicaciones
          </button>
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
              <div className="flex-1">
                <div className="text-[10px] font-black uppercase tracking-widest text-emerald-300">Ubicación confirmada</div>
                <div className="font-mono font-black text-emerald-100 text-xl">{activeLocation.location}</div>
              </div>
              <div className="text-right">
                <div className="text-lg font-mono font-black text-emerald-300">{activeLocation.available}</div>
                <div className="text-[9px] uppercase text-emerald-400/70 font-black">pz aquí</div>
              </div>
            </div>
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 px-1 mb-1 flex items-center gap-1">
              <QrCode className="w-3.5 h-3.5" /> Escanea la caja
            </div>
            <div className="relative">
              <Barcode className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-blue-400" />
              <input ref={boxScanRef} autoFocus value={boxScan}
                onChange={(e) => setBoxScan(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleBoxScan(e.currentTarget.value);
                  }
                }}
                inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false}
                placeholder="BOX-000000 o LPN de proveedor…"
                className="w-full h-16 pl-12 pr-3 bg-[#131a2b] border-2 border-blue-500/60 rounded-2xl text-lg font-mono font-black focus:outline-none focus:border-blue-400" />
            </div>
            <button onClick={() => handleBoxScan(boxScan)} disabled={!boxScan.trim()}
              className="w-full h-11 mt-2 rounded-xl bg-blue-600 active:bg-blue-700 text-white text-xs font-black uppercase tracking-widest disabled:opacity-40">
              Identificar caja
            </button>
            <div className="mt-2 text-[10px] text-slate-500 px-1 leading-relaxed">
              Si es BOX- registrada se identifica al instante. Si es LPN de proveedor, te pediremos ligar la caja.
            </div>
          </div>
        </div>
      )}

      {/* ══════ STAGE 4a: BINDING (LPN externo) ══════ */}
      {stage === 'binding' && bindingInfo && (
        <BindingStage
          info={bindingInfo}
          location={activeLocation.location}
          onBack={backToBoxes}
          onSubmit={submitBinding}
          defaultSize={activeSize}
        />
      )}

      {/* ══════ STAGE 4b: QUANTITY ══════ */}
      {stage === 'quantity' && activeBox && activeLocation && (
        <div className="px-3 space-y-3">
          <button onClick={backToBoxes}
            className="text-xs font-black uppercase tracking-widest text-slate-400 active:text-slate-200 flex items-center gap-1">
            <ChevronLeft className="w-4 h-4" /> Volver a caja
          </button>
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-3 space-y-1">
            <div className="flex items-center gap-2">
              <Barcode className="w-5 h-5 text-emerald-400" />
              <div className="flex-1">
                <div className="text-[10px] font-black uppercase tracking-widest text-emerald-300">Caja identificada</div>
                <div className="font-mono font-black text-emerald-100 text-lg">{activeBox.box_id}</div>
                {activeBox.lpn && activeBox.lpn !== activeBox.box_id && (
                  <div className="text-[10px] text-emerald-400/60 font-mono">LPN: {activeBox.lpn}</div>
                )}
              </div>
              <div className="text-right">
                <div className="text-2xl font-mono font-black text-emerald-300">{activeBox.units}</div>
                <div className="text-[9px] uppercase text-emerald-400/70 font-black">pz en caja</div>
              </div>
            </div>
            <div className="text-[10px] text-slate-400 pt-2 border-t border-emerald-500/20">
              Talla <b className="text-emerald-300">{activeSize}</b> · Ubic. <b className="text-blue-300 font-mono">{activeLocation.location}</b> · Faltan <b className="text-amber-300">{remainingOf(activeSize)} pz</b>
            </div>
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 px-1 mb-1">
              ¿Cuántas piezas vas a tomar?
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setTakeQty(Math.max(0, (parseInt(takeQty) || 0) - 1))}
                className="w-16 h-16 rounded-2xl bg-white/5 active:bg-white/10 text-3xl font-black">−</button>
              <input type="number" inputMode="numeric" min="0"
                max={Math.min(activeBox.units, remainingOf(activeSize))}
                value={takeQty} onChange={(e) => setTakeQty(e.target.value)}
                onFocus={(e) => e.target.select()}
                className="flex-1 h-16 bg-black/40 border-2 border-blue-500/40 rounded-2xl text-center text-4xl font-mono font-black focus:outline-none focus:border-blue-400" />
              <button onClick={() => setTakeQty(Math.min(Math.min(activeBox.units, remainingOf(activeSize)), (parseInt(takeQty) || 0) + 1))}
                className="w-16 h-16 rounded-2xl bg-white/5 active:bg-white/10 text-3xl font-black">＋</button>
            </div>
            <div className="mt-2 text-[10px] text-slate-500 px-1">
              Default = mínimo entre {activeBox.units} (caja) y {remainingOf(activeSize)} (restante)
            </div>
          </div>

          <button onClick={confirmQuantity} disabled={committing || (parseInt(takeQty) || 0) <= 0}
            className="w-full h-16 rounded-2xl bg-emerald-600 active:bg-emerald-700 text-white text-base font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40">
            {committing ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-6 h-6" />}
            Descontar {parseInt(takeQty) || 0} pz
          </button>
        </div>
      )}

      {/* Sticky action bar — solo visible en sizes */}
      {stage === 'sizes' && (
        <div className="fixed bottom-0 inset-x-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-t border-white/10 p-3">
          <button onClick={() => onSave(ticket.ticket_id, committedPicked(), true)}
            disabled={saving || totalCommitted === 0}
            className={`w-full h-14 rounded-2xl text-sm font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-50 ${
              isComplete ? "bg-emerald-600 active:bg-emerald-700" : "bg-amber-600 active:bg-amber-700"} text-white`}>
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
            {isComplete ? "Completar surtido" : "Cerrar parcial"}
          </button>
        </div>
      )}
    </div>
  );
}

// ═════════════════════ BindingStage ══════════════════════════════════════════
// Cuestionario inline (no modal) cuando el LPN escaneado no está en sistema.
// Pide talla + cantidad real, llama /bind-box y regresa al stage quantity.
function BindingStage({ info, location, onBack, onSubmit, defaultSize }) {
  const preselected = defaultSize && info.sizes_needed.find(s => s.size === defaultSize)
    ? defaultSize
    : (info.sizes_needed[0]?.size || "");
  const [size, setSize] = useState(preselected);
  const [units, setUnits] = useState(() => {
    const r = info.sizes_needed.find(s => s.size === preselected)?.remaining;
    return r != null ? String(r) : "";
  });

  return (
    <div className="px-3 space-y-3">
      <button onClick={onBack}
        className="text-xs font-black uppercase tracking-widest text-slate-400 active:text-slate-200 flex items-center gap-1">
        <ChevronLeft className="w-4 h-4" /> Volver a caja
      </button>

      <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-3">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-5 h-5 text-amber-400" />
          <div className="text-sm font-black uppercase tracking-widest text-amber-300">Caja no registrada</div>
        </div>
        <div className="text-[10px] text-amber-400/70 mb-1">LPN escaneado</div>
        <div className="font-mono font-black text-lg text-amber-100 break-all">{info.lpn}</div>
        <div className="mt-2 text-[10px] text-slate-400 leading-relaxed">
          Vas a atar esta etiqueta a la caja de la BD en{" "}
          <b className="text-blue-300 font-mono">{location}</b>. Confirma:
        </div>
      </div>

      <div>
        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 block mb-1">
          Talla real de la caja
        </label>
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

      <div>
        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 block mb-1">
          Cantidad REAL en la caja (cuenta física)
        </label>
        <input type="number" inputMode="numeric" min="0" value={units}
          onChange={e => setUnits(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder="0"
          className="w-full h-16 bg-black/40 border-2 border-white/10 rounded-xl px-3 text-3xl text-center font-mono font-black focus:outline-none focus:border-amber-400" />
        <div className="text-[10px] text-slate-500 mt-1">
          El sistema ajustará el inventario si difiere de la BD.
        </div>
      </div>

      <button onClick={() => onSubmit({ size, actual_units: parseInt(units) || 0 })}
        disabled={!size || !units}
        className="w-full h-16 rounded-2xl bg-amber-500 active:bg-amber-600 text-black text-base font-black uppercase tracking-widest disabled:opacity-40">
        Ligar y continuar
      </button>
    </div>
  );
}
