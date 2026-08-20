import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Boxes, RefreshCw, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../App";
import { API } from "../lib/constants";
import OrderComponentsModal, { ComponentsSummary } from "./OrderComponentsModal";

/* Tablero de seguimiento: TODAS las órdenes abiertas y en qué etapa van.

   "Abierta" = todavía no sale de producción (su production_status no es LISTO
   PARA ENVIO, LISTO PARA INVENTARIO ni CANCELLED). No hay que dar de alta
   nada: si la orden existe y sigue viva, aparece aquí.

   La ETAPA no se captura, se deduce de lo que MOS ya sabe: el tablero dice
   dónde está parada la orden (BLANKS, SCREENS, NECK, MAQUINA5…) y el
   production_status dice en qué va (EN PRODUCCION, EN PROCESO DE EMPAQUE,
   NECESITA QC). El backend resuelve la precedencia; aquí sólo se pinta.

   Los componentes son una capa OPCIONAL encima: si alguien capturó el detalle
   de qué le falta a una orden, se muestra su avance; si no, la etapa sola ya
   dice dónde está. */

const hoy = () => new Date().toISOString().slice(0, 10);

const diasPara = (fecha) => {
  if (!fecha) return null;
  const d = Math.round((new Date(fecha) - new Date(hoy())) / 86400000);
  return d;
};

/* La línea de vida de una orden.

   Siete pasos fijos, siempre en el mismo orden y siempre los siete: la gracia
   es que se lean de un vistazo y que todas las órdenes se comparen en la misma
   regla. Lo que cambia es dónde está el punto lleno.

   Los pasos anteriores se pintan como recorridos porque la escalera es
   ordenada — si la orden está en Producción, pasó por Blancos. NO es historia
   registrada: MOS guarda dónde está la orden, no por dónde estuvo. Cuando haya
   fechas por etapa, aquí es donde entran. */
const Lifeline = ({ stages, actual, ahead }) => {
  const i = stages.findIndex(e => e.key === actual);
  const iAhead = ahead ? stages.findIndex(e => e.key === ahead) : -1;
  return (
    <div className="flex items-start select-none">
      {stages.map((e, idx) => {
        const pasado = i >= 0 && idx < i;
        const aqui = idx === i;
        const señalado = idx === iAhead;
        return (
          <div key={e.key} className="flex-1 flex flex-col items-center relative min-w-0">
            {/* Conector: se pinta a la izquierda de cada punto salvo el primero,
                para que la línea nazca y muera en un punto, no en el aire. */}
            {idx > 0 && (
              <span className={`absolute top-[7px] right-1/2 w-full h-0.5 ${
                idx <= i ? "bg-blue-500" : "bg-slate-200"}`} />
            )}
            <span className={`relative z-10 rounded-full transition-all ${
              aqui ? "w-4 h-4 bg-blue-600 ring-4 ring-blue-100"
                : pasado ? "w-3.5 h-3.5 bg-blue-500"
                : señalado ? "w-3.5 h-3.5 bg-white border-2 border-amber-400"
                : "w-3.5 h-3.5 bg-white border-2 border-slate-200"}`} />
            <span className={`mt-1.5 text-[10px] leading-tight text-center px-0.5 truncate w-full ${
              aqui ? "font-black text-blue-700"
                : pasado ? "font-bold text-slate-500"
                : señalado ? "font-bold text-amber-600"
                : "text-slate-300"}`}>
              {e.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const OrderComponentsBoard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  // Borrar componentes pierde el rastro de lo que se estaba esperando; el
  // backend lo exige admin y aquí se refleja para no ofrecer lo que va a fallar.
  const canDelete = ['admin', 'supersu', 'ceo'].includes(user?.role);

  const [rows, setRows] = useState([]);
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [etapa, setEtapa] = useState("");
  const [busca, setBusca] = useState("");
  const [abierta, setAbierta] = useState(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (etapa) qs.set("stage", etapa);
      const res = await fetch(`${API}/order-components/tracking?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error();
      const d = await res.json();
      setRows(d.rows || []);
      // Los conteos vienen SIN filtrar por etapa: así las pastillas siguen
      // mostrando cuántas hay en cada una aunque estés viendo sólo una.
      setStages(d.stages || []);
    } catch {
      toast.error("No se pudo cargar el tablero");
    } finally {
      setLoading(false);
    }
  }, [etapa]);

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
    // Señales discrepantes: el tablero dice una etapa y el status otra más
    // adelantada. Alguien avanzó la orden sin moverla de tablero.
    discrepan: rows.filter(r => r.stage?.ahead).length,
    detenidas: rows.filter(r => r.stage?.stalled).length,
    conDetalle: rows.filter(r => r.components > 0).length,
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
              <Boxes className="w-6 h-6 text-blue-600" /> Seguimiento de Órdenes
            </h1>
            <span className="block text-xs text-slate-500 mt-1">Todas las órdenes abiertas y en qué parte del proceso van</span>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={busca} onChange={e => setBusca(e.target.value)}
              placeholder="Orden o cliente…"
              className="h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm w-56"
              data-testid="ocb-search" />
          </div>

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
            ["Órdenes abiertas", totales.ordenes, "text-slate-900"],
            ["Señales discrepantes", totales.discrepan, "text-amber-600"],
            ["Detenidas", totales.detenidas, "text-red-600"],
            ["Con detalle capturado", totales.conDetalle, "text-blue-600"],
          ].map(([k, v, color]) => (
            <div key={k} className="bg-white border border-slate-200 rounded-xl px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{k}</div>
              <div className={`text-2xl font-black tabular-nums ${color}`}>{v}</div>
            </div>
          ))}
        </div>

        {/* Una pastilla por etapa con su conteo. Los conteos vienen sin
            filtrar, así que siguen siendo el mapa completo del proceso aunque
            estés viendo una sola etapa. */}
        <div className="flex flex-wrap gap-2 mb-4">
          <button onClick={() => setEtapa("")}
            className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${
              !etapa ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"}`}
            data-testid="ocb-stage-all">
            Todas <span className="opacity-60">{stages.reduce((a, e) => a + e.count, 0)}</span>
          </button>
          {stages.filter(e => e.count > 0).map(e => (
            <button key={e.key} onClick={() => setEtapa(etapa === e.key ? "" : e.key)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors ${
                etapa === e.key ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:border-blue-300"}`}
              data-testid={`ocb-stage-${e.key}`}>
              {e.label} <span className="opacity-60">{e.count}</span>
            </button>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="py-20 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-blue-600" /></div>
          ) : visibles.length === 0 ? (
            <div className="py-20 text-center">
              <div className="text-sm font-bold text-slate-700">
                {rows.length === 0 ? "No hay órdenes abiertas" : "Nada coincide con la búsqueda"}
              </div>
              <div className="text-sm text-slate-500 mt-1">
                {rows.length === 0
                  ? "Todas salieron de producción: su estatus ya es listo para envío o para inventario."
                  : "Prueba con otro número de orden o cliente."}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {visibles.map(r => {
                const st = r.stage || {};
                const dias = diasPara(r.cancel_date);
                const vencida = dias != null && dias < 0;
                return (
                  <div key={r.order_id}
                    onClick={() => setAbierta(r)}
                    className="px-5 py-4 hover:bg-blue-50/40 cursor-pointer flex flex-col lg:flex-row lg:items-center gap-4"
                    data-testid={`ocb-row-${r.order_number}`}>

                    {/* Identidad: lo mínimo para saber de quién es la línea */}
                    <div className="lg:w-64 shrink-0 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="font-black text-slate-900">{r.order_number}</span>
                        {r.quantity ? (
                          <span className="text-xs text-slate-400 tabular-nums">{r.quantity.toLocaleString("es-MX")} pzs</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-slate-500 truncate">{r.client || "—"}</div>
                      {r.cancel_date && (
                        <div className={`text-[11px] ${vencida ? "text-red-600 font-bold" : "text-slate-400"}`}>
                          cancel {r.cancel_date}{vencida ? " · vencida" : ""}
                        </div>
                      )}
                    </div>

                    {/* La línea de vida */}
                    <div className="flex-1 min-w-0 px-1">
                      <Lifeline stages={stages} actual={st.key} ahead={st.ahead ? st.ahead_key : null} />
                    </div>

                    {/* De dónde salió la etapa: el dato crudo siempre visible,
                        para que nadie tenga que confiar en la deducción. */}
                    <div className="lg:w-56 shrink-0 text-right">
                      <div className="text-[11px] text-slate-400 truncate">
                        {st.board || "—"}{st.status ? ` · ${st.status}` : ""}
                      </div>
                      {st.ahead && (
                        <div className="text-[11px] text-amber-600 font-bold">
                          el status dice {st.ahead_stage}
                        </div>
                      )}
                      {st.stalled && (
                        <div className="text-[11px] text-red-600 font-bold">detenida</div>
                      )}
                      {r.summary && (
                        <div className="flex justify-end mt-1">
                          <ComponentsSummary summary={r.summary} compact />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
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
