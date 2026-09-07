import { useState, useRef } from "react";
import { toast } from "sonner";
import { Upload, Loader2, CheckCircle2, FileDown, RotateCcw, Boxes } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
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

// Etiqueta por labelKey: se traduce en el render (constante a nivel de módulo,
// sin acceso a hooks).
const STATUS_META = {
  adjust: { labelKey: "wms_bulk_status_adjust", cls: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25" },
  new: { labelKey: "wms_bulk_status_new", cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25" },
  error: { labelKey: "error", cls: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25" },
  skip: { labelKey: "wms_bulk_status_skip", cls: "bg-muted text-foreground/70 border-border" },
};

export default function BulkInventoryAdjust() {
  const { t } = useLang();
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
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t("wms_bulk_preview_err")); }
    } catch { toast.error(t("wms_conn_err")); }
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
      if (!norm.length) { toast.error(t("wms_bulk_no_valid_rows")); return; }
      setRows(norm); setFileName(file.name);
      await runPreview(norm);
    } catch {
      toast.error(t("wms_bulk_read_err"));
    } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!reason.trim()) { toast.error(t("wms_bulk_reason_req")); return; }
    const changes = (preview?.summary?.adjust || 0) + (preview?.summary?.new || 0);
    if (!changes) { toast.error(t("wms_bulk_no_changes")); return; }
    if (!window.confirm(t("wms_bulk_apply_conf", { n: changes }))) return;
    setApplying(true);
    try {
      const res = await poster("/inventory/bulk-adjust", { rows, dry_run: false, reason: reason.trim() });
      if (res.ok) {
        const data = await res.json();
        setResult(data);
        setPreview(data); // refresh statuses after applying
        toast.success(t("wms_bulk_applied_toast", { n: data.summary.applied }));
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t("wms_bulk_apply_err"));
      }
    } catch { toast.error(t("wms_conn_err")); }
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
    } catch { toast.error(t("wms_bulk_template_err")); }
  };

  const s = preview?.summary;
  const canApply = !applying && !result && s && (s.adjust + s.new) > 0;

  return (
    <div className="space-y-5">
      {/* Instructions */}
      <div className="bg-card border border-border rounded-lg p-5 space-y-3">
        <div className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Boxes className="w-4 h-4 text-muted-foreground" /> {t("wms_bulk_title")}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t("wms_bulk_intro_upload")} <b>Formato ajuste de inventario</b> (Customer, Style, Color, Size,
          Location, <b>Qty to Adjust</b>). {t("wms_bulk_intro_delta")}{" "}
          {t("wms_bulk_intro_preview")}{" "}
          {t("wms_bulk_intro_lots")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={downloadTemplate}>
            <FileDown className="w-4 h-4" /> {t("wms_bulk_download_template")}
          </Btn>
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium cursor-pointer hover:opacity-90 transition-colors">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {fileName ? t("wms_bulk_change_file") : t("wms_bulk_upload_excel")}
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} disabled={busy} />
          </label>
          {fileName && (
            <Btn onClick={reset} className="text-muted-foreground">
              <RotateCcw className="w-4 h-4" /> {t("clear")}
            </Btn>
          )}
        </div>
        {fileName && <p className="text-xs font-mono text-muted-foreground">📄 {fileName} · {t("wms_bulk_rows_n", { n: rows.length })}</p>}
      </div>

      {/* Summary */}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryPill label={t("wms_bulk_adjustments")} value={s.adjust} valueCls="" />
          <SummaryPill label={t("wms_bulk_new_pl")} value={s.new} valueCls="" />
          <SummaryPill label={t("wms_bulk_errors")} value={s.error} valueCls={s.error > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"} />
          <SummaryPill label={t("wms_bulk_status_skip")} value={s.skip} valueCls="text-muted-foreground" />
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
                  <th className="px-3 py-2.5">{t("wms_bulk_line")}</th>
                  <th className="px-3 py-2.5 text-right">{t("wms_bulk_current")}</th>
                  <th className="px-3 py-2.5 text-right">{t("wms_bulk_status_adjust")}</th>
                  <th className="px-3 py-2.5 text-right">{t("wms_bulk_new_qty")}</th>
                  <th className="px-3 py-2.5">{t("status")}</th>
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
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap ${m.cls}`}>{t(m.labelKey)}</span>
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
          <label className="text-xs font-medium text-muted-foreground block">{t("wms_bulk_reason_label")}</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
            placeholder={t("wms_bulk_reason_ph")}
            className={`${cls.input} resize-none`} />
          <button onClick={apply} disabled={!canApply}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 disabled:pointer-events-none">
            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {t("wms_bulk_apply_n", { n: s.adjust + s.new })}
          </button>
        </div>
      )}

      {/* Result */}
      {result && (
        <SoftAlert
          tone="success"
          title={t("wms_bulk_applied_title")}
          action={
            <Btn onClick={reset}>
              <RotateCcw className="w-4 h-4" /> {t("wms_bulk_another")}
            </Btn>
          }
        >
          {t("wms_bulk_result_summary", { applied: result.summary.applied, error: result.summary.error, skip: result.summary.skip })}
        </SoftAlert>
      )}

      {!preview && !busy && (
        <div className="py-16 text-center">
          <p className="text-sm font-semibold text-foreground/80">{t("wms_bulk_upload_hint")}</p>
        </div>
      )}
    </div>
  );
}

// `valueCls` (no `cls`): el nombre `cls` sombreaba al import de ./ui.
function SummaryPill({ label, value, valueCls }) {
  return (
    <div className="bg-card border border-border rounded-lg px-5 py-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tracking-tight tabular-nums mt-1 ${valueCls}`}>{value ?? 0}</div>
    </div>
  );
}
