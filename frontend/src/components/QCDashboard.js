import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck, Plus, X, Loader2, Search, RefreshCw,
  ArrowLeft, Pencil, Trash2, CheckCircle2, XCircle, AlertCircle,
  ClipboardList, TrendingUp, AlertTriangle, BadgeX, Camera, Image as ImageIcon,
  FileText, File as FileIcon, FileSpreadsheet, Link2
} from 'lucide-react';
import { API } from '../lib/constants';
import { useTheme } from '../contexts/ThemeContext';
import { cn } from '../lib/utils';
import { toast } from 'sonner';
import { Toaster } from 'sonner';

// ─── Constants ───────────────────────────────────────────────────────────────

const FINDING_TYPES = [
  { value: 'COSTURA',     label: 'Costura / Seam' },
  { value: 'SERIGRAFIA',  label: 'Serigrafía / Print' },
  { value: 'TELA',        label: 'Tela / Blank' },
  { value: 'MEDIDAS',     label: 'Medidas / Measurements' },
  { value: 'ETIQUETA',    label: 'Etiqueta / Label' },
  { value: 'EMPAQUE',     label: 'Empaque / Packaging' },
  { value: 'OTHER',       label: 'Otro / Other' },
];

const SEVERITIES = [
  { value: 'CRITICAL', label: 'Crítico',  color: 'text-red-500',    bg: 'bg-red-500/10 border-red-500/30' },
  { value: 'MAJOR',    label: 'Mayor',    color: 'text-orange-500', bg: 'bg-orange-500/10 border-orange-500/30' },
  { value: 'MINOR',    label: 'Menor',    color: 'text-yellow-500', bg: 'bg-yellow-500/10 border-yellow-500/30' },
];

const RESULTS = [
  { value: 'PASS',        label: 'Aprobado',    icon: CheckCircle2, color: 'text-green-500',  activeBg: 'bg-green-500 text-white', inactiveBg: 'bg-green-500/10 text-green-600 border border-green-500/30' },
  { value: 'CONDITIONAL', label: 'Condicional', icon: AlertCircle,  color: 'text-yellow-500', activeBg: 'bg-yellow-500 text-white', inactiveBg: 'bg-yellow-500/10 text-yellow-600 border border-yellow-500/30' },
  { value: 'FAIL',        label: 'Rechazado',   icon: XCircle,      color: 'text-red-500',    activeBg: 'bg-red-500 text-white',   inactiveBg: 'bg-red-500/10 text-red-600 border border-red-500/30' },
];

const EMPTY_FORM = {
  order_number: '', client: '',
  request_date: new Date().toISOString().split('T')[0],
  inspection_date: new Date().toISOString().split('T')[0],
  finding_type: 'COSTURA', severity: 'MINOR', result: 'PASS',
  quantity_inspected: '', quantity_rejected: '', findings: '', corrective_action: '',
  quantity: '', job_title_a: '',
};

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color, isDark }) {
  return (
    <div className={cn(
      "rounded-xl border p-5 flex items-center gap-4",
      isDark ? "bg-navy-dark border-white/8" : "bg-white border-slate-200 shadow-sm"
    )}>
      <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0", color)}>
        <Icon className="w-6 h-6" />
      </div>
      <div>
        <p className={cn("text-2xl font-bold font-barlow", isDark ? "text-white" : "text-navy")}>{value}</p>
        <p className={cn("text-xs font-semibold uppercase tracking-wide", isDark ? "text-white/50" : "text-slate-500")}>{label}</p>
        {sub && <p className={cn("text-[11px] mt-0.5", isDark ? "text-white/40" : "text-slate-400")}>{sub}</p>}
      </div>
    </div>
  );
}

function SeverityBadge({ value }) {
  const s = SEVERITIES.find(x => x.value === value) || SEVERITIES[2];
  return (
    <span className={cn("px-2 py-0.5 rounded text-[11px] font-bold border", s.bg, s.color)}>
      {s.label}
    </span>
  );
}

function ResultBadge({ value }) {
  const r = RESULTS.find(x => x.value === value) || RESULTS[0];
  const Icon = r.icon;
  return (
    <span className={cn("flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold", r.inactiveBg)}>
      <Icon className="w-3 h-3" />{r.label}
    </span>
  );
}

function renderRichContent(content, isDark) {
  if (!content) return null;
  const parts = content.split(/(\[img\].*?\[\/img\])/g);
  return parts.map((part, i) => {
    if (part.startsWith('[img]')) {
      const key = part.replace('[img]', '').replace('[/img]', '');
      const src = (key.startsWith('http') || key.startsWith('/api/uploads/')) ? key : `${API}/uploads/${key}`;
      return (
        <div key={i} className="my-2 group relative inline-block">
          <img 
            src={src} 
            alt="Evidencia" 
            className="max-w-full max-h-48 rounded-lg border border-white/10 cursor-pointer hover:opacity-90 transition-opacity shadow-lg"
            onClick={(e) => { e.stopPropagation(); window.open(src, '_blank'); }}
          />
        </div>
      );
    }
    return <span key={i} className="whitespace-pre-wrap">{part}</span>;
  });
}

function QCDetailModal({ open, onClose, record, isDark }) {
  if (!open || !record) return null;
  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div className={cn(
        "relative w-full max-w-3xl rounded-2xl border shadow-2xl overflow-hidden flex flex-col",
        isDark ? "bg-[#0d1520] border-white/10" : "bg-white border-slate-200"
      )}>
        <div className={cn("flex items-center justify-between px-6 py-4 border-b", isDark ? "border-white/8" : "border-slate-100")}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-royal/10 flex items-center justify-center">
              <ClipboardList className="w-5 h-5 text-royal" />
            </div>
            <div>
              <h2 className={cn("font-bold text-base", isDark ? "text-white" : "text-navy")}>Detalles de Inspección</h2>
              <p className={cn("text-[11px] uppercase tracking-wider font-bold", isDark ? "text-white/40" : "text-slate-400")}>
                Orden {record.order_number} — {record.client}
              </p>
            </div>
          </div>
          <button onClick={onClose} className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/60" : "hover:bg-slate-100 text-slate-400")}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-8 overflow-y-auto max-h-[70vh] space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-3 rounded-xl bg-white/5 border border-white/5">
              <p className="text-[10px] font-bold text-white/40 uppercase mb-1">Fecha</p>
              <p className="text-sm font-bold">{record.inspection_date}</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 border border-white/5">
              <p className="text-[10px] font-bold text-white/40 uppercase mb-1">Inspector</p>
              <p className="text-sm font-bold">{record.inspector}</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 border border-white/5">
              <p className="text-[10px] font-bold text-white/40 uppercase mb-1">Resultado</p>
              <ResultBadge value={record.result} />
            </div>
            <div className="p-3 rounded-xl bg-white/5 border border-white/5">
              <p className="text-[10px] font-bold text-white/40 uppercase mb-1">Severidad</p>
              <SeverityBadge value={record.severity} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-3 rounded-xl bg-white/5 border border-white/5">
              <p className="text-[10px] font-bold text-white/40 uppercase mb-1">Cantidad Total de la Orden (Qty)</p>
              <p className="text-sm font-bold text-royal">{record.quantity || '—'}</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 border border-white/5 overflow-hidden">
              <p className="text-[10px] font-bold text-white/40 uppercase mb-1">Job Title / Printavo</p>
              {(() => {
                const val = record.job_title_a;
                if (!val) return <p className="text-sm italic opacity-40">Sin enlace</p>;
                const url = typeof val === 'object' ? val.url : val;
                const desc = typeof val === 'object' ? val.desc : val;
                if (!url?.startsWith('http')) return <p className="text-sm font-medium truncate">{desc}</p>;
                return (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm font-bold text-royal hover:underline flex items-center gap-1.5 truncate">
                    <Link2 className="w-3.5 h-3.5" /> {desc}
                  </a>
                );
              })()}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-royal mb-2">Hallazgos e Imágenes</h3>
            <div className={cn("p-4 rounded-xl border", isDark ? "bg-white/5 border-white/10" : "bg-slate-50 border-slate-200")}>
              <div className="text-sm leading-relaxed">
                {renderRichContent(record.findings, isDark)}
              </div>
            </div>
          </div>

          {record.corrective_action && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-green-500 mb-2">Acción Correctiva</h3>
              <div className={cn("p-4 rounded-xl border", isDark ? "bg-white/5 border-white/10" : "bg-slate-50 border-slate-200")}>
                <p className="text-sm italic opacity-80">{record.corrective_action}</p>
              </div>
            </div>
          )}
        </div>

        <div className={cn("px-6 py-4 border-t flex justify-end", isDark ? "border-white/8" : "border-slate-100")}>
          <button onClick={onClose} className="px-6 py-2 bg-royal text-white rounded-xl font-bold text-sm shadow-lg shadow-royal/20 active:scale-95 transition-all">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Form Modal ───────────────────────────────────────────────────────────────

function QCFormModal({ open, onClose, onSaved, editRecord, isDark }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [resolvedOrderId, setResolvedOrderId] = useState(editRecord?.order_id || '');
  const [imagePreviews, setImagePreviews] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = React.useRef(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  useEffect(() => {
    if (editRecord) {
      setForm({
        order_number: editRecord.order_number || '',
        client: editRecord.client || '',
        request_date: editRecord.request_date || new Date().toISOString().split('T')[0],
        inspection_date: editRecord.inspection_date || new Date().toISOString().split('T')[0],
        finding_type: editRecord.finding_type || 'COSTURA',
        severity: editRecord.severity || 'MINOR',
        result: editRecord.result || 'PASS',
        quantity_inspected: editRecord.quantity_inspected ?? '',
        quantity_rejected: editRecord.quantity_rejected ?? '',
        findings: editRecord.findings || '',
        corrective_action: editRecord.corrective_action || '',
        quantity: editRecord.quantity || '',
        job_title_a: editRecord.job_title_a || '',
      });
    } else {
      setForm({ ...EMPTY_FORM, request_date: new Date().toISOString().split('T')[0], inspection_date: new Date().toISOString().split('T')[0] });
    }
    setImagePreviews([]);
    setIsDragging(false);
    setResolvedOrderId(editRecord?.order_id || '');
  }, [editRecord, open]);

  const processFiles = (files) => {
    const fileList = Array.from(files);
    const imageFiles = fileList.filter(f => {
      if (f.type && f.type.startsWith('image/')) return true;
      const ext = (f.name || '').toLowerCase().split('.').pop();
      return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(ext);
    });

    // We only support images for now to match the user's "same logic" request for evidence
    imageFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const rawDataUrl = event.target.result;
        if (file.size > 512 * 1024) {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            let { width, height } = img;
            const MAX_DIM = 1920;
            if (width > MAX_DIM || height > MAX_DIM) {
              const scale = MAX_DIM / Math.max(width, height);
              width = Math.round(width * scale);
              height = Math.round(height * scale);
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            const name = file.name ? file.name.replace(/\.[^.]+$/, '.jpg') : `qc_${Date.now()}.jpg`;
            setImagePreviews(prev => [...prev, { data: dataUrl, name, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, isImage: true }]);
          };
          img.src = rawDataUrl;
        } else {
          const name = file.name || `qc_${Date.now()}.jpg`;
          setImagePreviews(prev => [...prev, { data: rawDataUrl, name, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, isImage: true }]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFileUpload = (e) => {
    if (e.target.files && e.target.files.length > 0) processFiles(e.target.files);
    setFileInputKey(prev => prev + 1);
  };

  const removeImage = (id) => setImagePreviews(prev => prev.filter(img => img.id !== id));
  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); };
  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    if (e.dataTransfer.files?.length > 0) processFiles(e.dataTransfer.files);
  };

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const lookupOrder = async () => {
    if (!form.order_number.trim()) return;
    setLookingUp(true);
    try {
      const res = await fetch(`${API}/orders?search=${encodeURIComponent(form.order_number.trim())}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const orders = data.orders || data;
        if (orders.length > 0) {
          const o = orders[0];
          setForm(f => ({ 
            ...f, 
            client: o.client || '', 
            quantity: o.quantity || '', 
            job_title_a: o.job_title_a || '' 
          }));
          setResolvedOrderId(o.order_id || '');
          toast.success(`Orden encontrada: ${o.client || ''}`);
        } else {
          toast.warning('Orden no encontrada');
          setResolvedOrderId('');
        }
      }
    } catch { /* silent */ }
    finally { setLookingUp(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.findings.trim()) { toast.error('Escribe los hallazgos'); return; }
    setSaving(true);
    try {
      let finalFindings = form.findings.trim();
      
      // Upload images if there's an order_id
      if (imagePreviews.length > 0) {
        if (!resolvedOrderId) {
          toast.error("Se necesita una orden válida para subir imágenes");
          setSaving(false); return;
        }
        
        for (const img of imagePreviews) {
          try {
            const body = { image_data: img.data, filename: img.name };
            const imgRes = await fetch(`${API}/orders/${resolvedOrderId}/images`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
              body: JSON.stringify(body)
            });
            if (imgRes.ok) {
              const imgData = await imgRes.json();
              const key = imgData.storage_key || imgData.url;
              finalFindings = finalFindings ? `${finalFindings}\n[img]${key}[/img]` : `[img]${key}[/img]`;
            } else {
              toast.error(`Error subiendo ${img.name}`);
            }
          } catch {
            toast.error(`Error de conexion subiendo ${img.name}`);
          }
        }
      }

      const url = editRecord ? `${API}/qc/${editRecord.qc_id}` : `${API}/qc`;
      const method = editRecord ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          findings: finalFindings,
          quantity_inspected: Number(form.quantity_inspected) || 0,
          quantity_rejected: Number(form.quantity_rejected) || 0,
        }),
      });
      if (res.ok) {
        const saved = await res.json();
        toast.success(editRecord ? 'Inspección actualizada' : 'Inspección registrada');
        onSaved(saved);
        onClose();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al guardar');
      }
    } catch { toast.error('Error de conexión'); }
    finally { setSaving(false); }
  };

  if (!open) return null;

  const inputCls = cn(
    "w-full px-3 py-2 rounded-lg border text-sm outline-none transition-colors",
    isDark
      ? "bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-royal"
      : "bg-white border-slate-200 text-navy placeholder:text-slate-400 focus:border-royal"
  );

  const labelCls = cn("block text-[11px] font-bold uppercase tracking-wide mb-1", isDark ? "text-white/50" : "text-slate-500");

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={cn(
        "relative w-full max-w-2xl rounded-2xl border shadow-2xl overflow-hidden",
        isDark ? "bg-[#0d1929] border-white/10" : "bg-white border-slate-200"
      )}>
        {/* Modal header */}
        <div className={cn("flex items-center justify-between px-6 py-4 border-b", isDark ? "border-white/8" : "border-slate-100")}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-royal/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-royal" />
            </div>
            <div>
              <h2 className={cn("font-bold text-base", isDark ? "text-white" : "text-navy")}>
                {editRecord ? 'Editar Inspección' : 'Nueva Inspección QC'}
              </h2>
              <p className={cn("text-[11px]", isDark ? "text-white/40" : "text-slate-400")}>
                Registro de hallazgo de calidad
              </p>
            </div>
          </div>
          <button onClick={onClose} className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/60" : "hover:bg-slate-100 text-slate-400")}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form 
          onSubmit={handleSubmit} 
          className="px-6 py-5 space-y-4 max-h-[75vh] overflow-y-auto"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="absolute inset-x-6 top-[72px] bottom-[80px] z-50 border-2 border-dashed border-royal rounded-xl bg-royal/5 flex flex-col items-center justify-center backdrop-blur-[2px] transition-all">
              <Camera className="w-10 h-10 mb-2 text-royal animate-bounce" />
              <p className="text-sm text-royal font-bold uppercase tracking-widest">Suelta las imágenes de evidencia aquí</p>
            </div>
          )}

          {/* Row 1: Order + Client */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Orden #</label>
              <div className="relative">
                <input
                  className={cn(inputCls, "pr-8")}
                  value={form.order_number}
                  onChange={e => set('order_number', e.target.value)}
                  onBlur={lookupOrder}
                  placeholder="Ej: 1091"
                />
                {lookingUp && <Loader2 className="absolute right-2 top-2.5 w-4 h-4 animate-spin text-royal" />}
              </div>
            </div>
            <div>
              <label className={labelCls}>Cliente</label>
              <input className={inputCls} value={form.client} onChange={e => set('client', e.target.value)} placeholder="Nombre del cliente" />
            </div>
          </div>

          {/* Row 2: Fecha Creación + Fecha Inspección */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Fecha de Creación</label>
              <input type="date" className={cn(inputCls, "bg-secondary/30")} value={form.request_date} readOnly />
            </div>
            <div>
              <label className={labelCls}>Fecha Inspección</label>
              <input type="date" className={inputCls} value={form.inspection_date} onChange={e => set('inspection_date', e.target.value)} />
            </div>
          </div>
          
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Cantidad Total (Qty)</label>
              <input className={cn(inputCls, "bg-secondary/30")} value={form.quantity} readOnly placeholder="—" />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Job Title / Printavo</label>
              <div className={cn(inputCls, "bg-secondary/30 flex items-center gap-2 truncate")}>
                {(() => {
                  const val = form.job_title_a;
                  if (!val) return <span className="opacity-40 italic">Sin enlace</span>;
                  const url = typeof val === 'object' ? val.url : val;
                  const desc = typeof val === 'object' ? val.desc : val;
                  if (!url?.startsWith('http')) return <span className="truncate">{desc}</span>;
                  return (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="text-royal hover:underline flex items-center gap-1 truncate font-semibold">
                      <Link2 className="w-3 h-3" /> {desc}
                    </a>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Row 2: Finding Type + Severity */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Tipo de Defecto</label>
              <select className={inputCls} value={form.finding_type} onChange={e => set('finding_type', e.target.value)}>
                {FINDING_TYPES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Severidad</label>
              <select className={inputCls} value={form.severity} onChange={e => set('severity', e.target.value)}>
                {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>

          {/* Row 3: Result selector */}
          <div>
            <label className={labelCls}>Resultado</label>
            <div className="flex gap-2 mt-1">
              {RESULTS.map(r => {
                const Icon = r.icon;
                const active = form.result === r.value;
                return (
                  <button
                    type="button"
                    key={r.value}
                    onClick={() => set('result', r.value)}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-sm transition-all border",
                      active ? r.activeBg + " border-transparent" : (isDark ? "border-white/10 text-white/50 hover:border-white/20" : "border-slate-200 text-slate-400 hover:border-slate-300")
                    )}
                  >
                    <Icon className="w-4 h-4" />{r.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Row 4: Quantities */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Cantidad Inspeccionada</label>
              <input type="number" min="0" className={inputCls} value={form.quantity_inspected} onChange={e => set('quantity_inspected', e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className={labelCls}>Cantidad Rechazada</label>
              <input type="number" min="0" className={inputCls} value={form.quantity_rejected} onChange={e => set('quantity_rejected', e.target.value)} placeholder="0" />
            </div>
          </div>

          {/* Row 5: Findings */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelCls}>Descripción del Hallazgo <span className="text-red-500">*</span></label>
              <button 
                type="button" 
                onClick={() => fileInputRef.current?.click()}
                className={cn("flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold uppercase transition-colors", isDark ? "bg-white/10 text-white/70 hover:bg-white/20" : "bg-slate-100 text-slate-500 hover:bg-slate-200")}
              >
                <Camera className="w-3 h-3" /> Agregar Evidencia
              </button>
              <input key={fileInputKey} ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileUpload} className="hidden" />
            </div>
            <textarea
              className={cn(inputCls, "resize-none")}
              rows={3}
              value={form.findings}
              onChange={e => set('findings', e.target.value)}
              placeholder="Describe el defecto o hallazgo encontrado..."
            />
          </div>

          {/* Image Previews */}
          {imagePreviews.length > 0 && (
            <div className="flex flex-wrap gap-2 py-2">
              {imagePreviews.map(img => (
                <div key={img.id} className="relative group">
                  <img src={img.data} alt="" className="w-20 h-20 object-cover rounded-lg border border-white/10" />
                  <button 
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Row 6: Corrective action */}
          <div>
            <label className={labelCls}>Acción Correctiva</label>
            <textarea
              className={cn(inputCls, "resize-none")}
              rows={2}
              value={form.corrective_action}
              onChange={e => set('corrective_action', e.target.value)}
              placeholder="Acción tomada o recomendada..."
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className={cn("px-4 py-2 rounded-lg text-sm font-semibold transition-colors", isDark ? "bg-white/8 text-white/70 hover:bg-white/12" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}>
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="px-5 py-2 rounded-lg text-sm font-bold bg-royal text-white hover:bg-royal/90 transition-colors flex items-center gap-2 disabled:opacity-50">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {editRecord ? 'Guardar Cambios' : 'Registrar Inspección'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function QCDashboard() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [records, setRecords] = useState([]);
  const [stats, setStats] = useState({ total: 0, passed: 0, failed: 0, critical_findings: 0, pass_rate: 0 });
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [editRecord, setEditRecord] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // Filters
  const [search, setSearch] = useState('');
  const [filterResult, setFilterResult] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (filterResult) params.set('result', filterResult);
      if (filterSeverity) params.set('severity', filterSeverity);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);

      const [recRes, statRes] = await Promise.all([
        fetch(`${API}/qc?${params}`, { credentials: 'include' }),
        fetch(`${API}/qc/stats`, { credentials: 'include' }),
      ]);
      if (recRes.ok) setRecords(await recRes.json());
      if (statRes.ok) setStats(await statRes.json());
    } catch { toast.error('Error al cargar datos'); }
    finally { setLoading(false); }
  }, [search, filterResult, filterSeverity, dateFrom, dateTo]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleSaved = (saved) => {
    setRecords(prev => {
      const idx = prev.findIndex(r => r.qc_id === saved.qc_id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [saved, ...prev];
    });
    fetchAll();
  };

  const handleDelete = async (qcId) => {
    if (!window.confirm('¿Eliminar este registro de inspección?')) return;
    setDeleting(qcId);
    try {
      const res = await fetch(`${API}/qc/${qcId}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { setRecords(prev => prev.filter(r => r.qc_id !== qcId)); toast.success('Registro eliminado'); fetchAll(); }
      else toast.error('Error al eliminar');
    } catch { toast.error('Error de conexión'); }
    finally { setDeleting(null); }
  };

  const clearFilters = () => { setSearch(''); setFilterResult(''); setFilterSeverity(''); setDateFrom(''); setDateTo(''); };
  const hasFilters = search || filterResult || filterSeverity || dateFrom || dateTo;

  const base = isDark ? "bg-[#080f1a] text-white" : "bg-slate-50 text-navy";
  const cardBorder = isDark ? "border-white/8" : "border-slate-200";
  const inputCls = cn(
    "px-3 py-1.5 rounded-lg border text-sm outline-none transition-colors h-9",
    isDark ? "bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-royal" : "bg-white border-slate-200 text-navy placeholder:text-slate-400 focus:border-royal"
  );

  return (
    <div className={cn("min-h-screen flex flex-col", base)}>
      <Toaster position="bottom-right" theme={isDark ? 'dark' : 'light'} />

      {/* Header */}
      <div className={cn("border-b px-6 py-4 flex items-center justify-between", isDark ? "bg-navy-dark border-white/8" : "bg-white border-slate-200 shadow-sm")}>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/dashboard')} className={cn("p-2 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/60" : "hover:bg-slate-100 text-slate-500")}>
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-royal/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-royal" />
            </div>
            <div>
              <h1 className={cn("font-barlow font-bold text-lg leading-tight", isDark ? "text-white" : "text-navy")}>
                Control de Calidad
              </h1>
              <p className={cn("text-[11px]", isDark ? "text-white/40" : "text-slate-400")}>Registro de inspecciones y hallazgos QC</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchAll} disabled={loading} className={cn("p-2 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/50" : "hover:bg-slate-100 text-slate-400")}>
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
          <button
            onClick={() => { setEditRecord(null); setModalOpen(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-royal text-white rounded-xl font-bold text-sm hover:bg-royal/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Nueva Inspección
          </button>
        </div>
      </div>

      <div className="flex-1 px-6 py-6 space-y-6 max-w-7xl mx-auto w-full">

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard isDark={isDark} icon={ClipboardList} label="Total Inspecciones" value={stats.total} color="bg-royal/10 text-royal" />
          <StatCard isDark={isDark} icon={TrendingUp} label="Tasa de Aprobación" value={`${stats.pass_rate}%`} sub={`${stats.passed} aprobadas`} color="bg-green-500/10 text-green-500" />
          <StatCard isDark={isDark} icon={BadgeX} label="Rechazadas" value={stats.failed} color="bg-red-500/10 text-red-500" />
          <StatCard isDark={isDark} icon={AlertTriangle} label="Hallazgos Críticos" value={stats.critical_findings} color="bg-orange-500/10 text-orange-500" />
        </div>

        {/* Filters */}
        <div className={cn("rounded-xl border p-4", isDark ? "bg-navy-dark border-white/8" : "bg-white border-slate-200 shadow-sm")}>
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                className={cn(inputCls, "pl-9 w-full")}
                placeholder="Buscar orden o cliente..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select className={inputCls} value={filterResult} onChange={e => setFilterResult(e.target.value)}>
              <option value="">Todos los resultados</option>
              {RESULTS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <select className={inputCls} value={filterSeverity} onChange={e => setFilterSeverity(e.target.value)}>
              <option value="">Todas las severidades</option>
              {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <input type="date" className={inputCls} value={dateFrom} onChange={e => setDateFrom(e.target.value)} title="Desde" />
            <input type="date" className={inputCls} value={dateTo} onChange={e => setDateTo(e.target.value)} title="Hasta" />
            {hasFilters && (
              <button onClick={clearFilters} className={cn("flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-semibold transition-colors", isDark ? "bg-white/8 text-white/60 hover:bg-white/12" : "bg-slate-100 text-slate-500 hover:bg-slate-200")}>
                <X className="w-3.5 h-3.5" /> Limpiar
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className={cn("rounded-xl border overflow-hidden", isDark ? "bg-navy-dark border-white/8" : "bg-white border-slate-200 shadow-sm")}>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-royal" />
            </div>
          ) : records.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <ShieldCheck className={cn("w-12 h-12", isDark ? "text-white/20" : "text-slate-300")} />
              <p className={cn("text-sm font-medium", isDark ? "text-white/40" : "text-slate-400")}>
                {hasFilters ? 'No hay registros que coincidan con los filtros' : 'No hay inspecciones registradas'}
              </p>
              {!hasFilters && (
                <button onClick={() => { setEditRecord(null); setModalOpen(true); }} className="mt-2 px-4 py-2 bg-royal text-white rounded-lg text-sm font-bold hover:bg-royal/90 transition-colors">
                  Registrar primera inspección
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={cn("border-b text-[11px] font-bold uppercase tracking-wide", isDark ? "border-white/8 text-white/40" : "border-slate-100 text-slate-400")}>
                    {['Fecha', 'Orden', 'Cliente', 'Inspector', 'Tipo', 'Severidad', 'Resultado', 'Insp.', 'Rech.', 'Acciones'].map(h => (
                      <th key={h} className="text-left px-4 py-3 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {records.map(rec => (
                    <tr key={rec.qc_id} className={cn("transition-colors", isDark ? "hover:bg-white/3" : "hover:bg-slate-50/80")}>
                      <td className={cn("px-4 py-3 font-mono text-xs whitespace-nowrap", isDark ? "text-white/60" : "text-slate-500")}>
                        {rec.inspection_date || '—'}
                      </td>
                      <td className={cn("px-4 py-3 font-bold", isDark ? "text-white" : "text-navy")}>
                        {rec.order_number || '—'}
                      </td>
                      <td className={cn("px-4 py-3 max-w-[140px] truncate", isDark ? "text-white/80" : "text-slate-700")}>
                        {rec.client || '—'}
                      </td>
                      <td className={cn("px-4 py-3 text-xs max-w-[120px] truncate", isDark ? "text-white/60" : "text-slate-500")}>
                        {rec.inspector || '—'}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <span className={cn("px-2 py-0.5 rounded font-semibold", isDark ? "bg-white/8 text-white/70" : "bg-slate-100 text-slate-600")}>
                          {FINDING_TYPES.find(f => f.value === rec.finding_type)?.label?.split(' / ')[0] || rec.finding_type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <SeverityBadge value={rec.severity} />
                      </td>
                      <td className="px-4 py-3">
                        <ResultBadge value={rec.result} />
                      </td>
                      <td className={cn("px-4 py-3 text-center font-mono text-xs", isDark ? "text-white/60" : "text-slate-500")}>
                        {rec.quantity_inspected ?? '—'}
                      </td>
                      <td className={cn("px-4 py-3 text-center font-mono text-xs", rec.quantity_rejected > 0 ? "text-red-500 font-bold" : isDark ? "text-white/60" : "text-slate-500")}>
                        {rec.quantity_rejected ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => { setSelectedRecord(rec); setDetailModalOpen(true); }}
                            className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/40 hover:text-white" : "hover:bg-slate-100 text-slate-400 hover:text-slate-700")}
                            title="Ver detalles"
                          >
                            <ImageIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => { setEditRecord(rec); setModalOpen(true); }}
                            className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/40 hover:text-white" : "hover:bg-slate-100 text-slate-400 hover:text-slate-700")}
                            title="Editar"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(rec.qc_id)}
                            disabled={deleting === rec.qc_id}
                            className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-red-500/20 text-white/30 hover:text-red-400" : "hover:bg-red-50 text-slate-300 hover:text-red-500")}
                            title="Eliminar"
                          >
                            {deleting === rec.qc_id
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <Trash2 className="w-3.5 h-3.5" />
                            }
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className={cn("px-4 py-2 border-t text-[11px]", isDark ? "border-white/5 text-white/30" : "border-slate-100 text-slate-400")}>
                {records.length} registro{records.length !== 1 ? 's' : ''}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Form Modal */}
      <QCFormModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditRecord(null); }}
        onSaved={handleSaved}
        editRecord={editRecord}
        isDark={isDark}
      />

      {/* Detail Modal */}
      <QCDetailModal
        open={detailModalOpen}
        onClose={() => { setDetailModalOpen(false); setSelectedRecord(null); }}
        record={selectedRecord}
        isDark={isDark}
      />
    </div>
  );
}
