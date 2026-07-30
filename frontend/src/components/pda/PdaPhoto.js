import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../App";
import { Toaster, toast } from "sonner";
import { Camera, ChevronLeft, Loader2, Trash2, CheckCircle2, Images } from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
const fetcher = (u) => fetch(`${API}${u}`, { credentials: "include" }).then(r => (r.ok ? r.json() : Promise.reject(r)));
// Sin Content-Type a propósito: el navegador pone el boundary del multipart.
const uploader = (u, file) => {
  const fd = new FormData();
  fd.append("file", file);
  return fetch(`${API}${u}`, { method: "POST", credentials: "include", body: fd });
};
// Las fotos se sirven en /api/uploads (fuera de /api/wms); el backend devuelve la
// URL relativa y aquí la volvemos absoluta contra el mismo backend.
const IMG = (u) => (u ? `${process.env.REACT_APP_BACKEND_URL}${u}` : "");

const buzz = (p) => { if (navigator.vibrate) navigator.vibrate(p); };

// Inventario por foto — captura SIMPLE. El piso sólo toma fotos y se guardan:
// sin contenedor, sin OCR, sin modal, sin capturar datos. Cada foto se aloja y
// se segmenta en packing lists de 550 (por orden). La información se saca
// después, con IA, sobre las fotos guardadas.
export default function PdaPhoto() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [recent, setRecent] = useState([]);       // últimas fotos (para verlas)
  const [total, setTotal] = useState(0);          // total global guardado
  const [packingNo, setPackingNo] = useState(1);  // packing en curso
  const [enPacking, setEnPacking] = useState(0);  // fotos del packing en curso
  const [packingSize, setPackingSize] = useState(550);
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState(null);      // resalta la recién guardada
  const camRef = useRef(null);

  useEffect(() => { if (user === null) navigate("/", { replace: true }); }, [user, navigate]);

  const load = useCallback(async () => {
    try {
      const d = await fetcher(`/recon/photo/archive?limit=24`);
      setRecent(d.items || []);
      setTotal(d.total || 0);
      setPackingSize(d.packing_size || 550);
      const last = (d.packings || []).slice(-1)[0];
      setPackingNo(last ? last.packing_no : 1);
      setEnPacking(last ? last.fotos : 0);
    } catch { /* la captura no depende de esto */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";                          // permite repetir la misma foto
    if (!file) return;
    setBusy(true);
    try {
      const res = await uploader("/recon/photo/archive", file);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.detail || "No se pudo guardar la foto"); buzz([120, 60, 120]); return; }
      setRecent(p => [d.photo, ...p].slice(0, 24));
      setTotal(d.total || 0);
      setPackingNo(d.packing_no || 1);
      setEnPacking(d.en_packing || 0);
      setPackingSize(d.packing_size || 550);
      setLastId(d.photo?.photo_id || null);
      buzz(60);
    } catch { toast.error("Error de conexión"); buzz([120, 60, 120]); }
    finally { setBusy(false); }
  };

  const del = async (photo_id) => {
    try {
      const res = await fetch(`${API}/recon/photo/archive/${photo_id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.detail || "No se pudo borrar"); return; }
      setRecent(p => p.filter(x => x.photo_id !== photo_id));
      load();
    } catch { toast.error("Error de conexión"); }
  };

  const pct = Math.min(100, Math.round((enPacking / (packingSize || 550)) * 100));

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-slate-100 select-none" style={{ WebkitTapHighlightColor: "transparent" }}>
      <Toaster position="top-center" theme="dark" richColors />
      <header className="sticky top-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => navigate("/wms")} className="p-2 -ml-1 rounded-xl active:bg-white/10">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div className="w-9 h-9 rounded-xl bg-sky-500/20 border border-sky-400/30 flex items-center justify-center">
          <Camera className="w-5 h-5 text-sky-300" />
        </div>
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Inventario por foto</div>
          <div className="text-sm font-black truncate">{user?.name || "Contador"}</div>
        </div>
        <div className="text-right leading-tight shrink-0">
          <div className="text-lg font-black text-sky-300">{total}</div>
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">fotos</div>
        </div>
      </header>

      <main className="p-4 max-w-md mx-auto space-y-4">
        {/* Progreso del packing en curso (segmenta cada 550) */}
        <div className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Packing en curso</div>
            <div className="text-sm font-black text-sky-300">#{packingNo}</div>
          </div>
          <div className="h-2 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-right text-[11px] font-bold text-slate-400 tabular-nums">
            {enPacking} / {packingSize}
          </div>
        </div>

        {/* Botón único: tomar foto */}
        <input ref={camRef} type="file" accept="image/*" capture="environment" onChange={onPhoto} className="hidden" />
        <button onClick={() => camRef.current?.click()} disabled={busy}
          className="w-full py-8 rounded-3xl bg-sky-500 text-black font-black uppercase tracking-widest active:bg-sky-600 disabled:opacity-50 flex flex-col items-center justify-center gap-2 shadow-[0_0_30px_rgba(14,165,233,0.3)]">
          {busy ? <Loader2 className="w-10 h-10 animate-spin" /> : <Camera className="w-10 h-10" />}
          <span className="text-lg">{busy ? "Guardando…" : "Tomar foto"}</span>
          <span className="text-[10px] font-bold normal-case tracking-normal opacity-70">
            Se guarda sola · toma la siguiente
          </span>
        </button>

        {/* Galería de lo recién guardado — el operador VE que quedó */}
        <div className="rounded-2xl bg-white/5 border border-white/10 p-3">
          <div className="flex items-center gap-2 mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">
            <Images className="w-4 h-4" /> Guardadas recientes
          </div>
          {recent.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-500">Aún no hay fotos. Toca "Tomar foto".</div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {recent.map(ph => (
                <div key={ph.photo_id}
                  className={`relative rounded-xl overflow-hidden border ${ph.photo_id === lastId ? "border-emerald-400 ring-2 ring-emerald-400/40" : "border-white/10"}`}>
                  <img src={IMG(ph.photo_url)} alt="" loading="lazy" className="w-full aspect-square object-cover" />
                  {ph.photo_id === lastId && (
                    <div className="absolute top-1 left-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-emerald-500 text-black text-[8px] font-black uppercase">
                      <CheckCircle2 className="w-3 h-3" /> ok
                    </div>
                  )}
                  <button onClick={() => del(ph.photo_id)}
                    className="absolute bottom-1 right-1 p-1 rounded-lg bg-black/60 active:bg-black/80">
                    <Trash2 className="w-3.5 h-3.5 text-slate-200" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
