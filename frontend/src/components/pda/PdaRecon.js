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
  const [scanned, setScanned] = useState([]); // [{ id, known }]
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { if (user === null) navigate("/", { replace: true }); }, [user, navigate]);
  useEffect(() => { inputRef.current?.focus(); }, [phase]);

  const reset = () => { setPhase("loc"); setLoc(null); setScanned([]); setResult(null); };

  const submitLoc = async (e) => {
    e?.preventDefault();
    const v = (inputRef.current?.value || "").trim().toUpperCase();
    if (!v) return;
    setBusy(true);
    try {
      const data = await fetcher(`/recon/location/${encodeURIComponent(v)}`);
      if (data.blocked_lpn) {
        setLoc(data); setPhase("lpn"); buzz([120, 60, 120]);
      } else if (data.locked) {
        setLoc(data); setPhase("locked"); buzz([120, 60, 120]);
      } else {
        setLoc(data); setScanned([]); setPhase("scan"); buzz(50);
      }
    } catch { toast.error("No se pudo leer la ubicación"); buzz([120, 60, 120]); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };

  const expectedIds = new Set((loc?.expected || []).map(b => b.box_id));

  const addBox = useCallback((raw) => {
    const id = String(raw || "").trim().toUpperCase();
    if (!id) return;
    if (!id.startsWith("BOX")) { toast.error("Código inválido — solo cajas BOX"); buzz([120, 60, 120]); return; }
    setScanned(prev => {
      if (prev.some(b => b.id === id)) { toast.info("Ya escaneada"); return prev; }
      buzz(40);
      return [{ id, known: expectedIds.has(id) }, ...prev];
    });
  }, [expectedIds]);

  const submitScan = (e) => {
    e?.preventDefault();
    const v = inputRef.current?.value || "";
    addBox(v);
    if (inputRef.current) inputRef.current.value = "";
    inputRef.current?.focus();
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

        {/* ── PANTALLA bloqueada por LPN físico ── */}
        {phase === "lpn" && (
          <div className="space-y-5 pt-10 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-red-500/20 border-2 border-red-500/50 flex items-center justify-center">
              <AlertTriangle className="w-9 h-9 text-red-400" />
            </div>
            <h2 className="text-xl font-black uppercase">{loc.location}</h2>
            <p className="text-base text-red-300 font-bold">No se puede conciliar aquí</p>
            <p className="text-sm text-slate-300">
              Esta ubicación tiene {loc.lpn_boxes?.length || 0} caja(s) con <b>LPN físico</b> (licencia real, sin
              prefijo BOX). Este proceso solo maneja cajas BOX.
            </p>
            {loc.lpn_boxes?.length > 0 && (
              <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-left">
                {loc.lpn_boxes.slice(0, 6).map((b, i) => (
                  <div key={i} className="font-mono text-xs py-0.5 text-amber-300">{b.lpn || b.box_id}</div>
                ))}
              </div>
            )}
            <p className="text-xs text-slate-400">Repórtala al administrador.</p>
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
              <input ref={inputRef} autoFocus inputMode="text" placeholder="Escanea una caja BOX-…"
                className="w-full px-4 py-4 bg-white/5 border-2 border-emerald-500/40 rounded-2xl text-center text-lg font-mono uppercase focus:border-emerald-400 outline-none" />
            </form>

            <div className="rounded-2xl bg-white/5 border border-white/10 divide-y divide-white/5 max-h-[40vh] overflow-y-auto">
              {scanned.length === 0 && <div className="p-4 text-center text-sm text-slate-500">Escanea las cajas que estén físicamente aquí</div>}
              {scanned.map(b => (
                <div key={b.id} className="flex items-center gap-3 px-3 py-2.5">
                  {b.known
                    ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                    : <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
                  <span className="font-mono text-sm flex-1">{b.id}</span>
                  <span className="text-[10px] uppercase font-black text-slate-500">{b.known ? "esperada" : "nueva/otra"}</span>
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
    </div>
  );
}
