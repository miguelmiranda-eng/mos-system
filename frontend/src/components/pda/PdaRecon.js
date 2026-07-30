import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../App";
import { Toaster, toast } from "sonner";
import {
  ClipboardCheck, ChevronLeft, MapPin, ScanLine, CheckCircle2, Lock,
  Loader2, Trash2, PackageCheck, AlertTriangle, RotateCcw,
} from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
const fetcher = (u) => fetch(`${API}${u}`, { credentials: "include" }).then(r => (r.ok ? r.json() : Promise.reject(r)));
const poster = (u, b) => fetch(`${API}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(b) });

const buzz = (p) => { if (navigator.vibrate) navigator.vibrate(p); };

// Conciliación física PDA — UI mínima para personal inexperto: escanea la
// ubicación, luego cada caja presente, y un botón grande para casar el sistema
// con la realidad. 3 pantallas: ubicación → cajas → resumen.
export default function PdaRecon() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [phase, setPhase] = useState("loc"); // loc | scan | done | locked
  const [loc, setLoc] = useState(null);       // { location, expected, expected_count }
  const [scanned, setScanned] = useState([]); // [{ id, known, lpn? }]
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(null);     // { code, candidates } — selector de LPN sin casar
  const inputRef = useRef(null);

  useEffect(() => { if (user === null) navigate("/", { replace: true }); }, [user, navigate]);
  useEffect(() => { inputRef.current?.focus(); }, [phase]);

  const reset = () => { setPhase("loc"); setLoc(null); setScanned([]); setResult(null); setPick(null); };

  const submitLoc = async (e) => {
    e?.preventDefault();
    const v = (inputRef.current?.value || "").trim().toUpperCase();
    if (!v) return;
    setBusy(true);
    try {
      const data = await fetcher(`/recon/location/${encodeURIComponent(v)}`);
      if (data.locked) {
        setLoc(data); setPhase("locked"); buzz([120, 60, 120]);
      } else {
        setLoc(data); setScanned([]); setPhase("scan"); buzz(50);
      }
    } catch { toast.error("No se pudo leer la ubicación"); buzz([120, 60, 120]); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };

  const expectedIds = new Set((loc?.expected || []).map(b => b.box_id));

  // Agrega un objeto de caja a la lista, deduplicando por box_id.
  const addScanned = useCallback((item) => {
    setScanned(prev => {
      if (prev.some(b => b.id === item.id)) { toast.info("Ya escaneada"); return prev; }
      buzz(40);
      return [item, ...prev];
    });
  }, []);

  const addBox = useCallback((raw) => {
    const id = String(raw || "").trim().toUpperCase();
    if (!id) return;
    addScanned({ id, known: expectedIds.has(id) });
  }, [expectedIds, addScanned]);

  // Resuelve un LPN físico (código sin prefijo BOX) contra el backend.
  const resolveLpn = async (code) => {
    setBusy(true);
    try {
      const res = await poster("/recon/resolve-scan", { location: loc.location, code });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.detail || "No se pudo resolver el código"); buzz([120, 60, 120]); return; }
      if (data.matched) {
        const box = data.box || {};
        if (scanned.some(b => b.id === data.box_id)) { toast.info("Ya escaneada"); return; }
        const label = `${box.style || box.sku || ""} ${box.color || ""} ${box.size || ""}`.trim() || data.box_id;
        addScanned({ id: data.box_id, known: data.here, lpn: code });
        if (data.here === false) { toast.warning(`Movida aquí: ${label}`); }
        else { toast.success(label); }
      } else {
        setPick({ code, candidates: data.candidates || [] });
      }
    } catch { toast.error("Error de conexión"); buzz([120, 60, 120]); }
    finally { setBusy(false); }
  };

  const submitScan = async (e) => {
    e?.preventDefault();
    const raw = (inputRef.current?.value || "").trim();
    if (inputRef.current) inputRef.current.value = "";
    inputRef.current?.focus();
    if (!raw) return;
    if (busy) return; // evita doble disparo del scanner mientras se resuelve
    const code = raw.toUpperCase();
    if (code.startsWith("BOX")) { addBox(code); return; }
    await resolveLpn(code);
  };

  // Casa un LPN físico sin enlazar contra una de las cajas candidatas.
  const bindLpn = async (candidate) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await poster("/recon/bind-lpn", { location: loc.location, lpn: pick.code, box_id: candidate.box_id });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.detail || "No se pudo enlazar"); buzz([120, 60, 120]); return; }
      if (data.status === "ok") {
        addScanned({ id: candidate.box_id, known: true, lpn: pick.code });
        setPick(null); toast.success("Caja enlazada"); buzz([60, 40, 120]);
      } else if (data.status === "already_bound") {
        const bid = data.box_id || candidate.box_id;
        addScanned({ id: bid, known: true, lpn: pick.code });
        setPick(null); toast.info(data.message || "Ya estaba enlazada");
      } else {
        toast.error("Respuesta inesperada"); buzz([120, 60, 120]);
      }
    } catch { toast.error("Error de conexión"); buzz([120, 60, 120]); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const res = await poster("/recon/commit", { location: loc.location, scanned_box_ids: scanned.map(b => b.id) });
      if (res.ok) { setResult(await res.json()); setPhase("done"); buzz([60, 40, 120]); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || "No se pudo conciliar"); buzz([120, 60, 120]); }
    } catch { toast.error("Error de conexión"); buzz([120, 60, 120]); }
    finally { setBusy(false); }
  };

  const scannedCount = scanned.length;
  const missingCount = Math.max(0, (loc?.expected_count || 0) - scanned.filter(b => b.known).length);

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-slate-100 select-none" style={{ WebkitTapHighlightColor: "transparent" }}>
      <Toaster position="top-center" theme="dark" richColors />
      <header className="sticky top-0 z-30 bg-[#0b0f1a]/95 backdrop-blur border-b border-white/10 px-3 py-3 flex items-center gap-2">
        <button onClick={() => phase === "loc" ? navigate("/pda") : reset()} className="p-2 -ml-1 rounded-xl active:bg-white/10">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center">
          <ClipboardCheck className="w-5 h-5 text-emerald-300" />
        </div>
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Conciliación</div>
          <div className="text-sm font-black truncate">{user?.name || "Contador"}</div>
        </div>
      </header>

      <main className="p-4 max-w-md mx-auto">
        {/* ── PANTALLA 1: escanear ubicación ── */}
        {phase === "loc" && (
          <form onSubmit={submitLoc} className="space-y-5 pt-8">
            <div className="text-center">
              <MapPin className="w-14 h-14 mx-auto text-emerald-400 mb-3" />
              <h2 className="text-xl font-black uppercase tracking-wide">Escanea la ubicación</h2>
              <p className="text-sm text-slate-400 mt-1">Empieza escaneando la etiqueta del lugar</p>
            </div>
            <input ref={inputRef} autoFocus inputMode="text"
              placeholder="Ubicación (ej. CARRO 8 / RP05-A22)"
              className="w-full px-4 py-4 bg-white/5 border-2 border-emerald-500/40 rounded-2xl text-center text-lg font-mono uppercase focus:border-emerald-400 outline-none" />
            <button type="submit" disabled={busy}
              className="w-full py-4 rounded-2xl bg-emerald-500 text-black text-lg font-black uppercase tracking-widest active:bg-emerald-600 disabled:opacity-50 flex items-center justify-center gap-2">
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <ScanLine className="w-5 h-5" />} Continuar
            </button>
          </form>
        )}

        {/* ── PANTALLA bloqueada ── */}
        {phase === "locked" && (
          <div className="space-y-5 pt-10 text-center">
            <Lock className="w-16 h-16 mx-auto text-amber-400" />
            <h2 className="text-xl font-black uppercase">{loc.location}</h2>
            <p className="text-base text-amber-300 font-bold">Ya fue conciliada</p>
            <p className="text-sm text-slate-400">
              Por {loc.lock?.reconciled_by_name || "?"}. Pide al administrador que la reabra si necesitas repetirla.
            </p>
            <button onClick={reset} className="w-full py-4 rounded-2xl bg-white/10 text-white font-black uppercase tracking-widest active:bg-white/20">
              Otra ubicación
            </button>
          </div>
        )}

        {/* ── PANTALLA 2: escanear cajas ── */}
        {phase === "scan" && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-white/5 border border-white/10 p-4 text-center">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Ubicación</div>
              <div className="text-2xl font-black">{loc.location}</div>
              <div className="text-xs text-slate-400 mt-1">Sistema espera {loc.expected_count} caja(s)</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-center">
                <div className="text-3xl font-black text-emerald-400">{scannedCount}</div>
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Escaneadas</div>
              </div>
              <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-3 text-center">
                <div className="text-3xl font-black text-amber-400">{missingCount}</div>
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Faltan</div>
              </div>
            </div>

            <form onSubmit={submitScan}>
              <input ref={inputRef} autoFocus inputMode="text" placeholder="Escanea una caja (BOX-… o LPN)"
                className="w-full px-4 py-4 bg-white/5 border-2 border-emerald-500/40 rounded-2xl text-center text-lg font-mono uppercase focus:border-emerald-400 outline-none" />
              {busy && (
                <div className="mt-2 flex items-center justify-center gap-2 text-xs text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin" /> Resolviendo…
                </div>
              )}
            </form>

            <div className="rounded-2xl bg-white/5 border border-white/10 divide-y divide-white/5 max-h-[40vh] overflow-y-auto">
              {scanned.length === 0 && <div className="p-4 text-center text-sm text-slate-500">Escanea las cajas que estén físicamente aquí</div>}
              {scanned.map(b => (
                <div key={b.id} className="flex items-center gap-3 px-3 py-2.5">
                  {b.known
                    ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                    : <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
                  <span className="font-mono text-sm flex-1 min-w-0 truncate">
                    {b.id}
                    {b.lpn && <span className="block text-[10px] text-sky-300/80 truncate">LPN {b.lpn}</span>}
                  </span>
                  <span className="text-[10px] uppercase font-black text-slate-500 shrink-0">{b.known ? "esperada" : "nueva/otra"}</span>
                  <button onClick={() => setScanned(prev => prev.filter(x => x.id !== b.id))} className="p-1.5 rounded-lg active:bg-white/10">
                    <Trash2 className="w-4 h-4 text-slate-500" />
                  </button>
                </div>
              ))}
            </div>

            <button onClick={commit} disabled={busy}
              className="w-full py-5 rounded-2xl bg-emerald-500 text-black text-lg font-black uppercase tracking-widest active:bg-emerald-600 disabled:opacity-50 flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(16,185,129,0.3)]">
              {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <PackageCheck className="w-6 h-6" />}
              Finalizar y conciliar
            </button>
          </div>
        )}

        {/* ── PANTALLA 3: resumen ── */}
        {phase === "done" && result && (
          <div className="space-y-5 pt-6 text-center">
            <CheckCircle2 className="w-16 h-16 mx-auto text-emerald-400" />
            <h2 className="text-xl font-black uppercase">{result.location} conciliada</h2>
            <div className="grid grid-cols-2 gap-3 text-left">
              {[["Confirmadas", result.confirmadas, "text-emerald-400"],
                ["Movidas aquí", result.movidas, "text-sky-400"],
                ["Creadas", result.creadas, "text-amber-400"],
                ["Faltantes", result.faltantes, "text-red-400"]].map(([lbl, val, cls]) => (
                <div key={lbl} className="rounded-2xl bg-white/5 border border-white/10 p-3">
                  <div className={`text-2xl font-black ${cls}`}>{val}</div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">{lbl}</div>
                </div>
              ))}
            </div>
            {result.faltantes > 0 && (
              <p className="text-xs text-slate-400">Las faltantes quedaron en la lista del administrador; aparecerán aquí si las escaneas en otra ubicación.</p>
            )}
            <button onClick={reset}
              className="w-full py-4 rounded-2xl bg-emerald-500 text-black font-black uppercase tracking-widest active:bg-emerald-600 flex items-center justify-center gap-2">
              <RotateCcw className="w-5 h-5" /> Conciliar otra ubicación
            </button>
          </div>
        )}
      </main>

      {/* ── HOJA: casar LPN físico con una caja del sistema ── */}
      {pick && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={() => !busy && setPick(null)}>
          <div className="w-full max-w-md bg-[#0b0f1a] border-t border-white/10 rounded-t-2xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">LPN sin casar</div>
              <div className="text-lg font-black font-mono truncate">{pick.code}</div>
            </div>

            {pick.candidates.length === 0 ? (
              <>
                <p className="text-sm text-slate-300 text-center py-2">
                  No hay cajas candidatas en esta ubicación — repórtalo al administrador.
                </p>
                <button onClick={() => setPick(null)}
                  className="w-full py-4 rounded-2xl bg-white/10 text-white font-black uppercase tracking-widest active:bg-white/20">
                  Cerrar
                </button>
              </>
            ) : (
              <PickCandidates key={pick.code} candidates={pick.candidates} busy={busy}
                onBind={bindLpn} onCancel={() => setPick(null)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Selector de la caja del sistema a la que casar un LPN físico. Los candidatos
// (cajas fantasma LPN sin etiqueta atada de esta ubicación) pueden ser cientos
// en un CARRO, así que sobre >6 se ofrece una cascada Color → Estilo → Talla:
// cada desplegable sólo muestra los valores AÚN alcanzables dados los otros
// filtros. Se remonta por `key={pick.code}` en cada LPN nuevo, así los filtros
// arrancan limpios sin necesitar un efecto de reset.
function PickCandidates({ candidates, busy, onBind, onCancel }) {
  const [f, setF] = useState({ color: "", style: "", size: "" });
  const norm = (v) => String(v ?? "").trim();
  const styleOf = (c) => norm(c.style || c.sku);
  // `skip` excluye su propio eje para que un desplegable no se auto-recorte.
  const match = (c, skip) =>
    (skip === "color" || !f.color || norm(c.color) === f.color) &&
    (skip === "style" || !f.style || styleOf(c) === f.style) &&
    (skip === "size" || !f.size || norm(c.size) === f.size);
  const optsFor = (skip, get) => {
    const s = new Set();
    for (const c of candidates) if (match(c, skip)) { const v = norm(get(c)); if (v) s.add(v); }
    return [...s].sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
  };
  const colors = optsFor("color", (c) => c.color);
  const styles = optsFor("style", styleOf);
  const sizes = optsFor("size", (c) => c.size);
  const filtered = candidates.filter((c) => match(c, null));
  const anyFilter = f.color || f.style || f.size;
  const showFilters = candidates.length > 6;
  const selCls = (on) =>
    `min-w-0 px-2 py-2 rounded-xl bg-white/5 border text-xs font-mono uppercase outline-none ${on ? "border-emerald-400/60 text-emerald-200" : "border-white/10 text-slate-300"}`;

  return (
    <>
      <p className="text-xs text-slate-400 text-center">
        {showFilters
          ? <>Filtra y toca la caja · <span className="text-slate-200 font-black">{filtered.length}</span> de {candidates.length}</>
          : <>¿A qué caja corresponde? Tócala para casarla.</>}
      </p>

      {showFilters && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <select value={f.color} onChange={(e) => setF((s) => ({ ...s, color: e.target.value }))} className={selCls(!!f.color)}>
              <option value="">Color</option>
              {colors.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select value={f.style} onChange={(e) => setF((s) => ({ ...s, style: e.target.value }))} className={selCls(!!f.style)}>
              <option value="">Estilo</option>
              {styles.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select value={f.size} onChange={(e) => setF((s) => ({ ...s, size: e.target.value }))} className={selCls(!!f.size)}>
              <option value="">Talla</option>
              {sizes.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          {anyFilter && (
            <button onClick={() => setF({ color: "", style: "", size: "" })}
              className="w-full text-[11px] text-slate-400 active:text-slate-200 uppercase tracking-widest font-black">
              Limpiar filtros
            </button>
          )}
        </>
      )}

      <div className="rounded-2xl bg-white/5 border border-white/10 divide-y divide-white/5 max-h-[45vh] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-sm text-slate-500">Ninguna caja con esos filtros.</div>
        ) : filtered.map((c) => (
          <button key={c.box_id} onClick={() => onBind(c)} disabled={busy}
            className="w-full flex items-center gap-3 px-3 py-3 text-left active:bg-white/10 disabled:opacity-50">
            <PackageCheck className="w-5 h-5 text-emerald-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm truncate">{c.box_id}</div>
              <div className="text-xs text-slate-400 truncate">
                {`${c.sku || c.style || ""} ${c.color || ""} ${c.size || ""}`.trim()}
              </div>
            </div>
            <span className="text-xs font-black text-emerald-300 shrink-0">{c.units}u</span>
          </button>
        ))}
      </div>
      <button onClick={onCancel} disabled={busy}
        className="w-full py-4 rounded-2xl bg-white/10 text-white font-black uppercase tracking-widest active:bg-white/20 disabled:opacity-50">
        Cancelar
      </button>
    </>
  );
}
