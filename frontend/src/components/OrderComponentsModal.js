import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogPortal, DialogOverlay, DialogHeader, DialogTitle } from "./ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Loader2, Plus, Trash2, X, AlertTriangle, CheckCircle2, Boxes } from "lucide-react";
import { toast } from "sonner";
import { API } from "../lib/constants";

/* Componentes de una orden: qué piezas necesita y cuál la está frenando.

   Los datos viven en su propia colección (db.order_components) y se unen con
   la orden al leer — el modelo de orden no se toca. Ver el comentario largo en
   backend/routers/order_components.py. */

export const TYPE_LABEL = {
  BLANKS: "Blancos", SCREENS: "Mallas", ART: "Arte", INK: "Tinta",
  TRIMS: "Trims", NECK_LABEL: "Neck label", PACKAGING: "Empaque", OTHER: "Otro",
};

/* La escalera va en orden: es la que decide quién frena la orden. Los dos
   terminales van aparte porque no son "más avanzado" ni "menos". */
export const LADDER = ["PENDING", "REQUESTED", "IN_TRANSIT", "RECEIVED", "READY"];
export const STATE_LABEL = {
  PENDING: "Pendiente", REQUESTED: "Solicitado", IN_TRANSIT: "En camino",
  RECEIVED: "Recibido", READY: "Listo", BLOCKED: "Atorado", N_A: "No aplica",
};
const STATE_STYLE = {
  PENDING: "bg-slate-100 text-slate-600 border-slate-200",
  REQUESTED: "bg-blue-50 text-blue-700 border-blue-200",
  IN_TRANSIT: "bg-amber-50 text-amber-700 border-amber-200",
  RECEIVED: "bg-teal-50 text-teal-700 border-teal-200",
  READY: "bg-emerald-50 text-emerald-700 border-emerald-200",
  BLOCKED: "bg-red-50 text-red-700 border-red-200",
  N_A: "bg-slate-50 text-slate-400 border-slate-200 line-through",
};
const ALL_STATES = [...LADDER, "BLOCKED", "N_A"];

const hoy = () => new Date().toISOString().slice(0, 10);

/* Barra de avance + quién frena. Es el resumen que calcula el backend; aquí
   solo se pinta, para que no existan dos maneras de contarlo. */
export const ComponentsSummary = ({ summary, compact = false }) => {
  if (!summary || !summary.total) {
    return <span className="text-xs text-slate-400">Sin componentes</span>;
  }
  const b = summary.blocking;
  return (
    <div className={compact ? "flex items-center gap-2" : "flex items-center gap-3 flex-wrap"}>
      <div className="flex items-center gap-2">
        <div className="w-24 h-1.5 rounded-full bg-slate-200 overflow-hidden">
          <div
            className={`h-full rounded-full ${summary.late ? "bg-red-500" : b ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${summary.pct}%` }}
          />
        </div>
        <span className="text-xs font-bold tabular-nums text-slate-600">
          {summary.ready}/{summary.total}
        </span>
      </div>
      {b ? (
        <span className="text-xs text-slate-600">
          Frena: <b>{TYPE_LABEL[b.type] || b.type}</b>
          <span className="text-slate-400"> · {STATE_LABEL[b.state] || b.state}</span>
        </span>
      ) : (
        <span className="text-xs text-emerald-600 flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" /> Nada la frena
        </span>
      )}
      {summary.late > 0 && (
        <span className="text-xs text-red-600 font-bold flex items-center gap-1">
          <AlertTriangle className="w-3.5 h-3.5" /> {summary.late} atrasado{summary.late > 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
};

const OrderComponentsModal = ({ order, isOpen, onClose, onChanged, canDelete = false }) => {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [nuevoTipo, setNuevoTipo] = useState("OTHER");
  const [nuevoNombre, setNuevoNombre] = useState("");

  const orderId = order?.order_id;

  const cargar = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/order-components/order/${orderId}`, { credentials: "include" });
      if (!res.ok) throw new Error();
      const d = await res.json();
      setRows(d.components || []);
      setSummary(d.summary || null);
    } catch {
      toast.error("No se pudieron cargar los componentes");
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { if (isOpen) cargar(); }, [isOpen, cargar]);

  // Se recarga desde el servidor en vez de parchar el estado local: el resumen
  // (quién frena, atrasados) lo calcula el backend, y recalcularlo aquí sería
  // una segunda implementación que se puede separar de la primera.
  const tras = async (accion, mensaje) => {
    try {
      const res = await accion();
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || "error");
      }
      await cargar();
      onChanged?.();
      if (mensaje) toast.success(mensaje);
    } catch (e) {
      toast.error(e.message === "error" ? "No se pudo guardar" : e.message);
    } finally {
      setBusy("");
    }
  };

  const editar = (id, campos) => {
    setBusy(id);
    return tras(() => fetch(`${API}/order-components/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify(campos),
    }));
  };

  const sembrar = () => {
    setBusy("seed");
    return tras(() => fetch(`${API}/order-components/order/${orderId}/seed`, {
      method: "POST", credentials: "include",
    }), "Componentes de la plantilla agregados");
  };

  const agregar = () => {
    if (nuevoTipo === "OTHER" && !nuevoNombre.trim()) {
      toast.error("Ponle nombre al componente");
      return;
    }
    setBusy("new");
    return tras(() => fetch(`${API}/order-components`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ order_id: orderId, type: nuevoTipo, name: nuevoNombre.trim() }),
    }), "Componente agregado").then(() => setNuevoNombre(""));
  };

  const borrar = (id) => {
    setBusy(id);
    return tras(() => fetch(`${API}/order-components/${id}`, {
      method: "DELETE", credentials: "include",
    }), "Componente borrado");
  };

  if (!order) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogPortal>
        <DialogOverlay className="backdrop-blur-sm bg-black/20" />
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] z-[901] w-full max-w-5xl max-h-[90vh] translate-x-[-50%] translate-y-[-50%] transform-gpu bg-card border border-border overflow-hidden flex flex-col shadow-2xl sm:rounded-2xl"
          data-testid="order-components-modal"
        >
          <DialogHeader className="px-6 pt-5 pb-3 border-b border-border">
            <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
              <Boxes className="w-5 h-5 text-royal" />
              Componentes · {order.order_number}
            </DialogTitle>
            <div className="flex items-center gap-3 flex-wrap mt-1">
              <span className="text-xs text-muted-foreground">{order.client || "—"}</span>
              {order.cancel_date && (
                <span className="text-xs text-muted-foreground">Cancel {order.cancel_date}</span>
              )}
              {summary && <ComponentsSummary summary={summary} />}
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-auto px-6 py-4">
            {loading ? (
              <div className="py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-royal" /></div>
            ) : rows.length === 0 ? (
              <div className="py-14 text-center">
                <div className="text-sm font-semibold text-foreground/80">Esta orden no tiene componentes</div>
                <div className="text-sm text-muted-foreground mt-1 mb-5">
                  Siembra la plantilla y ajusta lo que aplique.
                </div>
                <button
                  onClick={sembrar}
                  disabled={busy === "seed"}
                  className="h-10 px-5 rounded-xl bg-royal text-white text-sm font-bold inline-flex items-center gap-2 disabled:opacity-60"
                  data-testid="oc-seed"
                >
                  {busy === "seed" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Sembrar plantilla
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border">
                      <th className="text-left py-2 pr-3 font-bold">Componente</th>
                      <th className="text-left py-2 px-3 font-bold">Estado</th>
                      <th className="text-right py-2 px-3 font-bold">Pedido</th>
                      <th className="text-right py-2 px-3 font-bold">Recibido</th>
                      <th className="text-left py-2 px-3 font-bold">Compromiso</th>
                      <th className="text-left py-2 px-3 font-bold">Proveedor</th>
                      <th className="text-left py-2 px-3 font-bold">Nota</th>
                      <th className="text-center py-2 pl-3 font-bold">Frena</th>
                      {canDelete && <th className="w-8" />}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const atrasado = r.due_date && r.due_date < hoy()
                        && LADDER.indexOf(r.state) < LADDER.indexOf("RECEIVED");
                      return (
                        <tr key={r.component_id} className="border-b border-border/50 hover:bg-muted/30">
                          <td className="py-2 pr-3">
                            <div className="font-bold text-foreground">{TYPE_LABEL[r.type] || r.type}</div>
                            {r.name && <div className="text-xs text-muted-foreground">{r.name}</div>}
                          </td>
                          <td className="py-2 px-3">
                            <select
                              value={r.state}
                              disabled={busy === r.component_id}
                              onChange={e => editar(r.component_id, { state: e.target.value })}
                              className={`text-xs font-bold rounded-md border px-2 py-1 ${STATE_STYLE[r.state] || ""}`}
                              data-testid={`oc-state-${r.type}`}
                            >
                              {ALL_STATES.map(s => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
                            </select>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <input
                              type="number" min="0" defaultValue={r.qty_required ?? ""}
                              onBlur={e => {
                                const v = e.target.value === "" ? null : Number(e.target.value);
                                if (v !== (r.qty_required ?? null)) editar(r.component_id, { qty_required: v });
                              }}
                              className="w-20 text-right bg-transparent border border-border rounded px-2 py-1 tabular-nums"
                            />
                          </td>
                          <td className="py-2 px-3 text-right">
                            <input
                              type="number" min="0" defaultValue={r.qty_received ?? ""}
                              onBlur={e => {
                                const v = e.target.value === "" ? null : Number(e.target.value);
                                if (v !== (r.qty_received ?? null)) editar(r.component_id, { qty_received: v });
                              }}
                              className="w-20 text-right bg-transparent border border-border rounded px-2 py-1 tabular-nums"
                            />
                            {/* El faltante se calcula, no se captura: si se guardara
                                se desincroniza en cuanto cambia cualquiera de los dos. */}
                            {r.qty_required != null && r.qty_received != null && r.qty_received < r.qty_required && (
                              <div className="text-[10px] text-amber-600 font-bold">
                                faltan {r.qty_required - r.qty_received}
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="date" defaultValue={r.due_date || ""}
                              onBlur={e => { if ((e.target.value || null) !== (r.due_date || null)) editar(r.component_id, { due_date: e.target.value }); }}
                              className={`bg-transparent border rounded px-2 py-1 text-xs ${atrasado ? "border-red-400 text-red-600 font-bold" : "border-border"}`}
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              defaultValue={r.supplier || ""} placeholder="—"
                              onBlur={e => { if (e.target.value !== (r.supplier || "")) editar(r.component_id, { supplier: e.target.value }); }}
                              className="w-28 bg-transparent border border-border rounded px-2 py-1 text-xs"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              defaultValue={r.note || ""} placeholder="—"
                              onBlur={e => { if (e.target.value !== (r.note || "")) editar(r.component_id, { note: e.target.value }); }}
                              className="w-44 bg-transparent border border-border rounded px-2 py-1 text-xs"
                            />
                          </td>
                          <td className="py-2 pl-3 text-center">
                            <input
                              type="checkbox" checked={!!r.blocks}
                              onChange={e => editar(r.component_id, { blocks: e.target.checked })}
                              title="Si está marcado, este componente detiene la producción"
                            />
                          </td>
                          {canDelete && (
                            <td className="py-2">
                              <button onClick={() => borrar(r.component_id)} disabled={busy === r.component_id}
                                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                                title="Borrar componente">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {rows.length > 0 && (
            <div className="px-6 py-3 border-t border-border flex items-center gap-2 flex-wrap">
              <select value={nuevoTipo} onChange={e => setNuevoTipo(e.target.value)}
                className="h-9 px-2 rounded-lg border border-border bg-card text-sm" data-testid="oc-new-type">
                {Object.keys(TYPE_LABEL).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              <input
                value={nuevoNombre} onChange={e => setNuevoNombre(e.target.value)}
                placeholder="Nombre (para distinguir dos del mismo tipo)"
                className="h-9 px-3 rounded-lg border border-border bg-card text-sm flex-1 min-w-[220px]"
              />
              <button onClick={agregar} disabled={busy === "new"}
                className="h-9 px-4 rounded-lg border border-border text-sm font-bold inline-flex items-center gap-2 hover:border-royal hover:text-royal disabled:opacity-60"
                data-testid="oc-add">
                {busy === "new" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Agregar
              </button>
              <button onClick={sembrar} disabled={busy === "seed"}
                className="h-9 px-4 rounded-lg border border-border text-sm font-bold hover:border-royal hover:text-royal disabled:opacity-60"
                title="Agrega los tipos de la plantilla que falten. No duplica ni pisa lo capturado.">
                Completar plantilla
              </button>
            </div>
          )}

          <DialogPrimitive.Close className="absolute right-4 top-4 p-1 rounded-full hover:bg-muted">
            <X className="w-4 h-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
};

export default OrderComponentsModal;
