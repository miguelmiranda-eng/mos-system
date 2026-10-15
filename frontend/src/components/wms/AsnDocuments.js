import { useContext, useRef, useState } from "react";
import { toast } from "sonner";
import { FileText, Download, Trash2, Upload, Loader2 } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { apiFetch } from "../../lib/http";
import { API, WmsContext, logLoadError } from "./lib";

// Documentos de la entrada (BOL, packing list, factura). Los sube el portal del
// cliente o el personal de MOS; se bajan por doc_id. Borrar = asn.edit.
const KINDS = ["bol", "packing_list", "commercial_invoice", "other"];
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.csv,.xls,.xlsx,.doc,.docx";

export default function AsnDocuments({ asnId, documents = [], onChanged }) {
  const { t } = useLang();
  const { can } = useContext(WmsContext);
  const [kind, setKind] = useState("bol");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const base = `${API}/asn/${encodeURIComponent(asnId)}/documents`;

  const upload = async (file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", kind);
    setBusy(true);
    try {
      const res = await apiFetch(base, { method: "POST", body: fd });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || t("wms_asn_docs_upload_err")); return; }
      toast.success(t("wms_asn_docs_uploaded", { name: r.filename }));
      onChanged?.();
    } catch (err) { logLoadError("asn doc upload")(err); toast.error(t("wms_conn_error")); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const download = async (d) => {
    try {
      const res = await apiFetch(`${base}/${d.doc_id}`);
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("wms_asn_docs_download_err")); return; }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = d.filename || d.doc_id;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { logLoadError("asn doc download")(err); toast.error(t("wms_conn_error")); }
  };

  const remove = async (d) => {
    if (!window.confirm(t("wms_asn_docs_delete_confirm", { name: d.filename }))) return;
    try {
      const res = await apiFetch(`${base}/${d.doc_id}`, { method: "DELETE" });
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("wms_asn_docs_delete_err")); return; }
      onChanged?.();
    } catch (err) { logLoadError("asn doc delete")(err); toast.error(t("wms_conn_error")); }
  };

  return (
    <div className="rounded-xl border border-border p-4 space-y-3" data-testid="asn-documents">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h4 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="w-4 h-4" /> {t("wms_asn_docs_title")}
          <span className="text-xs text-muted-foreground font-normal">({documents.length})</span>
        </h4>
        <div className="flex items-center gap-2">
          <select value={kind} onChange={e => setKind(e.target.value)}
                  className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
                  data-testid="asn-doc-kind">
            {KINDS.map(k => <option key={k} value={k}>{t(`wms_asn_doc_kind_${k}`)}</option>)}
          </select>
          <input ref={fileRef} type="file" accept={ACCEPT} className="hidden"
                 onChange={e => upload(e.target.files?.[0])} data-testid="asn-doc-file" />
          <button onClick={() => fileRef.current?.click()} disabled={busy}
                  className="h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} {t("wms_asn_docs_upload")}
          </button>
        </div>
      </div>
      {documents.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("wms_asn_docs_empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {documents.map(d => (
            <li key={d.doc_id} className="flex items-center gap-3 py-2 text-xs">
              <span className="px-2 py-0.5 rounded-md border border-border text-muted-foreground whitespace-nowrap">
                {t(`wms_asn_doc_kind_${d.kind}`)}
              </span>
              <span className="truncate flex-1" title={d.filename}>{d.filename}</span>
              {d.source === "portal" && (
                <span className="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-300">{t("wms_asn_portal_badge")}</span>
              )}
              <span className="text-muted-foreground whitespace-nowrap hidden sm:inline">
                {d.uploaded_by_name} · {d.uploaded_at ? new Date(d.uploaded_at).toLocaleString() : ""}
              </span>
              <button onClick={() => download(d)} title={t("wms_asn_docs_download")}
                      className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-primary">
                <Download className="w-4 h-4" />
              </button>
              {can("asn.edit") && (
                <button onClick={() => remove(d)} title={t("wms_asn_docs_delete")}
                        className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
