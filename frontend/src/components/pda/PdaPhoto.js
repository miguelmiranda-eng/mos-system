import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../App";
import { Toaster, toast } from "sonner";
import {
  Camera, ChevronLeft, Loader2, Trash2, Package, Save, Container,
  ScanBarcode, Sparkles, AlertTriangle, X,
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

// Campos del modal, en el orden en que conviene revisarlos: primero identidad y
// cantidad, luego el material, y al final lo aduanal (que es lo que hace falta
// para sacar el material del país y NO viene en ningún barcode).
// Lo que de verdad hace falta para sacar el material, en el orden en que
// conviene revisarlo. Cliente y fabricante van al final: se leen, pero no son
// lo que el operador viene a confirmar.
const CAMPOS = [
  { k: "style", label: "Estilo" },
  { k: "color", label: "Color" },
  { k: "size", label: "Talla" },
  { k: "description", label: "Tipo de prenda" },
  { k: "country_of_origin", label: "País de origen", aduana: true },
  { k: "fabric_content", label: "Contenido / %", aduana: true },
  { k: "customer", label: "Cliente" },
  { k: "manufacturer", label: "Fabricante" },
];

// Inventario por foto — material que va a exportarse y no está identificado en
// el sistema. Se fotografía la etiqueta, se carga lo que se leyó en un modal
// editable, el operador confirma y queda el renglón. 3 pantallas:
// contenedor → foto → confirmar.
export default function PdaPhoto() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [phase, setPhase] = useState("cont");   // cont | captura
  const [container, setContainer] = useState("");
  const [containers, setContainers] = useState([]);
  const [draft, setDraft] = useState(null);     // datos del modal (null = cerrado)
  const [fuentes, setFuentes] = useState({});
  const [avisos, setAvisos] = useState([]);
  const [lines, setLines] = useState([]);
  const [resumen, setResumen] = useState({ cartones: 0, unidades: 0, sin_aduana: 0 });
  const [busy, setBusy] = useState(false);
  const camRef = useRef(null);
  const contRef = useRef(null);

  useEffect(() => { if (user === null) navigate("/", { replace: true }); }, [user, navigate]);

  const load = useCallback(async (c) => {
    try {
      const d = await fetcher(`/recon/photo/lines?container=${encodeURIComponent(c)}&limit=25`);
      setLines(d.lines || []);
      setResumen(d.resumen || { cartones: 0, unidades: 0, sin_aduana: 0 });
      setContainers(d.containers || []);
    } catch { /* la captura no depende de esto; se refresca al guardar */ }
  }, []);

  useEffect(() => { fetcher("/recon/photo/lines?limit=1").then(d => setContainers(d.containers || [])).catch(() => {}); }, []);
  useEffect(() => { if (phase === "captura") load(container); }, [phase, container, load]);

  // El contenedor es una locación que el supervisor da de alta en Ubicaciones
  // (ej. 53077-01). Se valida contra el WMS: si el piso pudiera teclearla libre,
  // los renglones de un mismo contenedor se repartirían entre variantes del
  // mismo nombre y el manifiesto saldría partido.
  const abrirContainer = useCallback(async (raw) => {
    const v = String(raw || "").trim().toUpperCase();
    if (!v) { toast.error("Escanea o escribe el contenedor"); return; }
    setBusy(true);
    try {
      const d = await fetcher(`/recon/photo/container/${encodeURIComponent(v)}`);
      setContainer(d.container); setPhase("captura"); buzz(50);
    } catch (res) {
      const e = await res?.json?.().catch(() => ({})) || {};
      toast.error(e.detail || "No se pudo validar el contenedor");
      buzz([120, 60, 120]);
    } finally { setBusy(false); }
  }, []);

  const startContainer = (e) => {
    e?.preventDefault();
    abrirContainer(contRef.current?.value);
  };

  // Foto -> lectura. Nunca bloquea: lo que no se leyó viene vacío y el operador
  // lo teclea en el modal.
  const onPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";                        // permite repetir la misma foto
    if (!file) return;
    setBusy(true);
    try {
      const res = await uploader("/recon/label-read", file);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.detail || "No se pudo leer la foto"); buzz([120, 60, 120]); return; }
      setDraft(d.campos || {});
      setFuentes(d.fuentes || {});
      setAvisos(d.avisos || []);
      buzz(50);
    } catch { toast.error("Error de conexión"); buzz([120, 60, 120]); }
    finally { setBusy(false); }
  };

  const setCampo = (k, v) => setDraft(p => ({ ...p, [k]: v }));

  const confirmar = async (e) => {
    e?.preventDefault();
    const carton = (draft.carton || "").trim();
    const units = parseInt(draft.units, 10);
    // El nº de cartón no se exige: viene del código de barras y ése se pierde
    // con facilidad. La cantidad sí, porque es la razón de ser del renglón.
    if (!units || units <= 0) { toast.error("Falta la cantidad"); buzz([120, 60, 120]); return; }
    setBusy(true);
    try {
      const res = await poster("/recon/photo/line", { ...draft, container, carton, units });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.detail || "No se pudo guardar"); buzz([120, 60, 120]); return; }
      if (d.duplicado) {
        toast.warning(`Ese cartón ya está contado (${d.line?.units} u por ${d.line?.capturado_por})`);
        buzz([120, 60, 120]);
      } else {
        toast.success(`${carton} · ${units} u`);
        buzz(60);
      }
      setDraft(null); setFuentes({}); setAvisos([]); load(container);
    } catch { toast.error("Error de conexión"); buzz([120, 60, 120]); }
    finally { setBusy(false); }
  };

  const delLine = async (line_id) => {
    try {
      const res = await fetch(`${API}/recon/photo/line/${line_id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.detail || "No se pudo borrar"); return; }
      toast.success("Renglón borrado"); load(container);
    } catch { toast.error("Error de conexión"); }
  };

  const Fuente = ({ campo }) => {
    const f = fuentes[campo];
    if (f === "barcode") return <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase text-emerald-400"><ScanBarcode className="w-3 h-3" /> código</span>;
    if (f === "ocr") return <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase text-sky-400"><Sparkles className="w-3 h-3" /> leído</span>;
    return <span className="text-[9px] font-black uppercase text-amber-400">a mano</span>;
  };

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-slate-100 select-none" style={{ WebkitTapHighlightColor: "transparent" }}>
      <Toaster position="top-center" theme="dark" richColors />
      <header className="sticky top-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => phase === "cont" ? navigate("/wms") : setPhase("cont")}
          className="p-2 -ml-1 rounded-xl active:bg-white/10">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div className="w-9 h-9 rounded-xl bg-sky-500/20 border border-sky-400/30 flex items-center justify-center">
          <Camera className="w-5 h-5 text-sky-300" />
        </div>
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Inventario por foto</div>
          <div className="text-sm font-black truncate">{phase === "captura" ? container : (user?.name || "Contador")}</div>
        </div>
        {phase === "captura" && (
          <div className="text-right leading-tight shrink-0">
            <div className="text-lg font-black text-sky-300">{resumen.cartones}</div>
            <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">cartones</div>
          </div>
        )}
      </header>

      <main className="p-4 max-w-md mx-auto">
        {/* ── PANTALLA 1: contenedor ── */}
        {phase === "cont" && (
          <form onSubmit={startContainer} className="space-y-5 pt-8">
            <div className="text-center">
              <Container className="w-14 h-14 mx-auto text-sky-400 mb-3" />
              <h2 className="text-xl font-black uppercase tracking-wide">Escanea el contenedor</h2>
              <p className="text-sm text-slate-400 mt-1">La locación que dio de alta el supervisor</p>
            </div>
            <input ref={contRef} autoFocus inputMode="text" list="pi-conts"
              placeholder="Ej. 53077-01"
              className="w-full px-4 py-4 bg-white/5 border-2 border-sky-500/40 rounded-2xl text-center text-lg font-mono uppercase focus:border-sky-400 outline-none" />
            <datalist id="pi-conts">{containers.map(c => <option key={c} value={c} />)}</datalist>
            {containers.length > 0 && (
              <div className="flex flex-wrap gap-2 justify-center">
                {containers.map(c => (
                  <button key={c} type="button" onClick={() => abrirContainer(c)}
                    className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs font-mono font-bold active:bg-white/15">
                    {c}
                  </button>
                ))}
              </div>
            )}
            <button type="submit" disabled={busy}
              className="w-full py-4 rounded-2xl bg-sky-500 text-black text-lg font-black uppercase tracking-widest active:bg-sky-600 disabled:opacity-50 flex items-center justify-center gap-2">
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Camera className="w-5 h-5" />} Empezar
            </button>
          </form>
        )}

        {/* ── PANTALLA 2: foto + lo capturado ── */}
        {phase === "captura" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {[["Cartones", resumen.cartones, "text-sky-400"],
                ["Unidades", resumen.unidades, "text-emerald-400"],
                ["Sin aduana", resumen.sin_aduana, resumen.sin_aduana ? "text-amber-400" : "text-slate-500"]].map(([lbl, val, cls]) => (
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
              <span className="text-lg">{busy ? "Leyendo etiqueta…" : "Tomar foto"}</span>
              <span className="text-[10px] font-bold normal-case tracking-normal opacity-70">
                Encuadra la etiqueta completa
              </span>
            </button>

            <div className="rounded-2xl bg-white/5 border border-white/10 divide-y divide-white/5 max-h-[38vh] overflow-y-auto">
              {lines.length === 0 && <div className="p-4 text-center text-sm text-slate-500">Aún no hay cartones en {container}</div>}
              {lines.map(l => (
                <div key={l.line_id} className="flex items-center gap-3 px-3 py-2.5">
                  <Package className={`w-5 h-5 shrink-0 ${l.completo ? "text-sky-400" : "text-amber-400"}`} />
                  <span className="flex-1 min-w-0">
                    <span className="block font-mono text-sm truncate">{l.carton}</span>
                    <span className="block text-[10px] text-slate-500 truncate">
                      {[l.style, l.color, l.size].filter(Boolean).join(" · ") || `SKU ${l.sku || "—"}`}
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
      </main>

      {/* ── MODAL: revisar y confirmar lo leído ── */}
      {draft && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center">
          <form onSubmit={confirmar}
            className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-[#0b0f1a] border-t sm:border border-white/15 sm:rounded-3xl rounded-t-3xl p-4 space-y-3">
            <div className="flex items-center gap-2 sticky top-0 bg-[#0b0f1a] pb-2 -mt-1 pt-1">
              <div className="flex-1 text-sm font-black uppercase tracking-widest text-slate-400">Revisa y confirma</div>
              <button type="button" onClick={() => { setDraft(null); setAvisos([]); }}
                className="p-2 -mr-1 rounded-xl active:bg-white/10"><X className="w-5 h-5" /></button>
            </div>

            {avisos.map((a, i) => (
              <div key={i} className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-3 flex items-start gap-2 text-xs text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {a}
              </div>
            ))}

            {/* La cantidad primero: es el dato por el que existe el renglón. */}
            <div>
              <label className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">
                Cantidad (unidades) <Fuente campo="units" />
              </label>
              <input type="number" inputMode="numeric" min="1" value={draft.units || ""}
                onChange={e => setCampo("units", e.target.value)}
                className="w-full px-4 py-4 bg-white/5 border-2 border-emerald-500/40 rounded-2xl text-center text-3xl font-black focus:border-emerald-400 outline-none" />
            </div>

            {CAMPOS.map(c => (
              <div key={c.k}>
                <label className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">
                  <span>{c.label}{c.aduana && <span className="text-amber-400"> · salida</span>}</span>
                  <Fuente campo={c.k} />
                </label>
                <input value={draft[c.k] || ""} onChange={e => setCampo(c.k, e.target.value)}
                  className={`w-full px-3 py-2.5 bg-white/5 border-2 rounded-2xl text-sm focus:border-sky-400 outline-none ${
                    c.aduana && !draft[c.k] ? "border-amber-500/40" : "border-white/15"}`} />
              </div>
            ))}

            {/* Códigos de barras: opcionales. Cuando se leen, el nº de cartón
                evita contar dos veces la misma caja; si no, no estorban. */}
            <details className="rounded-2xl bg-white/5 border border-white/10 px-3 py-2">
              <summary className="text-[10px] font-black uppercase tracking-widest text-slate-400 cursor-pointer">
                Códigos de barras (opcional)
                {draft.carton ? <span className="ml-2 text-emerald-400 normal-case">{draft.carton}</span> : null}
              </summary>
              <div className="grid grid-cols-2 gap-3 mt-2">
                <div>
                  <label className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">
                    Nº cartón <Fuente campo="carton" />
                  </label>
                  <input value={draft.carton || ""} onChange={e => setCampo("carton", e.target.value.toUpperCase())}
                    className="w-full px-3 py-2.5 bg-white/5 border-2 border-white/15 rounded-2xl text-center font-mono text-sm focus:border-sky-400 outline-none" />
                </div>
                <div>
                  <label className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">
                    SKU <Fuente campo="sku" />
                  </label>
                  <input value={draft.sku || ""} onChange={e => setCampo("sku", e.target.value)}
                    className="w-full px-3 py-2.5 bg-white/5 border-2 border-white/15 rounded-2xl text-center font-mono text-sm focus:border-sky-400 outline-none" />
                </div>
              </div>
            </details>

            <div className="sticky bottom-0 bg-[#0b0f1a] pt-2 space-y-2">
              <button type="submit" disabled={busy}
                className="w-full py-4 rounded-2xl bg-emerald-500 text-black text-lg font-black uppercase tracking-widest active:bg-emerald-600 disabled:opacity-50 flex items-center justify-center gap-2">
                {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <Save className="w-6 h-6" />} Guardar cartón
              </button>
              <button type="button" onClick={() => { setDraft(null); setAvisos([]); camRef.current?.click(); }}
                className="w-full py-3 rounded-2xl bg-white/10 text-white font-black uppercase tracking-widest text-sm active:bg-white/20">
                Repetir foto
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
