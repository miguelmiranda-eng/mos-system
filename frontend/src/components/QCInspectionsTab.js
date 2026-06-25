import React, { useState, useEffect, useCallback } from "react";
import { API } from "../lib/constants";
import { toast } from "sonner";
import { Loader2, Plus, ShieldCheck, Lock, ChevronRight, Clock } from "lucide-react";
import QCInspectionModal from "./QCInspectionModal";
import { pointSatisfied } from "../lib/qcInspection";

export default function QCInspectionsTab({ canWrite, isDark }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [orderNo, setOrderNo] = useState("");
  const [starting, setStarting] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/qc/inspections`, { credentials: "include" });
      const data = res.ok ? await res.json() : [];
      setList(Array.isArray(data) ? data : []);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const start = async () => {
    const on = orderNo.trim();
    if (!on) { toast.error("Escribe el número de orden"); return; }
    setStarting(true);
    try {
      const res = await fetch(`${API}/qc/inspections`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ order_number: on }),
      });
      if (res.ok) {
        const data = await res.json();
        setOrderNo("");
        setOpenId(data.inspection_id);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "No se pudo iniciar la inspección");
      }
    } catch { toast.error("Error de conexión"); }
    finally { setStarting(false); }
  };

  return (
    <div className="p-4 sm:p-6">
      {/* Start a new inspection */}
      {canWrite && (
        <div className="flex flex-col sm:flex-row gap-2 mb-5 max-w-xl">
          <input
            value={orderNo}
            onChange={e => setOrderNo(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") start(); }}
            placeholder="Número de orden a inspeccionar…"
            className={`flex-1 px-3 py-2.5 rounded-xl border text-sm focus:outline-none focus:border-primary ${isDark ? "bg-white/5 border-white/10 text-white" : "bg-white border-slate-200"}`}
          />
          <button onClick={start} disabled={starting}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-royal text-white font-bold text-sm disabled:opacity-50 active:scale-95 transition-transform whitespace-nowrap">
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Nueva inspección
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-royal" /></div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
          <ShieldCheck className="w-12 h-12 opacity-30" />
          <p className="font-bold">Sin inspecciones por puntos todavía</p>
          {canWrite && <p className="text-sm">Inicia una arriba con el número de orden.</p>}
        </div>
      ) : (
        <div className="space-y-2.5">
          {list.map(ins => {
            const total = (ins.items || []).length;
            const done = (ins.items || []).filter(pointSatisfied).length;
            const completed = ins.status === "completed";
            return (
              <button key={ins.inspection_id} onClick={() => setOpenId(ins.inspection_id)}
                className={`w-full flex items-center gap-3 p-4 rounded-2xl border text-left transition-colors ${isDark ? "bg-white/3 border-white/8 hover:bg-white/5" : "bg-white border-slate-100 hover:bg-slate-50"}`}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${completed ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}`}>
                  {completed ? <Lock className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-black text-foreground truncate">#{ins.order_number} {ins.client && <span className="text-sm font-bold text-muted-foreground">· {ins.client}</span>}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {ins.inspector || "—"} · {ins.created_at ? new Date(ins.created_at).toLocaleDateString() : ""}
                    {" · "}
                    <span className={completed ? "text-emerald-500 font-bold" : "text-amber-500 font-bold"}>
                      {completed ? "Completada" : `${done}/${total} puntos`}
                    </span>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      {openId && (
        <QCInspectionModal inspectionId={openId} onClose={() => setOpenId(null)} onChanged={load} />
      )}
    </div>
  );
}
