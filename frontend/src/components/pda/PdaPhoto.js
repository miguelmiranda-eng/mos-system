import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../App";
import { Toaster, toast } from "sonner";
import {
  Camera, ChevronLeft, Loader2, CheckCircle2, AlertTriangle, Trash2,
  Package, Save, Boxes,
} from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
const fetcher = (u) => fetch(`${API}${u}`, { credentials: "include" }).then(r => (r.ok ? r.json() : Promise.reject(r)));
const poster = (u, b) => fetch(`${API}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(b) });
// Sin Content-Type a propósito: el navegador pone el boundary del multipart.
const uploader = (u, file) => {
  const fd = new FormData();
  fd.append("file", file);
  return fetch(`${API}${u}`, { method: "POST", credentials: "include", body: fd });
};

const buzz = (p) => { if (navigator.vibrate) navigator.vibrate(p); };

// Inventario por foto — material que NO está en el sistema (el cartón físico no
// trae el box_id sintético del WMS). Se fotografía la etiqueta: los dos barcodes
// dan cartón y SKU exactos, y el operador sólo confirma la cantidad, que es el
// único dato que no viaja codificado. 3 pantallas: lote → foto → cantidad.
export default function PdaPhoto() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [phase, setPhase] = useState("lote");   // lote | captura | cant
  const [lote, setLote] = useState("RP-GEN");
  const [read, setRead] = useState(null);       // { carton, sku, sku_info, sku_catalogado }
  const [lines, setLines] = useState([]);
  const [resumen, setResumen] = useState({ cartones: 0, unidades: 0, skus: 0 });
  const [busy, setBusy] = useState(false);
  const camRef = useRef(null);
  const qtyRef = useRef(null);
  const loteRef = useRef(null);

  useEffect(() => { if (user === null) navigate("/", { replace: true }); }, [user, navigate]);

  const load = useCallback(async (l) => {
    try {
      const d = await fetcher(`/recon/photo/lines?lote=${encodeURIComponent(l)}&limit=25`);
      setLines(d.lines || []);
      setResumen(d.resumen || { cartones: 0, unidades: 0, skus: 0 });
    } catch { /* la captura no depende de esto; el contador se refresca al guardar */ }
  }, []);

  useEffect(() => { if (phase === "captura") load(lote); }, [phase, lote, load]);
  useEffect(() => { if (phase === "cant") qtyRef.current?.focus(); }, [phase]);

  const startLote = (e) => {
    e?.preventDefault();
    const v = (loteRef.current?.value || "").trim().toUpperCase() || "RP-GEN";
    setLote(v); setPhase("captura"); buzz(50);
  };

  // Foto → barcodes. Si no salen los DOS códigos NO seguimos: medio dato invita
  // a teclear el otro, y ahí es donde entra el error que esto viene a evitar.
  const onPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";                        // permite repetir la misma foto
    if (!file) return;
    setBusy(true);
    try {
      const res = await uploader("/recon/label-scan", file);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.detail || "No se pudo leer la foto"); buzz([120, 60, 120]); return; }
      if (!d.ok) { toast.error(d.error || "No se leyeron los dos códigos"); buzz([120, 60, 120]); return; }
      setRead(d); setPhase("cant"); buzz(50);
    } catch { toast.error("Error de conexión"); buzz([120, 60, 120]); }
    finally { setBusy(false); }
  };

  const saveLine = async (e) => {
    e?.preventDefault();
    const units = parseInt(qtyRef.current?.value, 10);
    if (!units || units <= 0) { toast.error("Escribe la cantidad de la etiqueta"); buzz([120, 60, 120]); return; }
    setBusy(true);
    try {
      const res = await poster("/recon/photo/line", { lote, carton: read.carton, sku: read.sku, units });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.detail || "No se pudo guardar"); buzz([120, 60, 120]); return; }
      if (d.duplicado) {
        toast.warning(`Ese cartón ya fue contado (${d.line?.units} u por ${d.line?.capturado_por})`);
        buzz([120, 60, 120]);
      } else {
        toast.success(`${read.carton} · ${units} u`);
        buzz(60);
      }
      setRead(null); setPhase("captura"); load(lote);
    } catch { toast.error("Error de conexión"); buzz([120, 60, 120]); }
    finally { setBusy(false); }
  };

  const delLine = async (line_id) => {
    try {
      const res = await fetch(`${API}/recon/photo/line/${line_id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.detail || "No se pudo borrar"); return; }
      toast.success("Renglón borrado"); load(lote);
    } catch { toast.error("Error de conexión"); }
  };

  const mat = read?.sku_info;

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-slate-100 select-none" style={{ WebkitTapHighlightColor: "transparent" }}>
      <Toaster position="top-center" theme="dark" richColors />
      <header className="sticky top-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => phase === "lote" ? navigate("/wms") : (phase === "cant" ? (setRead(null), setPhase("captura")) : setPhase("lote"))}
          className="p-2 -ml-1 rounded-xl active:bg-white/10">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div className="w-9 h-9 rounded-xl bg-sky-500/20 border border-sky-400/30 flex items-center justify-center">
          <Camera className="w-5 h-5 text-sky-300" />
        </div>
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Inventario por foto</div>
          <div className="text-sm font-black truncate">{user?.name || "Contador"}</div>
        </div>
        {phase !== "lote" && (
          <div className="text-right leading-tight shrink-0">
            <div className="text-lg font-black text-sky-300">{resumen.cartones}</div>
            <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">cartones</div>
          </div>
        )}
      </header>

      <main className="p-4 max-w-md mx-auto">
        {/* ── PANTALLA 1: lote ── */}
        {phase === "lote" && (
          <form onSubmit={startLote} className="space-y-5 pt-8">
            <div className="text-center">
              <Boxes className="w-14 h-14 mx-auto text-sky-400 mb-3" />
              <h2 className="text-xl font-black uppercase tracking-wide">¿Qué material?</h2>
              <p className="text-sm text-slate-400 mt-1">Nombre del lote que estás levantando</p>
            </div>
            <input ref={loteRef} autoFocus defaultValue={lote} inputMode="text"
              className="w-full px-4 py-4 bg-white/5 border-2 border-sky-500/40 rounded-2xl text-center text-lg font-mono uppercase focus:border-sky-400 outline-none" />
            <button type="submit"
              className="w-full py-4 rounded-2xl bg-sky-500 text-black text-lg font-black uppercase tracking-widest active:bg-sky-600 flex items-center justify-center gap-2">
              <Camera className="w-5 h-5" /> Empezar
            </button>
          </form>
        )}

        {/* ── PANTALLA 2: foto + lo capturado ── */}
        {phase === "captura" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {[["Cartones", resumen.cartones, "text-sky-400"],
                ["Unidades", resumen.unidades, "text-emerald-400"],
                ["SKU", resumen.skus, "text-violet-400"]].map(([lbl, val, cls]) => (
                <div key={lbl} className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center">
                  <div className={`text-2xl font-black ${cls}`}>{val}</div>
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">{lbl}</div>
                </div>
              ))}
            </div>

            <input ref={camRef} type="file" accept="image/*" capture="environment"
              onChange={onPhoto} className="hidden" />
            <button onClick={() => camRef.current?.click()} disabled={busy}
              className="w-full py-8 rounded-3xl bg-sky-500 text-black font-black uppercase tracking-widest active:bg-sky-600 disabled:opacity-50 flex flex-col items-center justify-center gap-2 shadow-[0_0_30px_rgba(14,165,233,0.3)]">
              {busy ? <Loader2 className="w-10 h-10 animate-spin" /> : <Camera className="w-10 h-10" />}
              <span className="text-lg">{busy ? "Leyendo…" : "Tomar foto"}</span>
              <span className="text-[10px] font-bold normal-case tracking-normal opacity-70">
                Encuadra la etiqueta completa
              </span>
            </button>

            <div className="rounded-2xl bg-white/5 border border-white/10 divide-y divide-white/5 max-h-[38vh] overflow-y-auto">
              {lines.length === 0 && <div className="p-4 text-center text-sm text-slate-500">Aún no has capturado cartones en {lote}</div>}
              {lines.map(l => (
                <div key={l.line_id} className="flex items-center gap-3 px-3 py-2.5">
                  <Package className="w-5 h-5 text-sky-400 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-mono text-sm truncate">{l.carton}</span>
                    <span className="block text-[10px] text-slate-500 truncate">
                      SKU {l.sku}{l.sku_info?.style ? ` · ${l.sku_info.style}` : ""}
                    </span>
                  </span>
                  <span className="text-base font-black text-emerald-400 shrink-0">{l.units}</span>
                  <button onClick={() => delLine(l.line_id)} className="p-1.5 rounded-lg active:bg-white/10">
                    <Trash2 className="w-4 h-4 text-slate-500" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── PANTALLA 3: confirmar cantidad ── */}
        {phase === "cant" && read && (
          <form onSubmit={saveLine} className="space-y-4 pt-2">
            <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-4 text-center">
              <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-400 mb-1" />
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Cartón</div>
              <div className="text-xl font-black font-mono break-all">{read.carton}</div>
              <div className="text-sm font-bold text-sky-300 mt-1">SKU {read.sku}</div>
            </div>

            {mat ? (
              <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center text-sm">
                <div className="font-black">{[mat.style, mat.color, mat.size].filter(Boolean).join(" · ") || "—"}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">{mat.country_of_origin} · {mat.fabric_content}</div>
              </div>
            ) : (
              <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-3 flex items-center gap-2 text-xs text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                SKU nuevo. Se captura su material una sola vez desde la computadora; tú sigue contando.
              </div>
            )}

            <div>
              <label className="block text-center text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
                Unidades que dice la etiqueta
              </label>
              <input ref={qtyRef} type="number" inputMode="numeric" min="1" placeholder="0"
                className="w-full px-4 py-5 bg-white/5 border-2 border-sky-500/40 rounded-2xl text-center text-4xl font-black focus:border-sky-400 outline-none" />
            </div>

            <button type="submit" disabled={busy}
              className="w-full py-5 rounded-2xl bg-emerald-500 text-black text-lg font-black uppercase tracking-widest active:bg-emerald-600 disabled:opacity-50 flex items-center justify-center gap-2">
              {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <Save className="w-6 h-6" />} Guardar cartón
            </button>
            <button type="button" onClick={() => { setRead(null); setPhase("captura"); }}
              className="w-full py-3 rounded-2xl bg-white/10 text-white font-black uppercase tracking-widest text-sm active:bg-white/20">
              Cancelar
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
