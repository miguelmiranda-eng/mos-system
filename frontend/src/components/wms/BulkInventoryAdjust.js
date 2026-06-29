import { useState, useRef } from "react";
import { toast } from "sonner";
import { Upload, Loader2, CheckCircle2, AlertTriangle, FileDown, RotateCcw, Boxes } from "lucide-react";
import { poster } from "./lib";

// Maps the 'Formato ajuste de inventario' headers (any casing/spacing) to the
// fields the backend expects. "On Hand" is read as a DELTA: positive adds,
// negative subtracts.
const HEADER_MAP = {
  customer: "customer",
  style: "style",
  color: "color",
  size: "size",
  location: "location",
  "on hand": "on_hand", onhand: "on_hand", on_hand: "on_hand", ajuste: "on_hand",
  "country of origin": "country_of_origin", country_of_origin: "country_of_origin", coo: "country_of_origin",
  "fabric content": "fabric_content", fabric_content: "fabric_content",
};

function normalizeRow(raw) {
  const out = {};
  for (const k of Object.keys(raw)) {
    const key = HEADER_MAP[String(k).trim().toLowerCase()];
    if (key && out[key] === undefined) out[key] = raw[k];
  }
  return out;
}

const STATUS_META = {
  adjust: { label: "Ajuste", cls: "bg-blue-500/10 text-blue-500 border-blue-500/30" },
  new: { label: "Nueva", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30" },
  error: { label: "Error", cls: "bg-red-500/10 text-red-500 border-red-500/30" },
  skip: { label: "Sin cambio", cls: "bg-muted text-muted-foreground border-border" },
};

export default function BulkInventoryAdjust() {
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { summary, rows }
  const [reason, setReason] = useState("");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const reset = () => {
    setRows([]); setFileName(""); setPreview(null); setReason(""); setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const runPreview = async (rws) => {
    try {
      const res = await poster("/inventory/bulk-adjust", { rows: rws, dry_run: true });
      if (res.ok) setPreview(await res.json());
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || "No se pudo previsualizar"); }
    } catch { toast.error("Error de conexión"); }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setPreview(null); setResult(null);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
      const norm = json.map(normalizeRow).filter(r => r.style || r.location || (r.on_hand !== "" && r.on_hand !== undefined));
      if (!norm.length) { toast.error("El archivo no tiene filas válidas (revisa los encabezados)"); return; }
      setRows(norm); setFileName(file.name);
      await runPreview(norm);
    } catch {
      toast.error("No se pudo leer el archivo Excel");
    } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!reason.trim()) { toast.error("El motivo del ajuste es obligatorio"); return; }
    const changes = (preview?.summary?.adjust || 0) + (preview?.summary?.new || 0);
    if (!changes) { toast.error("No hay cambios aplicables"); return; }
    if (!window.confirm(`¿Aplicar ${changes} cambio(s) de inventario? Esta acción no se puede deshacer en bloque.`)) return;
    setApplying(true);
    try {
      const res = await poster("/inventory/bulk-adjust", { rows, dry_run: false, reason: reason.trim() });
      if (res.ok) {
        const data = await res.json();
        setResult(data);
        setPreview(data); // refresh statuses after applying
        toast.success(`Ajuste aplicado: ${data.summary.applied} línea(s)`);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "No se pudo aplicar el ajuste");
      }
    } catch { toast.error("Error de conexión"); }
    finally { setApplying(false); }
  };

  const downloadTemplate = async () => {
    try {
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.aoa_to_sheet([[
        "Customer", "Style", "Color", "Size", "Location", "On Hand", "Country of Origin", "Fabric Content",
      ]]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Ajuste");
      XLSX.writeFile(wb, "Formato ajuste de inventario.xlsx");
    } catch { toast.error("No se pudo generar la plantilla"); }
  };

  const s = preview?.summary;
  const canApply = !applying && !result && s && (s.adjust + s.new) > 0;

  return (
    <div className="space-y-5">
      {/* Instructions */}
      <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
        <div className="text-sm font-black uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <Boxes className="w-5 h-5 text-primary" /> Ajuste masivo de inventario
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Sube el Excel <b>Formato ajuste de inventario</b>. La columna <b>On Hand</b> es el
          <b> ajuste</b>: un número positivo <b>suma</b> y uno negativo <b>resta</b> sobre la
          existencia actual. Verás una vista previa antes de aplicar. Las líneas que no existan se
          marcan como <b>Nueva</b> y se crean al confirmar.
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={downloadTemplate}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-secondary/40 hover:bg-secondary text-xs font-bold">
            <FileDown className="w-4 h-4" /> Descargar plantilla
          </button>
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-bold cursor-pointer active:scale-95 transition-transform">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {fileName ? "Cambiar archivo" : "Subir Excel"}
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} disabled={busy} />
          </label>
          {fileName && (
            <button onClick={reset} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border text-xs font-bold text-muted-foreground hover:bg-secondary">
              <RotateCcw className="w-4 h-4" /> Limpiar
            </button>
          )}
        </div>
        {fileName && <p className="text-[11px] font-mono text-muted-foreground">📄 {fileName} · {rows.length} fila(s)</p>}
      </div>

      {/* Summary */}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <SummaryPill label="Ajustes" value={s.adjust} cls="text-blue-500" />
          <SummaryPill label="Nuevas" value={s.new} cls="text-emerald-500" />
          <SummaryPill label="Errores" value={s.error} cls="text-red-500" />
          <SummaryPill label="Sin cambio" value={s.skip} cls="text-muted-foreground" />
        </div>
      )}

      {/* Preview table */}
      {preview?.rows?.length > 0 && (
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="max-h-[42vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-secondary/60 backdrop-blur">
                <tr className="text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  <th className="p-2.5">#</th>
                  <th className="p-2.5">Línea</th>
                  <th className="p-2.5 text-right">Actual</th>
                  <th className="p-2.5 text-right">Ajuste</th>
                  <th className="p-2.5 text-right">Nuevo</th>
                  <th className="p-2.5">Estado</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => {
                  const m = STATUS_META[r.status] || STATUS_META.skip;
                  return (
                    <tr key={i} className="border-t border-border/40">
                      <td className="p-2.5 text-muted-foreground font-mono">{r.row}</td>
                      <td className="p-2.5 font-mono">{r.label}</td>
                      <td className="p-2.5 text-right font-mono">{r.current ?? "—"}</td>
                      <td className={`p-2.5 text-right font-mono font-bold ${r.delta > 0 ? "text-emerald-500" : r.delta < 0 ? "text-red-500" : ""}`}>
                        {r.delta > 0 ? `+${r.delta}` : (r.delta ?? "—")}
                      </td>
                      <td className="p-2.5 text-right font-mono font-bold">{r.new ?? "—"}</td>
                      <td className="p-2.5">
                        <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-black uppercase ${m.cls}`}>{m.label}</span>
                        {r.message && <span className="block text-[10px] text-muted-foreground mt-0.5">{r.message}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Apply */}
      {s && (s.adjust + s.new) > 0 && !result && (
        <div className="bg-card border border-primary/30 rounded-2xl p-5 space-y-3">
          <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground block">Motivo del ajuste *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
            placeholder="Ej. Conteo cíclico SAT — corrección física vs sistema"
            className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary resize-none" />
          <button onClick={apply} disabled={!canApply}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-black text-sm disabled:opacity-50 active:scale-[0.99] transition-transform">
            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Aplicar {s.adjust + s.new} cambio(s)
          </button>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-5 flex items-start gap-3">
          <CheckCircle2 className="w-6 h-6 text-emerald-500 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-black text-emerald-500">Ajuste aplicado</p>
            <p className="text-muted-foreground mt-1">
              {result.summary.applied} línea(s) aplicadas · {result.summary.error} con error · {result.summary.skip} sin cambio.
            </p>
            <button onClick={reset} className="mt-3 flex items-center gap-2 px-3 py-2 rounded-xl border border-border text-xs font-bold hover:bg-secondary">
              <RotateCcw className="w-4 h-4" /> Hacer otro ajuste
            </button>
          </div>
        </div>
      )}

      {!preview && !busy && (
        <div className="text-center py-10 text-muted-foreground">
          <AlertTriangle className="w-10 h-10 mx-auto opacity-30 mb-2" />
          <p className="text-sm font-bold">Sube un archivo para ver la vista previa</p>
        </div>
      )}
    </div>
  );
}

function SummaryPill({ label, value, cls }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3 text-center">
      <div className={`text-2xl font-black ${cls}`}>{value ?? 0}</div>
      <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{label}</div>
    </div>
  );
}
