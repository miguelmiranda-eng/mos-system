import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Boxes, RefreshCw, Loader2, Search, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../App";
import { API } from "../lib/constants";
import OrderComponentsModal, { ComponentsSummary, TYPE_LABEL, STATE_LABEL } from "./OrderComponentsModal";

/* Tablero de componentes: una fila por ORDEN, no por componente.

   El punto no es la lista de piezas — eso está en el modal de cada orden — es
   ver de un golpe qué órdenes están detenidas y por qué. El backend ya devuelve
   el resumen calculado (avance, quién frena, atrasados, fecha realista); aquí
   solo se ordena y se pinta.

   Ojo con el orden de llegada: el backend ya trae las filas priorizadas
   (atrasadas primero, luego menor avance, luego cancel_date). El re-ordenado de
   esta vista es solo para las columnas que el usuario elija. */

const hoy = () => new Date().toISOString().slice(0, 10);

const diasPara = (fecha) => {
  if (!fecha) return null;
  const d = Math.round((new Date(fecha) - new Date(hoy())) / 86400000);
  return d;
};

const OrderComponentsBoard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  // Borrar componentes pierde el rastro de lo que se estaba esperando; el
  // backend lo exige admin y aquí se refleja para no ofrecer lo que va a fallar.
  const canDelete = ['admin', 'supersu', 'ceo'].includes(user?.role);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [soloAtrasadas, setSoloAtrasadas] = useState(false);
  const [busca, setBusca] = useState("");
  const [abierta, setAbierta] = useState(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (soloAtrasadas) qs.set("only_late", "true");
      const res = await fetch(`${API}/order-components/tracking?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error();
      const d = await res.json();
      setRows(d.rows || []);
    } catch {
      toast.error("No se pudo cargar el tablero");
    } finally {
      setLoading(false);
    }
  }, [soloAtrasadas]);

  useEffect(() => { cargar(); }, [cargar]);

  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      String(r.order_number || "").toLowerCase().includes(q) ||
      String(r.client || "").toLowerCase().includes(q));
  }, [rows, busca]);

  const totales = useMemo(() => ({
    ordenes: rows.length,
    atrasadas: rows.filter(r => r.summary.late > 0).length,
    detenidas: rows.filter(r => r.summary.blocking).length,
    libres: rows.filter(r => !r.summary.blocking).length,
  }), [rows]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-lg border-b border-slate-200">
        <div className="max-w-[1500px] mx-auto px-4 md:px-8 py-4 flex items-center gap-3 flex-wrap">
          <button onClick={() => navigate('/home')}
            className="p-2 rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 transition-colors"
            title="Volver" data-testid="ocb-back">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="leading-none mr-auto">
            <h1 className="text-2xl font-black tracking-tight text-slate-900 flex items-center gap-2">
              <Boxes className="w-6 h-6 text-blue-600" /> Componentes de Orden
            </h1>
            <span className="block text-xs text-slate-500 mt-1">Qué le falta a cada orden y qué la está deteniendo</span>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={busca} onChange={e => setBusca(e.target.value)}
              placeholder="Orden o cliente…"
              className="h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm w-56"
              data-testid="ocb-search" />
          </div>

          <button onClick={() => setSoloAtrasadas(v => !v)}
            className={`h-10 px-4 rounded-xl border text-sm font-bold flex items-center gap-2 transition-colors ${
              soloAtrasadas ? "bg-red-600 border-red-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:border-red-300"}`}
            data-testid="ocb-only-late">
            <AlertTriangle className="w-4 h-4" /> Solo atrasadas
          </button>

          <button onClick={cargar} disabled={loading}
            className="h-10 px-4 rounded-xl bg-white border border-slate-200 text-sm font-bold text-slate-600 flex items-center gap-2 hover:border-blue-300 disabled:opacity-60">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Actualizar
          </button>
        </div>
      </header>

      <main className="max-w-[1500px] mx-auto px-4 md:px-8 py-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          {[
            ["Órdenes con componentes", totales.ordenes, "text-slate-900"],
            ["Con algo atrasado", totales.atrasadas, "text-red-600"],
            ["Detenidas", totales.detenidas, "text-amber-600"],
            ["Nada las frena", totales.libres, "text-emerald-600"],
          ].map(([k, v, color]) => (
            <div key={k} className="bg-white border border-slate-200 rounded-xl px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{k}</div>
              <div className={`text-2xl font-black tabular-nums ${color}`}>{v}</div>
            </div>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="py-20 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-blue-600" /></div>
          ) : visibles.length === 0 ? (
            <div className="py-20 text-center">
              <div className="text-sm font-bold text-slate-700">
                {rows.length === 0 ? "Ninguna orden tiene componentes todavía" : "Nada coincide con la búsqueda"}
              </div>
              <div className="text-sm text-slate-500 mt-1">
                {rows.length === 0
                  ? "Abre una orden desde el tablero y siembra su plantilla para empezar a seguirla."
                  : "Prueba con otro número de orden o cliente."}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-slate-400 border-b border-slate-200 bg-slate-50">
                    <th className="text-left py-3 px-4 font-bold">Orden</th>
                    <th className="text-left py-3 px-4 font-bold">Cliente</th>
                    <th className="text-left py-3 px-4 font-bold">Avance</th>
                    <th className="text-left py-3 px-4 font-bold">Qué la frena</th>
                    <th className="text-left py-3 px-4 font-bold">Compromiso</th>
                    <th className="text-left py-3 px-4 font-bold">Cancel date</th>
                    <th className="text-left py-3 px-4 font-bold">Producción</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map(r => {
                    const s = r.summary;
                    const b = s.blocking;
                    // El semáforo real: si lo que frena vence DESPUÉS del cancel
                    // date, la orden ya no llega aunque nadie lo haya notado.
                    const noLlega = s.worst_due && r.cancel_date && s.worst_due > r.cancel_date;
                    const dias = diasPara(s.worst_due);
                    return (
                      <tr key={r.order_id}
                        onClick={() => setAbierta(r)}
                        className="border-b border-slate-100 hover:bg-blue-50/40 cursor-pointer"
                        data-testid={`ocb-row-${r.order_number}`}>
                        <td className="py-3 px-4 font-black text-slate-900">{r.order_number}</td>
                        <td className="py-3 px-4 text-slate-600">{r.client || "—"}</td>
                        <td className="py-3 px-4"><ComponentsSummary summary={s} compact /></td>
                        <td className="py-3 px-4">
                          {b ? (
                            <span className="text-slate-700">
                              <b>{TYPE_LABEL[b.type] || b.type}</b>
                              <span className="text-slate-400"> · {STATE_LABEL[b.state] || b.state}</span>
                            </span>
                          ) : <span className="text-emerald-600 font-bold">—</span>}
                        </td>
                        <td className="py-3 px-4">
                          {s.worst_due ? (
                            <span className={noLlega ? "text-red-600 font-bold" : dias != null && dias < 0 ? "text-red-600" : "text-slate-600"}>
                              {s.worst_due}
                              {noLlega && <span className="block text-[10px] uppercase tracking-wide">no llega al cancel</span>}
                            </span>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="py-3 px-4 text-slate-600">{r.cancel_date || "—"}</td>
                        <td className="py-3 px-4 text-xs text-slate-500">{r.production_status || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      <OrderComponentsModal
        order={abierta}
        isOpen={!!abierta}
        onClose={() => setAbierta(null)}
        onChanged={cargar}
        canDelete={canDelete}
      />
    </div>
  );
};

export default OrderComponentsBoard;
