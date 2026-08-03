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
  // Refresca la lista de tickets desde el servidor para reflejar lo descontado.
  // En el flujo de acumular cajas se llama UNA sola vez al confirmar el lote —
  // NO por cada caja — para que el operador no "salga" a tallas en cada escaneo.
  const refreshTickets = useCallback(async () => {
    try {
      const fresh = await fetcher("/operator/my-tickets");
      if (Array.isArray(fresh)) {
        setTickets(fresh);
        setSelected(prev => prev ? (fresh.find(x => x.ticket_id === prev.ticket_id) || prev) : null);
      }
    } catch { /* best-effort: el descuento ya se aplicó, el refresh es secundario */ }
  }, []);

  const handlePickSize = async (ticketId, size, details, opts = {}) => {
    try {
      const res = await putter(`/pick-tickets/${ticketId}/pick-size`, { size, details });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (!opts.silent) toast.success(data.message || `Talla ${size} descontada`);
        if (navigator.vibrate && !opts.silent) navigator.vibrate(60);
        // skipRefresh: en un lote refrescamos una sola vez al final (el caller).
        if (!opts.skipRefresh) await refreshTickets();
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
        <PickScreen ticket={selected} onSave={handleSave} onPickSize={handlePickSize} onRefresh={refreshTickets} saving={saving} />
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
function PickScreen({ ticket, onSave, onPickSize, onRefresh, saving }) {
  const [pickedSizes, setPickedSizes] = useState({});
  const [committed, setCommitted] = useState(() => new Set());
  const [committing, setCommitting] = useState(false);

  // Máquina de stages
  const [stage, setStage] = useState('sizes');            // sizes|locations|boxes|binding|quantity
  const [activeSize, setActiveSize] = useState(null);
  const [activeLocation, setActiveLocation] = useState(null);
  const [activeBox, setActiveBox] = useState(null);        // {box_id, units, lpn}
  const [unidentifiedLpn, setUnidentifiedLpn] = useState(null); // LPN escaneado que no existe en el sistema
  const [takeQty, setTakeQty] = useState(0);
  // Carrito de cajas escaneadas EN LA UBICACIÓN ACTIVA, aún sin descontar.
  // Cada item: { box_id, lpn, boxUnits, qty, size }. Se acumula multi-talla y
  // se confirma todo junto (descuenta por talla en el commit).
  const [cart, setCart] = useState([]);
  // Cajas que el sistema tiene FÍSICAMENTE en la ubicación activa (guía visual;
  // el operador igual debe escanear cada una). Fuente para seleccionar LPN a mano.
  const [locBoxes, setLocBoxes] = useState([]);
  const [locBoxesLoading, setLocBoxesLoading] = useState(false);

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
    setUnidentifiedLpn(null); setTakeQty(0); setCart([]); setLocBoxes([]);
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
  // ── Carrito (multi-talla): cada item lleva su propia talla ────────────────
  const cartQty = cart.reduce((s, it) => s + (parseInt(it.qty) || 0), 0);
  const cartQtyForSize = (sz) => cart.filter(it => it.size === sz)
    .reduce((s, it) => s + (parseInt(it.qty) || 0), 0);
  // Lo que aún falta de una talla, descontando lo ya acumulado de ESA talla.
  const remainingForSize = (sz) => Math.max(0, remainingOf(sz) - cartQtyForSize(sz));
  // Cupo para la SIGUIENTE caja de talla sz: min(lo que falta de esa talla,
  // el total disponible del ticket en esta ubicación menos lo ya acumulado).
  const roomForBox = (sz) => activeLocation
    ? Math.max(0, Math.min(remainingForSize(sz), (activeLocation.available || 0) - cartQty))
    : 0;

  // Unión de TODAS las ubicaciones del ticket (todas las tallas), con total de
  // piezas por ubicación y desglose por talla. Es la base del flujo ubic-primero.
  const allLocs = () => {
    const byLoc = {};
    activeSizes.forEach(sz => {
      locsFor(sz).forEach(l => {
        const key = norm(l.location);
        if (!key) return;
        if (!byLoc[key]) byLoc[key] = { location: l.location, available: 0, sizes: {}, sinVerificar: false };
        const av = parseInt(l.available) || 0;
        byLoc[key].available += av;
        byLoc[key].sizes[sz] = (byLoc[key].sizes[sz] || 0) + av;
        // El backend marca sin_verificar cuando la ubicación tiene saldo en el
        // renglón pero NINGUNA caja viva que lo respalde. No se oculta (puede ser
        // saldo legado real), pero el operador debe saber que va a una ubicación
        // donde el sistema no puede probar que haya material.
        if (l.sin_verificar) byLoc[key].sinVerificar = true;
      });
    });
    return Object.values(byLoc).sort((a, b) => b.available - a.available);
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

  // ── Navegación entre stages (UBICACIÓN-PRIMERO) ───────────────────────────
  const goToLocations = () => {
    setActiveSize(null); setActiveLocation(null); setActiveBox(null);
    setLocScan(""); setBoxScan(""); setUnidentifiedLpn(null); setCart([]); setLocBoxes([]);
    setStage('locations');
  };
  const backToSizes = () => {
    setActiveSize(null); setActiveLocation(null); setActiveBox(null);
    setUnidentifiedLpn(null); setStage('sizes');
  };
  const backToLocations = () => {
    setActiveLocation(null); setActiveBox(null);
    setUnidentifiedLpn(null); setBoxScan(""); setCart([]); setLocBoxes([]);
    setStage('locations');
  };
  const backToBoxes = () => {
    setActiveBox(null); setUnidentifiedLpn(null); setBoxScan("");
    setStage('boxes');
  };

  // Trae las cajas físicas del ticket (style+color) en una ubicación — guía
  // visual y fuente para seleccionar un LPN a mano.
  const loadLocationBoxes = async (location) => {
    setLocBoxesLoading(true); setLocBoxes([]);
    try {
      const params = new URLSearchParams({
        location, sku: ticket.style || "", color: ticket.color || "",
      });
      const data = await fetcher(`/boxes?${params.toString()}`);
      const rows = Array.isArray(data) ? data : (data?.boxes || data?.items || []);
      setLocBoxes(rows.filter(b => (parseInt(b.units) || 0) > 0));
    } catch { /* la guía es best-effort; el escaneo funciona igual */ }
    finally { setLocBoxesLoading(false); }
  };

  // Entra a una ubicación (por scan o tap en la lista): carrito limpio + cajas.
  const enterLocation = (hit) => {
    setActiveLocation(hit);
    setActiveSize(null); setActiveBox(null); setUnidentifiedLpn(null);
    setCart([]); setBoxScan("");
    setStage('boxes');
    loadLocationBoxes(hit.location);
    toast.success(`✓ Ubicación ${hit.location} · ${hit.available} pz del ticket aquí`);
    if (navigator.vibrate) navigator.vibrate(60);
  };

  // ── Scan de UBICACIÓN (cualquiera con material del ticket) ────────────────
  const handleLocationScan = (raw) => {
    const code = norm(raw).replace(/^[^A-Z0-9]+/, "");
    setLocScan("");
    if (!code) return;
    const hit = allLocs().find(l => norm(l.location) === code);
    if (!hit) {
      toast.error(`Ubicación "${code}" no tiene material de este ticket`);
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      return;
    }
    enterLocation(hit);
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
        openBoxForQty(data.box, lpn);
      } else if (data.status === "wrong_ticket") {
        toast.error(data.message || "La caja no es de este ticket");
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      } else if (data.status === "needs_binding") {
        // LPN externo / código no-BOX → el picker NO liga cajas. Antes aquí se
        // le abría un cuestionario para atar la etiqueta a una caja a mano; eso
        // ahora es trabajo del supervisor (POST /bind-box exige admin/supersu).
        setUnidentifiedLpn(data.lpn || lpn);
        setStage('unidentified');
        if (navigator.vibrate) navigator.vibrate([120, 60, 120, 60, 120]);
      }
    } catch (e) { toast.error("Error de conexión al escanear"); }
  };

  // Abre una caja (ya identificada) para capturar cantidad. La TALLA sale de la
  // propia caja — así el flujo es ubicación-primero y un solo campo recibe
  // cajas de cualquier talla. Valida que la talla la pida el ticket y no exceda.
  const openBoxForQty = (box, lpn) => {
    const bsize = String(box.size || "").toUpperCase();
    if (!bsize || !activeSizes.includes(bsize)) {
      toast.error(`La caja es talla ${bsize || "?"}, que no pide este ticket`);
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      return;
    }
    if (remainingForSize(bsize) <= 0) {
      toast.error(`La talla ${bsize} ya está completa`);
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      return;
    }
    if (cart.some(it => it.box_id === box.box_id)) {
      toast.error("Esa caja ya está en la lista");
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      return;
    }
    setActiveBox({
      box_id: box.box_id, units: box.units, size: bsize,
      lpn: lpn || box.physical_lpn || box.box_id,
    });
    setTakeQty(Math.min(box.units, roomForBox(bsize)));
    setStage('quantity');
    toast.success(`✓ Caja ${box.box_id} · talla ${bsize} · ${box.units} pz`);
    if (navigator.vibrate) navigator.vibrate(60);
  };

  // ── Acumular caja (NO descuenta; solo agrega al carrito local) ─────────────
  const addToCart = () => {
    const qty = parseInt(takeQty) || 0;
    const sz = activeBox.size;
    if (qty <= 0) { toast.error("Ingresa una cantidad"); return; }
    if (qty > activeBox.units) { toast.error(`La caja solo tiene ${activeBox.units} pz`); return; }
    const room = roomForBox(sz);
    if (qty > room) { toast.error(`Máximo ${room} pz más (talla ${sz} / ubic ${activeLocation.location})`); return; }
    setCart(prev => [...prev, {
      box_id: activeBox.box_id, lpn: activeBox.lpn, boxUnits: activeBox.units, qty, size: sz,
    }]);
    setActiveBox(null); setUnidentifiedLpn(null); setBoxScan(""); setTakeQty(0);
    setStage("boxes");
    if (navigator.vibrate) navigator.vibrate(40);
    const faltaSz = Math.max(0, remainingOf(sz) - (cartQtyForSize(sz) + qty));
    toast.success(faltaSz > 0
      ? `Caja agregada (talla ${sz}, ${qty} pz). Faltan ${faltaSz} de ${sz}.`
      : `Caja agregada. Talla ${sz} completa ✓`);
  };
  const removeFromCart = (idx) => setCart(prev => prev.filter((_, i) => i !== idx));

  // ── Descuento en LOTE (multi-talla) ────────────────────────────────────────
  // Descuenta todas las cajas acumuladas de la ubicación de una. Como el backend
  // es 1 caja/ubic por llamada Y por talla, iteramos caja por caja usando la
  // talla de CADA caja, con acumulados por talla. Totales ACUMULATIVOS: el
  // servidor descuenta solo el delta vs. su deducted_map (robusto). Un solo
  // refresh al final. Snapshot para no depender de estados que cambian a mitad.
  const commitCart = async () => {
    if (!cart.length) { toast.error("No hay cajas escaneadas"); return; }
    const items = [...cart];
    const loc = activeLocation.location;
    setCommitting(true);
    const running = {};   // { size: acumulado en ESTA ubic } sembrado del server
    const doneBySize = {}; // { size: piezas descontadas ahora }
    const done = [];
    let failed = null;
    for (const it of items) {
      const sz = it.size;
      if (running[sz] == null) running[sz] = parseInt(pickedSizes[sz]?.details?.[loc] || 0) || 0;
      running[sz] += parseInt(it.qty) || 0;
      const base = { ...(pickedSizes[sz]?.details || {}) };
      const nextDetails = { ...base, [loc]: running[sz] };
      const detailsWithBoxes = Object.fromEntries(
        Object.entries(nextDetails).map(([l, q]) => [l, {
          qty: q,
          box_id: l === loc ? it.box_id : null,   // solo la ubic activa lleva caja
        }])
      );
      const ok = await onPickSize(ticket.ticket_id, sz, detailsWithBoxes, { skipRefresh: true, silent: true });
      if (!ok) { failed = it; break; }            // onPickSize ya mostró el modal bloqueante
      done.push(it);
      doneBySize[sz] = (doneBySize[sz] || 0) + (parseInt(it.qty) || 0);
    }
    const pickedNow = done.reduce((s, it) => s + (parseInt(it.qty) || 0), 0);
    // Update OPTIMISTA por talla (protege reintentos si el refresh de red falla).
    if (pickedNow > 0) {
      setPickedSizes(p => {
        const next = { ...p };
        Object.entries(doneBySize).forEach(([sz, add]) => {
          const prevDetails = { ...(next[sz]?.details || {}) };
          next[sz] = {
            total: (parseInt(next[sz]?.total) || 0) + add,
            details: { ...prevDetails, [loc]: (parseInt(prevDetails[loc]) || 0) + add },
          };
        });
        return next;
      });
    }
    if (onRefresh) await onRefresh();   // sincroniza con el servidor (una sola vez)
    setCart([]);
    setCommitting(false);
    if (failed) {
      toast.error(`Se descontaron ${done.length} caja(s) (${pickedNow} pz). La caja ${failed.box_id} (talla ${failed.size}) falló — revisa el aviso y re-escanea las que faltaron.`);
    } else if (pickedNow > 0) {
      const resumen = Object.entries(doneBySize).map(([sz, q]) => `${sz}:${q}`).join(" · ");
      toast.success(`✓ ${done.length} caja(s) · ${pickedNow} pz (${resumen})`);
      if (navigator.vibrate) navigator.vibrate(60);
      Object.keys(doneBySize).forEach(sz => {
        const doneTotal = (parseInt(pickedSizes[sz]?.total) || 0) + doneBySize[sz];
        if ((parseInt(sizes[sz]) || 0) && doneTotal >= (parseInt(sizes[sz]) || 0)) {
          setCommitted(prev => new Set(prev).add(sz));
        }
      });
    }
    backToSizes();   // vuelve al resumen (el refresh trajo el progreso real)
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
          {/* Entrada principal: UBICACIÓN-PRIMERO. Escaneas la ubicación y de ahí
              surtes todas las tallas que estén ahí en un solo lote. */}
          <button onClick={goToLocations}
            className="w-full h-16 rounded-2xl bg-blue-600 active:bg-blue-700 text-white text-base font-black uppercase tracking-widest flex items-center justify-center gap-2 mb-1">
            <ScanLine className="w-6 h-6" /> Escanear ubicación
          </button>
          <div className="text-[11px] font-black uppercase tracking-widest text-slate-500 px-1 mb-1">
            Progreso por talla · ubicaciones a dónde ir
          </div>
          {activeSizes.map(sz => {
            const req = parseInt(sizes[sz]) || 0;
            const done = parseInt(pickedSizes[sz]?.total) || 0;
            const remain = req - done;
            const isDone = remain <= 0;
            const locs = locsFor(sz);
            return (
              <div key={sz}
                className={`w-full rounded-2xl border p-4 ${
                  isDone ? "border-emerald-500/40 bg-emerald-500/10" : "border-white/10 bg-[#131a2b]"
                }`}>
                <div className="flex items-center gap-3">
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
                </div>
                {/* Ubicaciones donde está esta talla (toca para entrar directo) */}
                {!isDone && (
                  <div className="mt-2 pt-2 border-t border-white/10 flex flex-wrap gap-1.5">
                    {locs.length === 0 ? (
                      <span className="text-[10px] text-amber-400 font-bold flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> Sin ubicación con stock
                      </span>
                    ) : locs.slice(0, 6).map((l, i) => (
                      <button key={i}
                        onClick={() => { const hit = allLocs().find(a => norm(a.location) === norm(l.location)); if (hit) enterLocation(hit); }}
                        className="flex items-center gap-1 text-[11px] font-black bg-blue-500/10 border border-blue-500/25 text-blue-300 px-2 py-1 rounded-lg active:bg-blue-500/20">
                        <MapPin className="w-3 h-3 shrink-0" />
                        <span className="font-mono">{l.location}</span>
                        <span className="text-emerald-300 tabular-nums">·{l.available}</span>
                      </button>
                    ))}
                    {locs.length > 6 && <span className="text-[10px] text-slate-500 self-center">+{locs.length - 6}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ══════ STAGE 2: LOCATIONS (todas las del ticket) ══════ */}
      {stage === 'locations' && (
        <div className="px-3 space-y-3">
          <button onClick={backToSizes}
            className="text-xs font-black uppercase tracking-widest text-slate-400 active:text-slate-200 flex items-center gap-1">
            <ChevronLeft className="w-4 h-4" /> Volver
          </button>
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-3">
            <div className="text-[10px] font-black uppercase tracking-widest text-blue-300">Escanea la ubicación del material</div>
            <div className="text-xs text-slate-300 mt-1">Faltan <b className="text-amber-300">{Math.max(0, totalRequired - totalCommitted)} pz</b> del ticket en total</div>
          </div>

          <div className="relative">
            <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-blue-400" />
            <input ref={locScanRef} autoFocus value={locScan}
              onChange={(e) => setLocScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
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
              Ubicaciones con material del ticket · toca para entrar
            </div>
            <div className="space-y-1.5">
              {allLocs().length === 0 ? (
                <div className="flex items-center gap-2 text-amber-400 py-4 justify-center">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <span className="text-xs font-bold">Sin stock para este ticket</span>
                </div>
              ) : allLocs().map((l, i) => (
                <button key={i} onClick={() => enterLocation(l)}
                  className="w-full rounded-xl border border-white/10 bg-black/20 p-3 flex items-center gap-3 active:bg-white/5 text-left">
                  <MapPin className={`w-5 h-5 shrink-0 ${l.sinVerificar ? 'text-amber-300' : 'text-blue-300'}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`font-mono font-black text-lg ${l.sinVerificar ? 'text-amber-300' : 'text-blue-300'}`}>{l.location}</div>
                    <div className="text-[10px] text-slate-500 truncate">
                      {Object.entries(l.sizes).map(([sz, q]) => `${sz}:${q}`).join(" · ")}
                    </div>
                    {l.sinVerificar && (
                      <div className="text-[10px] font-black uppercase tracking-wider text-amber-400 flex items-center gap-1 mt-0.5">
                        <AlertTriangle className="w-3 h-3 shrink-0" /> Sin cajas registradas — verifica en piso
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-xl font-mono font-black ${l.sinVerificar ? 'text-amber-400' : 'text-emerald-400'}`}>{l.available}</div>
                    <div className="text-[9px] uppercase text-slate-500 font-black tracking-widest">pz</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════ STAGE 3: BOXES ══════ */}
      {stage === 'boxes' && activeLocation && (
        <div className="px-3 space-y-3">
          <button onClick={backToLocations}
            className="text-xs font-black uppercase tracking-widest text-slate-400 active:text-slate-200 flex items-center gap-1">
            <ChevronLeft className="w-4 h-4" /> Volver a ubicaciones
          </button>
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-black uppercase tracking-widest text-emerald-300">Ubicación</div>
                <div className="font-mono font-black text-emerald-100 text-xl">{activeLocation.location}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-mono font-black text-emerald-300">{activeLocation.available}</div>
                <div className="text-[9px] uppercase text-emerald-400/70 font-black">pz del ticket</div>
              </div>
            </div>
            {/* Progreso por talla presente en esta ubicación */}
            <div className="flex flex-wrap gap-1.5 pt-2 mt-2 border-t border-emerald-500/20">
              {Object.keys(activeLocation.sizes || {}).map(sz => {
                const falta = remainingForSize(sz);
                return (
                  <span key={sz} className={`px-2 py-0.5 rounded-lg text-[10px] font-black tabular-nums ${
                    falta > 0 ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                    {sz}: {falta > 0 ? `faltan ${falta}` : "✓"}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Cajas que el sistema tiene AQUÍ (guía). Escanea cada una; si el
              código no está en el sistema, el picker se detiene y avisa. */}
          <div className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10 text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1">
              <Boxes className="w-3.5 h-3.5" /> Cajas en esta ubicación {locBoxesLoading ? "…" : `(${locBoxes.length})`}
            </div>
            {locBoxes.length === 0 ? (
              <div className="px-3 py-3 text-center text-[11px] text-slate-500">
                {locBoxesLoading ? "Cargando…" : "Sin cajas registradas — escanea igual"}
              </div>
            ) : (
              <div className="max-h-44 overflow-auto divide-y divide-white/5">
                {locBoxes.map((b, i) => {
                  const inCart = cart.some(it => it.box_id === b.box_id);
                  return (
                    <div key={b.box_id || i} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-white/5 text-slate-300 shrink-0">{b.size}</span>
                      <div className="flex-1 min-w-0 font-mono text-xs text-slate-200 truncate">{b.box_id}</div>
                      <span className="text-emerald-300 font-mono text-xs tabular-nums shrink-0">{b.units}</span>
                      {inCart && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                    </div>
                  );
                })}
              </div>
            )}
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
              Si es una caja BOX- registrada se identifica al instante. Si no está en el sistema, avisa a tu supervisor.
            </div>
          </div>

          {/* Lista ACUMULADA de cajas escaneadas (aún sin descontar) */}
          <div className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1">
                <Boxes className="w-3.5 h-3.5" /> Cajas escaneadas ({cart.length})
              </div>
              <div className="text-[11px] font-black">
                <span className="text-emerald-300 tabular-nums">{cartQty}</span>
                <span className="text-slate-500"> · faltan </span>
                <span className="text-amber-300 tabular-nums">{Math.max(0, totalRequired - totalCommitted - cartQty)}</span>
              </div>
            </div>
            {cart.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-slate-500">
                Aún no escaneas cajas. Escanea una arriba…
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {cart.map((it, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2">
                    <span className="text-slate-500 text-[10px] font-black w-4">{i + 1}</span>
                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-white/5 text-slate-300 shrink-0">{it.size}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono font-black text-emerald-100 text-sm truncate">{it.box_id}</div>
                      {it.lpn && it.lpn !== it.box_id && (
                        <div className="text-[9px] text-slate-500 font-mono truncate">LPN: {it.lpn}</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-emerald-300 font-mono font-black tabular-nums">{it.qty}</span>
                      <span className="text-[9px] text-slate-500"> /{it.boxUnits}</span>
                    </div>
                    <button onClick={() => removeFromCart(i)}
                      className="w-8 h-8 rounded-lg bg-white/5 active:bg-rose-500/20 text-slate-400 active:text-rose-300 flex items-center justify-center shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Confirmar el LOTE completo — descuenta todas las cajas de una vez */}
          <button onClick={commitCart} disabled={committing || cart.length === 0}
            className="w-full h-16 rounded-2xl bg-emerald-600 active:bg-emerald-700 text-white text-base font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40">
            {committing ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-6 h-6" />}
            {committing ? "Guardando…" : `Guardar / Descontar (${cart.length} · ${cartQty} pz)`}
          </button>
        </div>
      )}

      {/* ══════ STAGE 4a: LPN no identificado → alto, avisa al supervisor ══════ */}
      {stage === 'unidentified' && unidentifiedLpn && (
        <div className="px-3 space-y-3">
          <div className="bg-red-500/15 border-2 border-red-500/50 rounded-2xl p-4 text-center">
            <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-2" />
            <div className="text-lg font-black uppercase tracking-widest text-red-300 leading-tight">
              Esta caja no está identificada
            </div>
            <div className="text-base font-black uppercase tracking-wide text-red-200 mt-1">
              Avisa a tu supervisor
            </div>
            <div className="text-[10px] font-black uppercase tracking-widest text-red-400/70 mt-3">Código escaneado</div>
            <div className="font-mono font-black text-red-100 text-base break-all">{unidentifiedLpn}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-[11px] text-slate-400 leading-relaxed">
            No la descuentes ni la muevas. El supervisor tiene que registrar esta
            caja antes de que se pueda surtir.
          </div>
          <button onClick={backToBoxes}
            className="w-full h-14 rounded-2xl bg-white/5 active:bg-white/10 border border-white/10 text-slate-200 text-sm font-black uppercase tracking-widest flex items-center justify-center gap-2">
            <ChevronLeft className="w-4 h-4" /> Volver a cajas
          </button>
        </div>
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
              Talla <b className="text-emerald-300">{activeBox.size}</b> · Ubic. <b className="text-blue-300 font-mono">{activeLocation.location}</b> · Faltan <b className="text-amber-300">{remainingForSize(activeBox.size)} pz</b> de {activeBox.size}
            </div>
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 px-1 mb-1">
              ¿Cuántas piezas vas a tomar de esta caja?
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setTakeQty(Math.max(0, (parseInt(takeQty) || 0) - 1))}
                className="w-16 h-16 rounded-2xl bg-white/5 active:bg-white/10 text-3xl font-black">−</button>
              <input type="number" inputMode="numeric" min="0"
                max={Math.min(activeBox.units, roomForBox(activeBox.size))}
                value={takeQty} onChange={(e) => setTakeQty(e.target.value)}
                onFocus={(e) => e.target.select()}
                className="flex-1 h-16 bg-black/40 border-2 border-blue-500/40 rounded-2xl text-center text-4xl font-mono font-black focus:outline-none focus:border-blue-400" />
              <button onClick={() => setTakeQty(Math.min(Math.min(activeBox.units, roomForBox(activeBox.size)), (parseInt(takeQty) || 0) + 1))}
                className="w-16 h-16 rounded-2xl bg-white/5 active:bg-white/10 text-3xl font-black">＋</button>
            </div>
            <div className="mt-2 text-[10px] text-slate-500 px-1">
              Máximo = mínimo entre {activeBox.units} (caja) y {roomForBox(activeBox.size)} (falta / disponible)
            </div>
          </div>

          <button onClick={addToCart} disabled={(parseInt(takeQty) || 0) <= 0}
            className="w-full h-16 rounded-2xl bg-blue-600 active:bg-blue-700 text-white text-base font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40">
            <Boxes className="w-6 h-6" />
            Agregar a la lista ({parseInt(takeQty) || 0} pz)
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

