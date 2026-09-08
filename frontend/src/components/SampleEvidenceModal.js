import React, { useState, useEffect, useCallback } from "react";
import { API } from "../lib/constants";
import { X, Upload, Loader2, Shirt, ImageIcon, Send } from "lucide-react";
import { toast } from "sonner";

/**
 * Modal de EVIDENCIA DE SAMPLE (playerita). Muestra las evidencias ya subidas
 * (imagen + comentario + quién/cuándo) y permite agregar una nueva. Se abre al
 * dar clic en la playerita de una orden. Lee/escribe el contenedor dedicado
 * `sample_evidence` (endpoints /api/orders/{id}/sample-evidence).
 */
export default function SampleEvidenceModal({ order, onClose, onChanged }) {
  const orderId = order?.order_id;
  const [items, setItems] = useState(null);
  const [comment, setComment] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await fetch(`${API}/orders/${orderId}/sample-evidence`, { credentials: "include" });
      if (res.ok) setItems((await res.json()).evidence || []);
      else setItems([]);
    } catch { setItems([]); }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  const onPickFile = (f) => {
    setFile(f || null);
    if (f) {
      const r = new FileReader();
      r.onload = () => setPreview(r.result);
      r.readAsDataURL(f);
    } else setPreview(null);
  };

  // La URL guardada puede ser relativa ('/api/uploads/…', si BACKEND_PUBLIC_URL
  // está vacío) y resolvería contra el frontend, no el backend. Se reconstruye
  // absoluta desde storage_key con la base API (mismo patrón que QCDashboard).
  const imgUrl = (it) => {
    if (it.storage_key) return `${API}/uploads/${it.storage_key}`;
    if (it.url && it.url.startsWith('http')) return it.url;
    if (it.url && it.url.startsWith('/api/')) return `${API}${it.url.slice(4)}`;
    return it.url || '';
  };

  const toBase64 = (f) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(f);
  });

  const submit = async () => {
    if (!file && !comment.trim()) { toast.error("Agrega una imagen o un comentario"); return; }
    setSaving(true);
    try {
      const body = { comment: comment.trim() };
      if (file) { body.image_data = await toBase64(file); body.filename = file.name; }
      const res = await fetch(`${API}/orders/${orderId}/sample-evidence`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).detail || "Error al guardar");
      setComment(""); setFile(null); setPreview(null);
      await load();
      if (onChanged) onChanged();
      toast.success("Evidencia agregada");
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl max-w-lg w-full max-h-[85vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-black uppercase tracking-wide flex items-center gap-2">
            <Shirt className="w-5 h-5 text-violet-500" /> Evidencia de sample
            <span className="text-xs text-muted-foreground font-mono">#{order?.order_number}</span>
          </h3>
          <button onClick={onClose} className="p-1.5 hover:bg-secondary rounded-lg"><X className="w-5 h-5" /></button>
        </div>

        {/* Evidencias existentes */}
        {items === null ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Cargando…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Sin evidencia todavía. Agrega la primera abajo.</p>
        ) : (
          <div className="space-y-3 mb-4">
            {items.map((it, i) => (
              <div key={i} className="flex gap-3 bg-secondary/30 rounded-xl p-3">
                {(it.url || it.storage_key) ? (
                  <a href={imgUrl(it)} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={imgUrl(it)} alt="evidencia" className="w-20 h-20 object-cover rounded-lg border border-border" />
                  </a>
                ) : (
                  <div className="w-20 h-20 rounded-lg bg-secondary flex items-center justify-center shrink-0"><ImageIcon className="w-6 h-6 text-muted-foreground" /></div>
                )}
                <div className="min-w-0 flex-1">
                  {it.comment && <p className="text-sm text-foreground break-words">{it.comment}</p>}
                  <p className="text-[11px] text-muted-foreground mt-1">{it.by_name || "—"} · {it.at ? new Date(it.at).toLocaleString() : ""}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Agregar nueva */}
        <div className="border-t border-border/50 pt-4 space-y-3">
          <label className="flex items-center gap-3 bg-secondary/40 border border-dashed border-border rounded-xl px-4 py-3 cursor-pointer hover:border-violet-500/50 transition-all">
            <Upload className="w-5 h-5 text-muted-foreground shrink-0" />
            <span className="text-sm truncate">{file ? file.name : "Elegir imagen (opcional)"}</span>
            <input type="file" accept="image/*" className="hidden" onChange={e => onPickFile(e.target.files?.[0] || null)} />
          </label>
          {preview && <img src={preview} alt="preview" className="w-24 h-24 object-cover rounded-lg border border-border" />}
          <textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="Comentario (opcional)"
            className="w-full bg-secondary/50 border border-border rounded-lg p-2.5 text-sm min-h-[70px]" />
          <button onClick={submit} disabled={saving}
            className="w-full px-4 py-2.5 bg-violet-500 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-violet-400 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Agregar evidencia
          </button>
        </div>
      </div>
    </div>
  );
}
