import React, { useState, useEffect, useRef } from "react";
import { API } from "../lib/constants";
import { toast } from "sonner";
import { useLang } from "../contexts/LanguageContext";
import {
  X, Loader2, Camera, Check, AlertTriangle, ShieldCheck, Save, Lock,
} from "lucide-react";
import { pointSatisfied } from "../lib/qcInspection";

// Compress big images (matches the QC form: max 1920px, JPEG 0.8).
const fileToData = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const raw = ev.target.result;
    if (file.size > 512 * 1024) {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        const MAX = 1920;
        if (width > MAX || height > MAX) { const s = MAX / Math.max(width, height); width = Math.round(width * s); height = Math.round(height * s); }
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve({ data: canvas.toDataURL("image/jpeg", 0.8), name: (file.name || `qc_${Date.now()}.jpg`).replace(/\.[^.]+$/, ".jpg") });
      };
      img.onerror = reject; img.src = raw;
    } else {
      resolve({ data: raw, name: file.name || `qc_${Date.now()}.jpg` });
    }
  };
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

export default function QCInspectionModal({ inspectionId, onClose, onChanged }) {
  const { t } = useLang();
  // Read t through a ref inside the load effect below: that effect must NOT
  // re-run when the language toggles (see its comment), so t stays out of its deps.
  const tRef = useRef(t);
  tRef.current = t;
  const [insp, setInsp] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingId, setUploadingId] = useState(null);
  const [showMissing, setShowMissing] = useState(false);

  // Load ONCE per inspection. Critically, this must NOT depend on onClose/
  // onChanged: those arrive as inline functions whose identity changes on every
  // parent re-render (e.g. the QC dashboard's 30s notification poll). Depending
  // on them re-fired this fetch mid-edit and overwrote the operator's unsaved
  // progress with the (empty) server copy — that's why "no guardaba".
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API}/qc/inspections/${inspectionId}`, { credentials: "include" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (alive) { setInsp(data); setItems(data.items || []); }
      } catch {
        if (alive) toast.error(tRef.current("qc_load_inspection_err"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [inspectionId]);

  const readOnly = insp?.status === "completed";
  const setItem = (pid, patch) => setItems(prev => prev.map(it => it.point_id === pid ? { ...it, ...patch } : it));

  const addPhotos = async (pid, files) => {
    if (!insp?.order_id) { toast.error(t("qc_inspection_no_order")); return; }
    setUploadingId(pid);
    try {
      // Compress + upload all chosen photos in parallel (functional setState
      // makes the concurrent appends safe), instead of one-by-one.
      await Promise.all(Array.from(files).map(async (file) => {
        try {
          const { data, name } = await fileToData(file);
          const res = await fetch(`${API}/orders/${insp.order_id}/images`, {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
            body: JSON.stringify({ image_data: data, filename: name }),
          });
          if (res.ok) {
            const d = await res.json();
            const url = d.url || d.storage_key;
            setItems(prev => prev.map(it => it.point_id === pid ? { ...it, photos: [...(it.photos || []), url] } : it));
          } else { toast.error(t("qc_upload_error", { name })); }
        } catch { toast.error(t("qc_upload_image_err")); }
      }));
    } finally { setUploadingId(null); }
  };
  const removePhoto = (pid, url) => setItems(prev => prev.map(it => it.point_id === pid ? { ...it, photos: (it.photos || []).filter(u => u !== url) } : it));

  const persist = async (complete) => {
    setSaving(true);
    try {
      const url = complete ? `${API}/qc/inspections/${inspectionId}/complete` : `${API}/qc/inspections/${inspectionId}`;
      const res = await fetch(url, {
        method: complete ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ items }),
      });
      if (res.ok) {
        const data = await res.json();
        setInsp(data); setItems(data.items || items);
        setShowMissing(false);
        toast.success(complete ? t("qc_inspection_completed_toast") : t("qc_progress_saved"));
        onChanged?.();
        if (complete) onClose?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t("qc_save_err"));
        if (complete) setShowMissing(true);
      }
    } catch { toast.error(t("ceo_err_connection")); }
    finally { setSaving(false); }
  };

  const missingCount = items.filter(it => !pointSatisfied(it)).length;

  // ── Per-type control ────────────────────────────────────────────────────────
  const Choice = ({ it, opts }) => (
    <div className="flex flex-wrap gap-2">
      {opts.map(o => {
        const on = String(it.value) === o.v;
        return (
          <button key={o.v} disabled={readOnly} onClick={() => setItem(it.point_id, { value: o.v })}
            className={`px-4 py-2 rounded-xl border text-sm font-bold transition-all ${on ? (o.tone || "border-primary bg-primary/10 text-primary") : "border-border bg-background text-muted-foreground hover:border-primary/40"} disabled:opacity-60`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );

  // Photo upload block — used as the control for PHOTO points and as optional/
  // required evidence on every other point.
  const photoBlock = (it) => (
    <div className="flex flex-wrap gap-2">
      {(it.photos || []).map(u => (
        <div key={u} className="relative w-20 h-20 rounded-lg overflow-hidden border border-border">
          <img src={u} alt={t("qc_evidence_alt")} className="w-full h-full object-cover" />
          {!readOnly && <button onClick={() => removePhoto(it.point_id, u)} className="absolute top-0.5 right-0.5 bg-black/60 rounded p-0.5 text-white"><X className="w-3 h-3" /></button>}
        </div>
      ))}
      {!readOnly && (
        <label className="w-20 h-20 rounded-lg border-2 border-dashed border-border flex flex-col items-center justify-center cursor-pointer text-muted-foreground hover:border-primary hover:text-primary">
          {uploadingId === it.point_id ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Camera className="w-5 h-5" /><span className="text-[9px] font-bold mt-0.5">{t("qc_photo")}</span></>}
          <input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={e => { if (e.target.files?.length) addPhotos(it.point_id, e.target.files); e.target.value = ""; }} />
        </label>
      )}
    </div>
  );

  // "N/A" selection — appended to choice controls; a standalone toggle for the rest.
  const NA_OPT = { v: "N/A", label: "N/A", tone: "border-slate-400 bg-slate-400/15 text-slate-400" };
  const naToggle = (it) => {
    const on = String(it.value) === "N/A";
    return (
      <button disabled={readOnly} onClick={() => setItem(it.point_id, { value: on ? "" : "N/A" })}
        className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-all ${on ? "border-slate-400 bg-slate-400/15 text-slate-400" : "border-border text-muted-foreground hover:border-slate-400"} disabled:opacity-60`}>
        {t("qc_na_label")}
      </button>
    );
  };

  const control = (it) => {
    switch (it.action_type) {
      case "PHOTO":
        return photoBlock(it);
      case "YESNO":
        return <Choice it={it} opts={[{ v: "Sí", label: t("yes"), tone: "border-emerald-500 bg-emerald-500/10 text-emerald-500" }, { v: "No", label: t("no"), tone: "border-red-500 bg-red-500/10 text-red-500" }, NA_OPT]} />;
      case "PASSFAIL":
        return <Choice it={it} opts={[{ v: "Pass", label: "Pass", tone: "border-emerald-500 bg-emerald-500/10 text-emerald-500" }, { v: "Fail", label: "Fail", tone: "border-red-500 bg-red-500/10 text-red-500" }, NA_OPT]} />;
      case "CORRECT":
        return <Choice it={it} opts={[{ v: "Correcto", label: t("qc_correct"), tone: "border-emerald-500 bg-emerald-500/10 text-emerald-500" }, { v: "Incorrecto", label: t("qc_incorrect"), tone: "border-red-500 bg-red-500/10 text-red-500" }, NA_OPT]} />;
      case "LIST":
        return <Choice it={it} opts={[...(it.options || []).map(o => ({ v: o, label: o })), NA_OPT]} />;
      case "TEXT":
        return (
          <textarea disabled={readOnly} value={it.value || ""} onChange={e => setItem(it.point_id, { value: e.target.value })}
            rows={2} placeholder={t("qc_write_here")}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary resize-none disabled:opacity-60" />
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-stretch sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-card w-full sm:max-w-2xl sm:rounded-3xl shadow-2xl flex flex-col max-h-screen sm:max-h-[92vh] h-full sm:h-auto">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 p-4 sm:p-5 border-b border-border flex-shrink-0">
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-primary flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> {t("qc_point_inspection")}</div>
            <div className="text-lg font-black truncate">#{insp?.order_number} {insp?.client && <span className="text-sm font-bold text-muted-foreground">· {insp.client}</span>}</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground flex-shrink-0"><X className="w-5 h-5" /></button>
        </div>

        {/* Status / progress bar */}
        {!loading && (
          <div className={`px-4 sm:px-5 py-2 text-xs font-bold flex items-center gap-2 flex-shrink-0 ${readOnly ? "bg-emerald-500/10 text-emerald-500" : missingCount === 0 ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"}`}>
            {readOnly ? <><Lock className="w-3.5 h-3.5" /> {t("qc_inspection_completed")}</>
              : missingCount === 0 ? <><Check className="w-3.5 h-3.5" /> {t("qc_all_points_ready")}</>
                : <><AlertTriangle className="w-3.5 h-3.5" /> {t("qc_missing_points", { missing: missingCount, total: items.length })}</>}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : items.length === 0 ? (
            <p className="text-center text-muted-foreground py-10">{t("qc_inspection_no_points")}</p>
          ) : items.map((it, i) => {
            const ok = pointSatisfied(it);
            const flag = showMissing && !ok;
            const isNA = String(it.value) === "N/A";
            const isChoice = ["YESNO", "PASSFAIL", "CORRECT", "LIST"].includes(it.action_type);
            const photoReq = it.action_type === "PHOTO" || it.photo_required;
            return (
              <div key={it.point_id} className={`rounded-2xl border p-4 ${flag ? "border-red-500 bg-red-500/5" : "border-border bg-background/40"}`}>
                <div className="flex items-start gap-2 mb-2">
                  <span className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black flex-shrink-0 ${ok ? "bg-emerald-500 text-white" : "bg-secondary text-muted-foreground"}`}>{ok ? <Check className="w-3 h-3" /> : i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-black text-foreground">{it.name}</div>
                    {it.prompt && <div className="text-xs text-muted-foreground mt-0.5">{it.prompt}</div>}
                  </div>
                  {photoReq && <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary flex-shrink-0 inline-flex items-center gap-1"><Camera className="w-2.5 h-2.5" /> {t("qc_photo_req_short")}</span>}
                </div>
                <div className="pl-7 space-y-2.5">
                  {/* Main control. Choice types include N/A as an option; others get a toggle. */}
                  {isChoice ? control(it) : (
                    <div className="space-y-2">
                      {naToggle(it)}
                      {!isNA && control(it)}
                    </div>
                  )}
                  {/* Photo evidence on every non-PHOTO point (optional or required). */}
                  {it.action_type !== "PHOTO" && !isNA && (
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1">
                        <Camera className="w-3.5 h-3.5" /> {t("qc_photo_evidence")} {it.photo_required ? <span className="text-primary normal-case tracking-normal font-bold">{t("qc_required_paren")}</span> : <span className="normal-case tracking-normal">{t("qc_optional_paren")}</span>}
                      </div>
                      {photoBlock(it)}
                    </div>
                  )}
                  <input disabled={readOnly} value={it.comments || ""} onChange={e => setItem(it.point_id, { comments: e.target.value })}
                    placeholder={t("qc_comments_optional")}
                    className="w-full px-3 py-1.5 bg-background border border-border rounded-lg text-xs focus:outline-none focus:border-primary disabled:opacity-60" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {!readOnly && !loading && (
          <div className="flex gap-2 p-4 border-t border-border flex-shrink-0" style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
            <button onClick={() => persist(false)} disabled={saving}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-border text-foreground font-bold text-sm hover:bg-secondary disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {t("qc_save_progress")}
            </button>
            <button onClick={() => persist(true)} disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-bold text-sm disabled:opacity-50 active:scale-[0.99] transition-transform">
              <Lock className="w-4 h-4" /> {t("qc_complete_inspection")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
