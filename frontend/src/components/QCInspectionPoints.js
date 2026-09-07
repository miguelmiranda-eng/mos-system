import React, { useState, useEffect, useCallback } from "react";
import { API } from "../lib/constants";
import { useAuth } from "../App";
import { useLang } from "../contexts/LanguageContext";
import { toast } from "sonner";
import {
  Plus, Loader2, Pencil, Trash2, Check, X, ChevronUp, ChevronDown,
  Camera, ListChecks, Type, ToggleLeft, ShieldCheck, Power, Lock,
} from "lucide-react";

// The six configurable action types (mirror backend ACTION_TYPES).
// label/hint are i18n keys (resolved with t() inside the component).
const ACTION_TYPES = [
  { id: "PHOTO", labelKey: "qc_at_photo", icon: Camera, hintKey: "qc_at_photo_hint" },
  { id: "YESNO", labelKey: "qc_at_yesno", icon: ToggleLeft, hintKey: "qc_at_yesno_hint" },
  { id: "PASSFAIL", labelKey: "qc_at_passfail", icon: ShieldCheck, hintKey: "qc_at_passfail_hint" },
  { id: "CORRECT", labelKey: "qc_at_correct", icon: ShieldCheck, hintKey: "qc_at_correct_hint" },
  { id: "TEXT", labelKey: "qc_at_text", icon: Type, hintKey: "qc_at_text_hint" },
  { id: "LIST", labelKey: "qc_at_list", icon: ListChecks, hintKey: "qc_at_list_hint" },
];

const emptyForm = { name: "", action_type: "PHOTO", prompt: "", options: [], active: true, photo_required: false };

export default function QCInspectionPoints() {
  const { user } = useAuth();
  const { t } = useLang();
  const isSupersu = user?.role === "supersu";
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null); // null = none, 'new' = creating, or point_id
  const [form, setForm] = useState(emptyForm);
  const [optDraft, setOptDraft] = useState("");

  // Global on/off for the whole point-based inspection subsystem. Only supersu
  // may flip it; everyone else sees a read-only state. Mirrors GET/PUT /qc/feature-flags.
  const [enabled, setEnabled] = useState(false);
  const [flagLoading, setFlagLoading] = useState(true);
  const [flagSaving, setFlagSaving] = useState(false);

  useEffect(() => {
    fetch(`${API}/qc/feature-flags`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setEnabled(!!d.inspection_points_enabled); })
      .catch(() => {})
      .finally(() => setFlagLoading(false));
  }, []);

  const toggleEnabled = async () => {
    if (!isSupersu || flagSaving) return;
    const next = !enabled;
    setFlagSaving(true);
    try {
      const res = await fetch(`${API}/qc/feature-flags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ inspection_points_enabled: next }),
      });
      if (res.ok) {
        const d = await res.json();
        setEnabled(!!d.inspection_points_enabled);
        toast.success(next ? t("qc_points_enabled_toast") : t("qc_points_disabled_toast"));
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t("qc_toggle_err"));
      }
    } catch {
      toast.error(t("ceo_err_connection"));
    } finally { setFlagSaving(false); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/qc/inspection-points`, { credentials: "include" });
      const data = res.ok ? await res.json() : [];
      setPoints(Array.isArray(data) ? data : []);
    } catch {
      toast.error(t("qc_points_load_err"));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const startNew = () => { setForm(emptyForm); setOptDraft(""); setEditingId("new"); };
  const startEdit = (p) => {
    setForm({ name: p.name, action_type: p.action_type, prompt: p.prompt || "", options: p.options || [], active: p.active !== false, photo_required: !!p.photo_required });
    setOptDraft("");
    setEditingId(p.point_id);
  };
  const cancel = () => { setEditingId(null); setForm(emptyForm); setOptDraft(""); };

  const addOption = () => {
    const v = optDraft.trim();
    if (!v) return;
    if (form.options.includes(v)) { toast.error(t("qc_option_exists")); return; }
    setForm(f => ({ ...f, options: [...f.options, v] }));
    setOptDraft("");
  };
  const removeOption = (v) => setForm(f => ({ ...f, options: f.options.filter(o => o !== v) }));

  const save = async () => {
    if (!form.name.trim()) { toast.error(t("qc_point_name_required")); return; }
    if (form.action_type === "LIST" && form.options.length === 0) {
      toast.error(t("qc_list_needs_option")); return;
    }
    setSaving(true);
    try {
      const isNew = editingId === "new";
      const url = isNew ? `${API}/qc/inspection-points` : `${API}/qc/inspection-points/${editingId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: form.name.trim(),
          action_type: form.action_type,
          prompt: form.prompt.trim(),
          options: form.action_type === "LIST" ? form.options : [],
          active: form.active,
          photo_required: form.photo_required,
        }),
      });
      if (res.ok) {
        toast.success(isNew ? t("qc_point_created") : t("qc_point_updated"));
        cancel();
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t("qc_save_err"));
      }
    } catch {
      toast.error(t("ceo_err_connection"));
    } finally { setSaving(false); }
  };

  const remove = async (p) => {
    if (!window.confirm(t("qc_delete_point_confirm", { name: p.name }))) return;
    try {
      const res = await fetch(`${API}/qc/inspection-points/${p.point_id}`, { method: "DELETE", credentials: "include" });
      if (res.ok) { toast.success(t("qc_point_deleted")); load(); }
      else toast.error(t("qc_delete_err"));
    } catch { toast.error(t("ceo_err_connection")); }
  };

  const toggleActive = async (p) => {
    try {
      await fetch(`${API}/qc/inspection-points/${p.point_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ active: !(p.active !== false) }),
      });
      load();
    } catch { toast.error(t("ceo_err_connection")); }
  };

  // Swap sort_order with the neighbor to move a point up/down.
  const move = async (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= points.length) return;
    const a = points[idx], b = points[j];
    try {
      await Promise.all([
        fetch(`${API}/qc/inspection-points/${a.point_id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ sort_order: b.sort_order }) }),
        fetch(`${API}/qc/inspection-points/${b.point_id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ sort_order: a.sort_order }) }),
      ]);
      load();
    } catch { toast.error(t("ceo_err_connection")); }
  };

  const promptLabel = form.action_type === "PHOTO" ? t("qc_prompt_label_photo") : t("qc_prompt_label_question");

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        {/* Master switch: turn the whole point-based inspection subsystem on/off (supersu only) */}
        <div className={`mb-6 rounded-2xl border p-5 flex items-start gap-4 ${enabled ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${enabled ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground"}`}>
            <Power className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-black text-foreground">{t("qc_point_inspection")}</div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {enabled
                ? t("qc_points_enabled_desc")
                : t("qc_points_disabled_desc")}
            </p>
            {!isSupersu && (
              <p className="text-[11px] font-bold text-muted-foreground mt-2 inline-flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5" /> {t("qc_supersu_only_switch")}
              </p>
            )}
          </div>
          <button
            onClick={toggleEnabled}
            disabled={!isSupersu || flagLoading || flagSaving}
            title={isSupersu ? (enabled ? t("qc_deactivate") : t("qc_activate")) : t("qc_supersu_only_short")}
            className={`relative w-14 h-8 rounded-full flex-shrink-0 transition-colors ${enabled ? "bg-primary" : "bg-secondary border border-border"} ${(!isSupersu || flagLoading || flagSaving) ? "opacity-50 cursor-not-allowed" : "active:scale-95"}`}
          >
            <span className={`absolute top-1 left-1 w-6 h-6 rounded-full bg-white shadow flex items-center justify-center transition-transform ${enabled ? "translate-x-6" : "translate-x-0"}`}>
              {flagSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> : null}
            </span>
          </button>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-3xl font-black uppercase tracking-tighter text-foreground mb-1">{t("qc_points_title")}</h2>
            <p className="text-muted-foreground font-medium max-w-xl">
              {t("qc_points_desc")}
            </p>
          </div>
          {editingId === null && (
            <button onClick={startNew}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-bold text-sm shadow-md active:scale-95 transition-transform whitespace-nowrap">
              <Plus className="w-4 h-4" /> {t("qc_new_point")}
            </button>
          )}
        </div>

        {/* Editor */}
        {editingId !== null && (
          <div className="mb-6 rounded-2xl border border-primary/30 bg-card p-5 space-y-4 shadow-lg">
            <div className="text-xs font-black uppercase tracking-widest text-primary">
              {editingId === "new" ? t("qc_new_point_title") : t("qc_edit_point")}
            </div>
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">{t("qc_point_name")}</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={t("qc_point_name_placeholder")}
                className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary" />
            </div>
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground block mb-1.5">{t("qc_action_type")}</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ACTION_TYPES.map(at => {
                  const Icon = at.icon;
                  const on = form.action_type === at.id;
                  return (
                    <button key={at.id} onClick={() => setForm(f => ({ ...f, action_type: at.id }))}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-xs font-bold transition-all ${on ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/40"}`}>
                      <Icon className="w-4 h-4 flex-shrink-0" /> {t(at.labelKey)}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">{t(ACTION_TYPES.find(at => at.id === form.action_type)?.hintKey)}</p>
            </div>
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">{promptLabel}</label>
              <textarea value={form.prompt} onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))} rows={2}
                placeholder={form.action_type === "PHOTO" ? t("qc_prompt_placeholder_photo") : t("qc_prompt_placeholder_question")}
                className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary resize-none" />
            </div>
            {form.action_type === "LIST" && (
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">{t("qc_list_options")}</label>
                <div className="flex gap-2">
                  <input value={optDraft} onChange={e => setOptDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }}
                    placeholder={t("qc_list_option_placeholder")}
                    className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary" />
                  <button onClick={addOption} className="px-3 py-2 rounded-lg bg-secondary text-foreground font-bold text-sm">{t("add")}</button>
                </div>
                {form.options.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {form.options.map(o => (
                      <span key={o} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-secondary/60 border border-border text-xs font-bold">
                        {o}
                        <button onClick={() => removeOption(o)} className="text-muted-foreground hover:text-destructive"><X className="w-3 h-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {form.action_type !== "PHOTO" && (
              <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
                <input type="checkbox" checked={form.photo_required} onChange={e => setForm(f => ({ ...f, photo_required: e.target.checked }))} className="w-4 h-4 rounded border-border accent-primary" />
                <span className="flex items-center gap-1.5"><Camera className="w-4 h-4 text-primary" /> {t("qc_photo_required_label")}</span>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
              <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="w-4 h-4 rounded border-border accent-primary" />
              {t("qc_active_label")}
            </label>
            <div className="flex gap-2 pt-1">
              <button onClick={save} disabled={saving}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-bold text-sm disabled:opacity-50 active:scale-95 transition-transform">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {t("save")}
              </button>
              <button onClick={cancel} className="px-4 py-2.5 rounded-xl border border-border text-muted-foreground font-bold text-sm hover:bg-secondary">{t("cancel")}</button>
            </div>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : points.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <ShieldCheck className="w-12 h-12 mx-auto opacity-30 mb-3" />
            <p className="font-bold">{t("qc_no_points")}</p>
            <p className="text-sm mt-1">{t("qc_no_points_hint")}</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {points.map((p, i) => {
              const T = ACTION_TYPES.find(at => at.id === p.action_type);
              const Icon = T?.icon || ShieldCheck;
              return (
                <div key={p.point_id} className={`rounded-2xl border bg-card p-4 flex items-start gap-3 ${p.active === false ? "opacity-50 border-border" : "border-border"}`}>
                  <div className="flex flex-col gap-1 pt-0.5">
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronUp className="w-4 h-4" /></button>
                    <button onClick={() => move(i, 1)} disabled={i === points.length - 1} className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronDown className="w-4 h-4" /></button>
                  </div>
                  <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0"><Icon className="w-5 h-5 text-primary" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-black text-foreground">{p.name}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-secondary text-muted-foreground">{T ? t(T.labelKey) : p.action_type}</span>
                      {(p.action_type === "PHOTO" || p.photo_required) && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-primary/10 text-primary inline-flex items-center gap-1"><Camera className="w-3 h-3" /> {t("qc_photo_req_short")}</span>
                      )}
                      {p.active === false && <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-destructive/10 text-destructive">{t("qc_inactive")}</span>}
                    </div>
                    {p.prompt && <p className="text-sm text-muted-foreground mt-1">{p.prompt}</p>}
                    {p.action_type === "LIST" && p.options?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {p.options.map(o => <span key={o} className="text-[11px] font-mono px-2 py-0.5 rounded bg-secondary/60 border border-border">{o}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => toggleActive(p)} title={p.active === false ? t("qc_activate") : t("qc_deactivate")}
                      className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"><ToggleLeft className="w-4 h-4" /></button>
                    <button onClick={() => startEdit(p)} className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => remove(p)} className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
