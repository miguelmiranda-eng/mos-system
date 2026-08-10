import { useState, useRef } from "react";
import { toast } from "sonner";
import { Upload, Loader2, CheckCircle2, FileDown, RotateCcw, Boxes } from "lucide-react";
import { poster } from "./lib";
import { SoftAlert, Btn, cls } from "./ui";

// Maps the 'Formato ajuste de inventario' headers (any casing/spacing) to the
// fields the backend expects. The canonical format is Customer, Style, Color,
// Size, Location, "Qty to Adjust" — a DELTA: positive adds, negative subtracts.
// The old "On Hand" / COO / Fabric headers stay as aliases so files generated
// with the previous template keep importing; the wire field is still `on_hand`
// because that's what /inventory/bulk-adjust reads.
const HEADER_MAP = {
  customer: "customer",
  style: "style",
  color: "color",
  size: "size",
  location: "location",
  "qty to adjust": "on_hand", qty_to_adjust: "on_hand", qtytoadjust: "on_hand", qty: "on_hand",
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
  adjust: { label: "Ajuste", cls: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25" },
  new: { label: "Nueva", cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25" },
  error: { label: "Error", cls: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25" },
  skip: { label: "Sin cambio", cls: "bg-muted text-foreground/70 border-border" },
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
        "Customer", "Style", "Color", "Size", "Location", "Qty to Adjust",
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
      <div className="bg-card border border-border rounded-lg p-5 space-y-3">
        <div className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Boxes className="w-4 h-4 text-muted-foreground" /> Ajuste masivo de inventario
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Sube el Excel <b>Formato ajuste de inventario</b> (Customer, Style, Color, Size,
          Location, <b>Qty to Adjust</b>). La columna <b>Qty to Adjust</b> es el <b>ajuste</b>:
          un número positivo <b>suma</b> y uno negativo <b>resta</b> sobre la existencia actual.
          Verás una vista previa antes de aplicar. Las líneas que no existan se marcan como
          <b>Nueva</b> y se crean al confirmar. Si un material tiene varios lotes en la misma
          locación (país/composición distintos), las restas se validan contra el <b>total</b> y
          se reparten entre lotes; para afectar un lote específico —u obligatorio al sumar—
          agrega la columna <b>Country of Origin</b>.
        </p>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={downloadTemplate}>
            <FileDown className="w-4 h-4" /> Descargar plantilla
          </Btn>
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium cursor-pointer hover:opacity-90 transition-colors">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {fileName ? "Cambiar archivo" : "Subir Excel"}
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} disabled={busy} />
          </label>
          {fileName && (
            <Btn onClick={reset} className="text-muted-foreground">
              <RotateCcw className="w-4 h-4" /> Limpiar
            </Btn>
          )}
        </div>
        {fileName && <p className="text-xs font-mono text-muted-foreground">📄 {fileName} · {rows.length} fila(s)</p>}
      </div>

      {/* Summary */}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryPill label="Ajustes" value={s.adjust} cls="" />
          <SummaryPill label="Nuevas" value={s.new} cls="" />
          <SummaryPill label="Errores" value={s.error} cls={s.error > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"} />
          <SummaryPill label="Sin cambio" value={s.skip} cls="text-muted-foreground" />
        </div>
      )}

      {/* Preview table */}
      {preview?.rows?.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="max-h-[42vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/50 border-b border-border">
                <tr className="text-left text-xs font-semibold text-muted-foreground">
                  <th className="px-3 py-2.5">#</th>
                  <th className="px-3 py-2.5">Línea</th>
                  <th className="px-3 py-2.5 text-right">Actual</th>
                  <th className="px-3 py-2.5 text-right">Ajuste</th>
                  <th className="px-3 py-2.5 text-right">Nuevo</th>
                  <th className="px-3 py-2.5">Estado</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => {
                  const m = STATUS_META[r.status] || STATUS_META.skip;
                  return (
                    <tr key={i} className="border-b border-border/60 hover:bg-muted/40 transition-colors">
                      <td className="px-3 py-2.5 text-muted-foreground font-mono">{r.row}</td>
                      <td className="px-3 py-2.5 font-mono">{r.label}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{r.current ?? "—"}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${r.delta > 0 ? "text-emerald-600 dark:text-emerald-400" : r.delta < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                        {r.delta > 0 ? `+${r.delta}` : (r.delta ?? "—")}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">{r.new ?? "—"}</td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap ${m.cls}`}>{m.label}</span>
                        {r.message && <span className="block text-xs text-muted-foreground mt-0.5">{r.message}</span>}
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
        <div className="bg-card border border-border rounded-lg p-5 space-y-3">
          <label className="text-xs font-medium text-muted-foreground block">Motivo del ajuste *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
            placeholder="Ej. Conteo cíclico SAT — corrección física vs sistema"
            className={`${cls.input} resize-none`} />
          <button onClick={apply} disabled={!canApply}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 disabled:pointer-events-none">
            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Aplicar {s.adjust + s.new} cambio(s)
          </button>
        </div>
      )}

      {/* Result */}
      {result && (
        <SoftAlert
          tone="success"
          title="Ajuste aplicado"
          action={
            <Btn onClick={reset}>
              <RotateCcw className="w-4 h-4" /> Hacer otro ajuste
            </Btn>
          }
        >
          {result.summary.applied} línea(s) aplicadas · {result.summary.error} con error · {result.summary.skip} sin cambio.
        </SoftAlert>
      )}

      {!preview && !busy && (
        <div className="py-16 text-center">
          <p className="text-sm font-semibold text-foreground/80">Sube un archivo para ver la vista previa</p>
        </div>
      )}
    </div>
  );
}

function SummaryPill({ label, value, cls }) {
  return (
    <div className="bg-card border border-border rounded-lg px-5 py-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tracking-tight tabular-nums mt-1 ${cls}`}>{value ?? 0}</div>
    </div>
  );
}
