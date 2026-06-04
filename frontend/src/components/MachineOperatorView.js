import React, { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../App";
import { useTheme } from "../contexts/ThemeContext";
import { Toaster, toast } from "sonner";
import {
  Factory, Search, LogOut, Loader2, Package, RefreshCw, MessageSquare,
} from "lucide-react";
import ProductionModal from "./ProductionModal";
import { CommentsModal } from "./dashboard/CommentsModal";
import { EditableCell } from "./dashboard/EditableCell";
import { DEFAULT_COLUMNS } from "../lib/constants";

const BACKEND = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND}/api`;
const WS_URL = `${BACKEND}`.replace(/^http/, "ws") + "/api/ws";
const STORAGE_BOARD = "operator_board";

const FALLBACK_BOARDS = [
  ...Array.from({ length: 14 }, (_, i) => `MAQUINA${i + 1}`),
  "NECK", "BLANKS", "SCREENS",
];

// Boards operators must not see. Exact matches for the known names plus
// substring patterns for boards whose exact name varies (respaldo monday,
// cancelled/cancelado, inventario, papelera).
const HIDDEN_EXACT = new Set(["MASTER", "EJEMPLOS", "COMPLETOS", "EDI", "FINAL BILL"]);
const HIDDEN_PATTERNS = ["RESPALDO", "CANCEL", "INVENTARIO", "PAPELERA"];
const isHiddenBoard = (name) => {
  const n = String(name || "").trim().toUpperCase();
  return HIDDEN_EXACT.has(n) || HIDDEN_PATTERNS.some(p => n.includes(p));
};
const visibleBoards = (list) => (list || []).filter(b => !isHiddenBoard(b));

const fetcher = (path) =>
  fetch(`${API}${path}`, { credentials: "include" }).then(r => (r.ok ? r.json() : Promise.reject(r)));

export default function MachineOperatorView() {
  const { user, logout } = useAuth();
  const { setTheme } = useTheme();
  // Operator profile always starts in light theme.
  useEffect(() => { setTheme("light"); }, [setTheme]);
  // Operators see every board in the system and can freely switch between them.
  // The full list comes from /config/boards (same source as the Dashboard);
  // FALLBACK_BOARDS keeps the selector populated if that fetch fails.
  const [boards, setBoards] = useState(() => visibleBoards(FALLBACK_BOARDS));
  const [board, setBoard] = useState(() => {
    const saved = localStorage.getItem(STORAGE_BOARD);
    return saved && !isHiddenBoard(saved) ? saved : "MAQUINA1";
  });
  const [orders, setOrders] = useState([]);
  const [allOrdersForCapture, setAllOrdersForCapture] = useState([]);
  const [options, setOptions] = useState({});
  const [productionSummary, setProductionSummary] = useState({});
  const [neckSummary, setNeckSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [showProduction, setShowProduction] = useState(false);
  const [capturaLoading, setCapturaLoading] = useState(false);
  const [commentsOrder, setCommentsOrder] = useState(null);
  const wsRef = useRef(null);
  const summaryTimerRef = useRef(null);

  useEffect(() => { localStorage.setItem(STORAGE_BOARD, board); }, [board]);

  // Orders for the active board only (lightweight — no full /orders fetch).
  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetcher(`/orders?board=${encodeURIComponent(board)}&limit=500`);
      setOrders(Array.isArray(data) ? data : (data.orders || []));
    } catch {
      toast.error("No se pudieron cargar las órdenes");
    } finally { setLoading(false); }
  }, [board]);
  useEffect(() => { loadOrders(); }, [loadOrders, refreshTick]);

  // Select options for select-type column badges (read-only EditableCell still
  // wants this to render colored chips correctly).
  useEffect(() => {
    fetcher("/config/options").then(setOptions).catch(() => {});
    fetcher("/config/boards")
      .then(d => { if (Array.isArray(d?.boards) && d.boards.length) setBoards(visibleBoards(d.boards)); })
      .catch(() => {});
  }, []);

  // Production + neck summaries refresh every 60s, not per-event like the
  // Dashboard. WebSocket below also pings these for snappier feedback after
  // the operator captures.
  const loadSummaries = useCallback(async () => {
    try {
      const [prod, neck] = await Promise.all([
        fetcher("/production-summary").catch(() => ({})),
        fetcher("/neck-summary").catch(() => ({})),
      ]);
      setProductionSummary(prod || {});
      setNeckSummary(neck || {});
    } catch { /* silent */ }
  }, []);
  useEffect(() => {
    loadSummaries();
    summaryTimerRef.current = setInterval(loadSummaries, 60000);
    return () => clearInterval(summaryTimerRef.current);
  }, [loadSummaries]);

  // Lazy-load full order list the first time the operator opens Captura — the
  // production modal searches across boards, so it needs everything.
  const ensureAllOrders = useCallback(async () => {
    if (allOrdersForCapture.length > 0) return;
    try {
      const data = await fetcher("/orders?limit=5000");
      setAllOrdersForCapture(Array.isArray(data) ? data : (data.orders || []));
    } catch { /* silent — modal still works, no autocomplete */ }
  }, [allOrdersForCapture.length]);

  // Same WebSocket signal handling as Dashboard: refresh summaries on
  // production_update and reload the board on order_change.
  useEffect(() => {
    if (!user) return;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "production_update" || msg.type === "neck_update") {
            loadSummaries();
            setRefreshTick(t => t + 1);
          } else if (msg.type === "order_change") {
            setRefreshTick(t => t + 1);
          }
        } catch { /* ignore */ }
      };
    } catch { /* ignore */ }
    return () => { try { ws?.close(); } catch {} };
  }, [user, loadSummaries]);

  // Global search — same flow as Dashboard's handleGlobalSearch: hits backend,
  // switches to the first result's board so the operator sees the match in
  // context. Falls through to a toast when nothing matches.
  const handleSearch = useCallback(async (e) => {
    if (e.key !== "Enter") return;
    const q = search.trim();
    if (!q) return;
    setSearching(true);
    try {
      const res = await fetch(`${API}/orders?search=${encodeURIComponent(q)}`, { credentials: "include" });
      if (!res.ok) { toast.error("Error al buscar"); return; }
      const all = await res.json();
      const filtered = (Array.isArray(all) ? all : []).filter(o => !isHiddenBoard(o.board));
      if (filtered.length === 0) {
        toast.error("Sin coincidencias globales");
        return;
      }
      // Operators can navigate to any board now — jump to the first result's
      // board so they see the match in context.
      const found = filtered[0];
      if (found.board !== board) {
        setBoard(found.board);
      }
      if (filtered.length === 1) {
        const exact = String(found.order_number || "").trim().toLowerCase() === q.toLowerCase();
        toast.success(exact ? `Orden ${found.order_number} → ${found.board}` : `Encontrada en orden ${found.order_number} (${found.board})`);
      } else {
        toast.info(`${filtered.length} coincidencias · mostrando ${found.board}`);
      }
    } catch {
      toast.error("Error de conexión");
    } finally { setSearching(false); }
  }, [search, board]);

  // Operator-scoped cell update. Only production_status is wired through —
  // every other column stays read-only on this view. Optimistic update of
  // local state + PUT to /orders/{id}. Respects the QC lock that the
  // Dashboard's handler also honors.
  const handleCellUpdate = useCallback(async (orderId, field, value) => {
    if (field !== "production_status") return;
    const target = orders.find(o => o.order_id === orderId);
    if (target?.locked_by_qc) {
      toast.error("Orden bloqueada por QC — pide a un supervisor que la libere.");
      return;
    }
    // Optimistic local update so the badge changes color immediately.
    setOrders(prev => prev.map(o => o.order_id === orderId ? { ...o, [field]: value } : o));
    try {
      const res = await fetch(`${API}/orders/${orderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "No se pudo actualizar el estatus");
        // Revert on failure.
        setRefreshTick(t => t + 1);
        return;
      }
      toast.success(`Producción actualizada: ${value}`);
    } catch {
      toast.error("Error de conexión");
      setRefreshTick(t => t + 1);
    }
  }, [orders]);

  const openCapture = async () => {
    // First click hits /orders?limit=5000 to feed the production modal's
    // autocomplete. Subsequent clicks return instantly. The spinner only
    // really shows during that first fetch.
    setCapturaLoading(true);
    try {
      await ensureAllOrders();
      setShowProduction(true);
    } finally { setCapturaLoading(false); }
  };

  // Use the project's default column config so the visual matches Dashboard.
  // Editing is disabled per cell — read-only operator view.
  const visibleColumns = DEFAULT_COLUMNS;
  const gridTemplate = `48px 200px ${visibleColumns
    .filter(c => c.key !== "order_number")
    .map(col => `${col.width}px`).join(" ")} minmax(180px, 1fr) 110px`;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Toaster position="top-right" />

      {/* Top bar */}
      <header className="border-b border-border/40 bg-card/40 backdrop-blur-md px-4 py-3 sticky top-0 z-30">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center">
              <Factory className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Operador</div>
              <div className="text-sm font-black uppercase tracking-tight">{user?.name || user?.email}</div>
            </div>
          </div>

          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <select
              value={board}
              onChange={(e) => setBoard(e.target.value)}
              className="h-10 px-3 bg-secondary/60 border border-border rounded-lg text-sm font-mono font-black uppercase tracking-widest focus:outline-none focus:border-primary"
              data-testid="operator-board-select"
            >
              {(boards.includes(board) ? boards : [board, ...boards]).map(b => <option key={b} value={b}>{b}</option>)}
            </select>

            <div className="relative w-72">
              {searching ? (
                <Loader2 className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />
              ) : (
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              )}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearch}
                placeholder="Buscar (enter para global)…"
                className="w-full h-10 pl-9 pr-3 bg-secondary/60 border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                data-testid="operator-search"
              />
            </div>

            <button
              onClick={openCapture}
              disabled={capturaLoading}
              className="h-10 px-5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-black uppercase tracking-widest text-xs flex items-center gap-2 shadow-md transition-all disabled:opacity-70 disabled:cursor-not-allowed"
              data-testid="operator-captura"
            >
              {capturaLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Cargando…
                </>
              ) : (
                <>
                  <Factory className="w-4 h-4" />
                  Captura
                </>
              )}
            </button>

            <button
              onClick={() => setRefreshTick(t => t + 1)}
              className="h-10 w-10 flex items-center justify-center bg-secondary/60 hover:bg-secondary text-muted-foreground hover:text-foreground rounded-lg transition-all"
              title="Refrescar"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>

            <button
              onClick={logout}
              className="h-10 px-3 bg-destructive/10 hover:bg-destructive/20 text-destructive rounded-lg font-bold text-xs flex items-center gap-1.5 transition-all"
            >
              <LogOut className="w-4 h-4" /> Salir
            </button>
          </div>
        </div>
      </header>

      {/* Board heading */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-border/30">
        <div className="text-3xl font-black uppercase tracking-tighter text-muted-foreground/40 select-none pointer-events-none">
          {board}
        </div>
        <div className="text-[11px] font-mono font-bold text-muted-foreground">
          {orders.length} {orders.length === 1 ? "orden" : "órdenes"}
        </div>
      </div>

      {/* Table */}
      <main className="flex-1 overflow-auto px-4 pb-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin mb-3" />
            <span className="text-[11px] font-bold uppercase tracking-widest">Cargando órdenes…</span>
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground/50">
            <Package className="w-12 h-12 mb-3 opacity-40" />
            <p className="text-sm font-black uppercase tracking-widest">Sin órdenes en {board}</p>
          </div>
        ) : (
          <div role="table" className="text-sm isolate" style={{
            display: "grid",
            gridTemplateColumns: gridTemplate,
            minWidth: "100%",
            width: "max-content",
          }}>
            {/* Header — checkbox slot, order column, then every visible column,
                then RESTANTE, then NECK %. Sticky on the left two for context. */}
            <div className="py-3 px-2 sticky left-0 top-0 z-[50] border-r border-b border-border/10 bg-card flex items-center justify-center" style={{ width: 48 }}></div>
            <div className="py-3 px-2 sticky left-[48px] top-0 z-[50] text-left text-[10px] font-bold tracking-[0.2em] uppercase border-r border-b border-border/10 bg-card text-muted-foreground" style={{ width: 200 }}>
              Orden
            </div>
            {visibleColumns.filter(c => c.key !== "order_number").map(col => (
              <div key={col.key} className="py-3 px-3 text-left text-[10px] font-bold tracking-[0.2em] uppercase border-b border-border/10 bg-card text-muted-foreground" style={{ width: col.width, minWidth: col.width }}>
                {col.label}
              </div>
            ))}
            <div className="py-3 px-3 text-left text-[10px] font-bold tracking-[0.2em] uppercase border-b border-border/10 bg-card text-muted-foreground" style={{ minWidth: 180 }}>
              Restante
            </div>
            <div className="py-3 px-3 text-left text-[10px] font-bold tracking-[0.2em] uppercase border-b border-border/10 bg-card text-pink-400" style={{ width: 110 }}>
              Neck %
            </div>

            {/* Rows */}
            {orders.map(order => {
              const prodData = productionSummary[order.order_number] || { total_produced: 0 };
              const neckData = neckSummary?.[order.order_number] || { total_neck_cut: 0 };
              const total = Number(order.quantity) || 0;
              const produced = Number(prodData.total_produced) || 0;
              const neckCut = Number(neckData.total_neck_cut) || 0;
              const remaining = Math.max(0, total - produced);
              const pct = total > 0 ? Math.min(100, Math.round((produced / total) * 100)) : 0;
              const neckPct = total > 0 ? Math.min(100, Math.round((neckCut / total) * 100)) : 0;
              const barColor = pct >= 100 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";

              return (
                <React.Fragment key={order.order_id}>
                  <div className="py-4 px-2 sticky left-0 border-r border-b border-border/10 bg-card flex items-center justify-center" style={{ width: 48 }}>
                    <button
                      onClick={() => setCommentsOrder(order)}
                      className="p-1 rounded-lg transition-all hover:bg-secondary hover:scale-110 active:scale-95 text-slate-500 hover:text-primary relative"
                      title="Comentarios"
                      data-testid={`operator-comments-${order.order_id}`}
                    >
                      <MessageSquare className="w-5 h-5" />
                      {order._comments_count > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-royal rounded-full border border-background" />
                      )}
                    </button>
                  </div>
                  <div className="py-4 px-3 sticky left-[48px] border-r border-b border-border/10 bg-card" style={{ width: 200 }}>
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className="text-2xl font-black tracking-tighter text-primary">{order.order_number}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                      {order.art_neck_status && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black border bg-blue-500/10 text-blue-500 border-blue-500/20">NECK</span>
                      )}
                      {order.art_sep_status && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black border bg-emerald-500/10 text-emerald-500 border-emerald-500/20">SEP</span>
                      )}
                    </div>
                  </div>
                  {visibleColumns.filter(c => c.key !== "order_number").map(col => {
                    const editable = col.key === "production_status";
                    return (
                      <div key={col.key} className={`py-3 px-3 border-b border-border/10 flex items-center ${editable ? "bg-primary/[0.03]" : ""}`} style={{ width: col.width, minWidth: col.width }}>
                        <EditableCell
                          orderId={order.order_id}
                          field={col.key}
                          value={order[col.key]}
                          type={col.type}
                          options={col.optionKey ? options[col.optionKey] : []}
                          onUpdate={editable ? handleCellUpdate : () => {}}
                          readOnly={!editable}
                          allOrders={orders}
                          columns={visibleColumns}
                        />
                      </div>
                    );
                  })}
                  {/* Restante */}
                  <div className="py-3 px-3 border-b border-border/10 flex flex-col justify-center gap-1" style={{ minWidth: 180 }}>
                    <div className="flex justify-between items-center text-[10px] font-mono font-black">
                      <span className={remaining === 0 ? "text-green-500" : "text-muted-foreground"}>
                        {remaining.toLocaleString()} pz
                      </span>
                      <span className={pct >= 100 ? "text-green-500" : "text-primary"}>
                        {pct}%
                      </span>
                    </div>
                    <div className="w-full h-2 bg-secondary rounded-full overflow-hidden border border-border/5">
                      <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} title={`${produced} / ${total}`} />
                    </div>
                  </div>
                  {/* Neck % */}
                  <div className="py-3 px-3 border-b border-border/10 flex items-center justify-center" style={{ width: 110 }}>
                    <span className={`text-sm font-black font-mono ${neckPct >= 100 ? "text-green-500" : neckPct >= 50 ? "text-amber-500" : "text-pink-500"}`} title={`Neck: ${neckCut} / ${total}`}>
                      {neckPct}%
                    </span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </main>

      <ProductionModal
        isOpen={showProduction}
        onClose={() => setShowProduction(false)}
        orders={allOrdersForCapture.length > 0 ? allOrdersForCapture : orders}
        onProductionUpdate={() => { loadSummaries(); setRefreshTick(t => t + 1); }}
        isAdmin={user?.role === "admin"}
      />

      <CommentsModal
        order={commentsOrder}
        isOpen={!!commentsOrder}
        onClose={() => setCommentsOrder(null)}
        currentUser={user}
      />
    </div>
  );
}
