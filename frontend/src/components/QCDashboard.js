import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck, Plus, X, Loader2, Search, RefreshCw,
  ArrowLeft, Pencil, Trash2, CheckCircle2, XCircle, AlertCircle,
  ClipboardList, BadgeX, Camera, Image as ImageIcon,
  Link2, Bell, Download, BarChart2, ChevronLeft, ChevronRight,
  History, Clock, Lock, LockOpen,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { API } from '../lib/constants';
import { useTheme } from '../contexts/ThemeContext';
import { cn } from '../lib/utils';
import { toast } from 'sonner';
import { Toaster } from 'sonner';

// ─── Constants ───────────────────────────────────────────────────────────────

const FINDING_TYPES = [
  { value: 'COSTURA',    label: 'Costura / Seam' },
  { value: 'SERIGRAFIA', label: 'Serigrafía / Print' },
  { value: 'TELA',       label: 'Tela / Blank' },
  { value: 'MEDIDAS',    label: 'Medidas / Measurements' },
  { value: 'ETIQUETA',   label: 'Etiqueta / Label' },
  { value: 'EMPAQUE',    label: 'Empaque / Packaging' },
  { value: 'OTHER',      label: 'Otro / Other' },
];

const SEVERITIES = [
  { value: 'CRITICAL', label: 'Crítico',  color: 'text-red-500',    bg: 'bg-red-500/10 border-red-500/30' },
  { value: 'MAJOR',    label: 'Mayor',    color: 'text-orange-500', bg: 'bg-orange-500/10 border-orange-500/30' },
  { value: 'MINOR',    label: 'Menor',    color: 'text-yellow-500', bg: 'bg-yellow-500/10 border-yellow-500/30' },
];

const RESULTS = [
  { value: 'PASS',        label: 'Aprobado',    icon: CheckCircle2, color: 'text-green-500',  activeBg: 'bg-green-500 text-white',   inactiveBg: 'bg-green-500/10 text-green-600 border border-green-500/30' },
  { value: 'CONDITIONAL', label: 'Condicional', icon: AlertCircle,  color: 'text-yellow-500', activeBg: 'bg-yellow-500 text-white',  inactiveBg: 'bg-yellow-500/10 text-yellow-600 border border-yellow-500/30' },
  { value: 'FAIL',        label: 'Rechazado',   icon: XCircle,      color: 'text-red-500',    activeBg: 'bg-red-500 text-white',     inactiveBg: 'bg-red-500/10 text-red-600 border border-red-500/30' },
];

const WRITE_ROLES = ['supersu', 'inspector_qc'];
const RELEASE_ROLES = ['supersu', 'inspector_qc'];

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
  const parts = content.split(/(\[img\].*?\[\/img\])/gs);
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

// ─── Notifications Panel ──────────────────────────────────────────────────────

function NotificationsPanel({ notifications, unread, onMarkRead, onMarkAllRead, isDark, onClose }) {
  return (
    <div className={cn(
      "absolute right-0 top-12 z-[300] w-80 rounded-xl border shadow-2xl overflow-hidden",
      isDark ? "bg-[#0d1520] border-white/10" : "bg-white border-slate-200"
    )}>
      <div className={cn("flex items-center justify-between px-4 py-3 border-b", isDark ? "border-white/8" : "border-slate-100")}>
        <span className={cn("font-bold text-sm", isDark ? "text-white" : "text-navy")}>
          Notificaciones QC {unread > 0 && <span className="ml-1 text-xs bg-red-500 text-white px-1.5 py-0.5 rounded-full">{unread}</span>}
        </span>
        {unread > 0 && (
          <button onClick={onMarkAllRead} className="text-[11px] text-royal hover:underline font-semibold">
            Marcar todas
          </button>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className={cn("py-8 text-center text-xs", isDark ? "text-white/30" : "text-slate-400")}>
            Sin notificaciones
          </div>
        ) : (
          notifications.map(n => {
            const isPass = n.result === 'PASS';
            const isFail = n.result === 'FAIL';
            return (
              <div
                key={n.notif_id}
                onClick={() => !n.read && onMarkRead(n.notif_id)}
                className={cn(
                  "px-4 py-3 border-b cursor-pointer transition-colors",
                  isDark ? "border-white/5 hover:bg-white/3" : "border-slate-50 hover:bg-slate-50",
                  !n.read && (isDark ? "bg-royal/5" : "bg-royal/3")
                )}
              >
                <div className="flex items-start gap-2">
                  <div className={cn("mt-0.5 w-2 h-2 rounded-full flex-shrink-0", isFail ? "bg-red-500" : "bg-yellow-500")} />
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-xs font-bold truncate", isDark ? "text-white" : "text-navy")}>
                      Orden {n.order_number} — {n.client || '—'}
                    </p>
                    <p className={cn("text-[11px] mt-0.5", isDark ? "text-white/50" : "text-slate-500")}>
                      Resultado: <span className={isFail ? "text-red-500 font-bold" : "text-yellow-500 font-bold"}>{n.result}</span>
                      {' · '}{n.inspector}
                    </p>
                    <p className={cn("text-[10px] mt-0.5", isDark ? "text-white/30" : "text-slate-400")}>
                      {n.created_at ? n.created_at.split('T')[0] : ''}
                    </p>
                  </div>
                  {!n.read && <div className="w-1.5 h-1.5 bg-royal rounded-full mt-1 flex-shrink-0" />}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── History Panel (inside detail modal) ─────────────────────────────────────

function QCHistoryPanel({ qcId, isDark }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/qc/${qcId}/history`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [qcId]);

  const FIELD_LABELS = {
    finding_type: 'Tipo de Defecto', severity: 'Severidad', result: 'Resultado',
    quantity_inspected: 'Cant. Inspeccionada', quantity_rejected: 'Cant. Rechazada',
    findings: 'Hallazgos', corrective_action: 'Acción Correctiva',
    client: 'Cliente', request_date: 'Fecha Creación',
    inspection_date: 'Fecha Inspección', quantity: 'Cantidad', job_title_a: 'Job Title',
  };

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-royal" /></div>;

  const entries = data?.history || [];

  return (
    <div className="space-y-3">
      {/* Creation entry */}
      <div className={cn("flex gap-3 p-3 rounded-xl border", isDark ? "bg-white/3 border-white/5" : "bg-slate-50 border-slate-100")}>
        <div className="w-7 h-7 rounded-full bg-royal/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Plus className="w-3.5 h-3.5 text-royal" />
        </div>
        <div>
          <p className={cn("text-xs font-bold", isDark ? "text-white" : "text-navy")}>Registro creado por {data?.created_by || '—'}</p>
          <p className={cn("text-[10px] mt-0.5", isDark ? "text-white/40" : "text-slate-400")}>
            {data?.created_at ? data.created_at.split('T')[0] : '—'}
          </p>
        </div>
      </div>

      {entries.length === 0 && (
        <p className={cn("text-xs text-center py-4", isDark ? "text-white/30" : "text-slate-400")}>
          Sin modificaciones registradas
        </p>
      )}

      {entries.map(entry => (
        <div key={entry.history_id} className={cn("flex gap-3 p-3 rounded-xl border", isDark ? "bg-white/3 border-white/5" : "bg-slate-50 border-slate-100")}>
          <div className="w-7 h-7 rounded-full bg-yellow-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Pencil className="w-3.5 h-3.5 text-yellow-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className={cn("text-xs font-bold", isDark ? "text-white" : "text-navy")}>{entry.changed_by}</p>
              <p className={cn("text-[10px] flex-shrink-0", isDark ? "text-white/40" : "text-slate-400")}>
                {entry.changed_at ? entry.changed_at.split('T')[0] : '—'}
              </p>
            </div>
            <div className="mt-1.5 space-y-1">
              {Object.entries(entry.changes || {}).map(([field, change]) => (
                <div key={field} className={cn("text-[11px] px-2 py-1 rounded", isDark ? "bg-white/5" : "bg-white border border-slate-100")}>
                  <span className={cn("font-semibold", isDark ? "text-white/60" : "text-slate-500")}>
                    {FIELD_LABELS[field] || field}:
                  </span>{' '}
                  <span className="line-through opacity-50">{String(change.from ?? '—')}</span>
                  {' → '}
                  <span className={cn("font-bold", isDark ? "text-white" : "text-navy")}>
                    {String(change.to ?? '—')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────

function QCDetailModal({ open, onClose, record, isDark }) {
  const [tab, setTab] = useState('details');

  useEffect(() => { if (open) setTab('details'); }, [open]);

  if (!open || !record) return null;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div className={cn(
        "relative w-full max-w-3xl rounded-2xl border shadow-2xl overflow-hidden flex flex-col",
        isDark ? "bg-[#0d1520] border-white/10" : "bg-white border-slate-200"
      )}>
        {/* Header */}
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

        {/* Tab bar */}
        <div className={cn("flex border-b", isDark ? "border-white/8" : "border-slate-100")}>
          {[
            { id: 'details', label: 'Detalles', icon: ClipboardList },
            { id: 'history', label: 'Historial', icon: History },
          ].map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-2 px-5 py-2.5 text-sm font-semibold border-b-2 transition-colors",
                  tab === t.id
                    ? "border-royal text-royal"
                    : cn("border-transparent", isDark ? "text-white/40 hover:text-white/70" : "text-slate-400 hover:text-slate-600")
                )}
              >
                <Icon className="w-3.5 h-3.5" />{t.label}
              </button>
            );
          })}
        </div>

        <div className="p-6 overflow-y-auto max-h-[65vh]">
          {tab === 'details' ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Fecha', value: record.inspection_date },
                  { label: 'Inspector', value: record.inspector },
                  { label: 'Resultado', value: <ResultBadge value={record.result} /> },
                  { label: 'Severidad', value: <SeverityBadge value={record.severity} /> },
                ].map(item => (
                  <div key={item.label} className={cn("p-3 rounded-xl border", isDark ? "bg-white/5 border-white/5" : "bg-slate-50 border-slate-100")}>
                    <p className={cn("text-[10px] font-bold uppercase mb-1", isDark ? "text-white/40" : "text-slate-400")}>{item.label}</p>
                    {typeof item.value === 'string'
                      ? <p className="text-sm font-bold">{item.value}</p>
                      : item.value}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className={cn("p-3 rounded-xl border", isDark ? "bg-white/5 border-white/5" : "bg-slate-50 border-slate-100")}>
                  <p className={cn("text-[10px] font-bold uppercase mb-1", isDark ? "text-white/40" : "text-slate-400")}>Insp. / Rechazadas</p>
                  <p className="text-sm font-bold">
                    {record.quantity_inspected ?? '—'}
                    <span className="text-white/30 mx-1">/</span>
                    <span className={record.quantity_rejected > 0 ? "text-red-500" : ""}>{record.quantity_rejected ?? '—'}</span>
                  </p>
                </div>
                <div className={cn("p-3 rounded-xl border", isDark ? "bg-white/5 border-white/5" : "bg-slate-50 border-slate-100")}>
                  <p className={cn("text-[10px] font-bold uppercase mb-1", isDark ? "text-white/40" : "text-slate-400")}>Cantidad Total</p>
                  <p className="text-sm font-bold text-royal">{record.quantity || '—'}</p>
                </div>
                <div className={cn("p-3 rounded-xl border overflow-hidden", isDark ? "bg-white/5 border-white/5" : "bg-slate-50 border-slate-100")}>
                  <p className={cn("text-[10px] font-bold uppercase mb-1", isDark ? "text-white/40" : "text-slate-400")}>Job Title / Printavo</p>
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
          ) : (
            <QCHistoryPanel qcId={record.qc_id} isDark={isDark} />
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

function QCFormModal({ open, onClose, onSaved, editRecord, prefillOrder, isDark }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [resolvedOrderId, setResolvedOrderId] = useState(editRecord?.order_id || '');
  const [imagePreviews, setImagePreviews] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    if (editRecord) {
      setForm({
        order_number: editRecord.order_number || '',
        client: editRecord.client || '',
        request_date: editRecord.request_date || today,
        inspection_date: editRecord.inspection_date || today,
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
      setResolvedOrderId(editRecord.order_id || '');
    } else if (prefillOrder) {
      setForm({
        ...EMPTY_FORM,
        order_number: prefillOrder.order_number || '',
        client: prefillOrder.client || '',
        quantity: prefillOrder.quantity || '',
        job_title_a: prefillOrder.job_title_a || '',
        request_date: today,
        inspection_date: today,
      });
      setResolvedOrderId(prefillOrder.order_id || '');
    } else {
      setForm({ ...EMPTY_FORM, request_date: today, inspection_date: today });
      setResolvedOrderId('');
    }
    setImagePreviews([]);
    setIsDragging(false);
  }, [editRecord, prefillOrder, open]);

  const processFiles = (files) => {
    Array.from(files).filter(f => {
      if (f.type?.startsWith('image/')) return true;
      const ext = (f.name || '').toLowerCase().split('.').pop();
      return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(ext);
    }).forEach(file => {
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
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            const name = file.name ? file.name.replace(/\.[^.]+$/, '.jpg') : `qc_${Date.now()}.jpg`;
            setImagePreviews(prev => [...prev, { data: dataUrl, name, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, isImage: true }]);
          };
          img.src = rawDataUrl;
        } else {
          setImagePreviews(prev => [...prev, { data: rawDataUrl, name: file.name || `qc_${Date.now()}.jpg`, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, isImage: true }]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFileUpload = (e) => { if (e.target.files?.length > 0) processFiles(e.target.files); setFileInputKey(prev => prev + 1); };
  const removeImage = (id) => setImagePreviews(prev => prev.filter(img => img.id !== id));
  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); };
  const handleDrop = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); if (e.dataTransfer.files?.length > 0) processFiles(e.dataTransfer.files); };

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
          setForm(f => ({ ...f, client: o.client || '', quantity: o.quantity || '', job_title_a: o.job_title_a || '' }));
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
      if (imagePreviews.length > 0) {
        if (!resolvedOrderId) { toast.error("Se necesita una orden válida para subir imágenes"); setSaving(false); return; }
        for (const img of imagePreviews) {
          try {
            const imgRes = await fetch(`${API}/orders/${resolvedOrderId}/images`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
              body: JSON.stringify({ image_data: img.data, filename: img.name }),
            });
            if (imgRes.ok) {
              const imgData = await imgRes.json();
              const key = imgData.storage_key || imgData.url;
              finalFindings = finalFindings ? `${finalFindings}\n[img]${key}[/img]` : `[img]${key}[/img]`;
            } else {
              toast.error(`Error subiendo ${img.name}`);
            }
          } catch { toast.error(`Error de conexion subiendo ${img.name}`); }
        }
      }
      const url = editRecord ? `${API}/qc/${editRecord.qc_id}` : `${API}/qc`;
      const res = await fetch(url, {
        method: editRecord ? 'PUT' : 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form, findings: finalFindings,
          quantity_inspected: Number(form.quantity_inspected) || 0,
          quantity_rejected: Number(form.quantity_rejected) || 0,
        }),
      });
      if (res.ok) {
        toast.success(editRecord ? 'Inspección actualizada' : 'Inspección registrada');
        onSaved(await res.json());
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
    isDark ? "bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-royal" : "bg-white border-slate-200 text-navy placeholder:text-slate-400 focus:border-royal"
  );
  const labelCls = cn("block text-[11px] font-bold uppercase tracking-wide mb-1", isDark ? "text-white/50" : "text-slate-500");

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={cn("relative w-full max-w-2xl rounded-2xl border shadow-2xl overflow-hidden", isDark ? "bg-[#0d1929] border-white/10" : "bg-white border-slate-200")}>
        <div className={cn("flex items-center justify-between px-6 py-4 border-b", isDark ? "border-white/8" : "border-slate-100")}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-royal/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-royal" />
            </div>
            <div>
              <h2 className={cn("font-bold text-base", isDark ? "text-white" : "text-navy")}>
                {editRecord ? 'Editar Inspección' : 'Nueva Inspección QC'}
              </h2>
              <p className={cn("text-[11px]", isDark ? "text-white/40" : "text-slate-400")}>Registro de hallazgo de calidad</p>
            </div>
          </div>
          <button onClick={onClose} className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/60" : "hover:bg-slate-100 text-slate-400")}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 max-h-[75vh] overflow-y-auto" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
          {isDragging && (
            <div className="absolute inset-x-6 top-[72px] bottom-[80px] z-50 border-2 border-dashed border-royal rounded-xl bg-royal/5 flex flex-col items-center justify-center backdrop-blur-[2px]">
              <Camera className="w-10 h-10 mb-2 text-royal animate-bounce" />
              <p className="text-sm text-royal font-bold uppercase tracking-widest">Suelta las imágenes aquí</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Orden #</label>
              <div className="relative">
                <input className={cn(inputCls, "pr-8")} value={form.order_number} onChange={e => set('order_number', e.target.value)} onBlur={lookupOrder} placeholder="Ej: 1091" />
                {lookingUp && <Loader2 className="absolute right-2 top-2.5 w-4 h-4 animate-spin text-royal" />}
              </div>
            </div>
            <div>
              <label className={labelCls}>Cliente</label>
              <input className={inputCls} value={form.client} onChange={e => set('client', e.target.value)} placeholder="Nombre del cliente" />
            </div>
          </div>

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
              <label className={labelCls}>Cantidad Total</label>
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
                  return <a href={url} target="_blank" rel="noopener noreferrer" className="text-royal hover:underline flex items-center gap-1 truncate font-semibold"><Link2 className="w-3 h-3" /> {desc}</a>;
                })()}
              </div>
            </div>
          </div>

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

          <div>
            <label className={labelCls}>Resultado</label>
            <div className="flex gap-2 mt-1">
              {RESULTS.map(r => {
                const Icon = r.icon;
                const active = form.result === r.value;
                return (
                  <button type="button" key={r.value} onClick={() => set('result', r.value)}
                    className={cn("flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-sm transition-all border",
                      active ? r.activeBg + " border-transparent" : (isDark ? "border-white/10 text-white/50 hover:border-white/20" : "border-slate-200 text-slate-400 hover:border-slate-300"))}>
                    <Icon className="w-4 h-4" />{r.label}
                  </button>
                );
              })}
            </div>
          </div>

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

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelCls}>Descripción del Hallazgo <span className="text-red-500">*</span></label>
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className={cn("flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold uppercase transition-colors", isDark ? "bg-white/10 text-white/70 hover:bg-white/20" : "bg-slate-100 text-slate-500 hover:bg-slate-200")}>
                <Camera className="w-3 h-3" /> Agregar Evidencia
              </button>
              <input key={fileInputKey} ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileUpload} className="hidden" />
            </div>
            <textarea className={cn(inputCls, "resize-none")} rows={3} value={form.findings} onChange={e => set('findings', e.target.value)} placeholder="Describe el defecto o hallazgo encontrado..." />
          </div>

          {imagePreviews.length > 0 && (
            <div className="flex flex-wrap gap-2 py-2">
              {imagePreviews.map(img => (
                <div key={img.id} className="relative group">
                  <img src={img.data} alt="" className="w-20 h-20 object-cover rounded-lg border border-white/10" />
                  <button type="button" onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div>
            <label className={labelCls}>Acción Correctiva</label>
            <textarea className={cn(inputCls, "resize-none")} rows={2} value={form.corrective_action} onChange={e => set('corrective_action', e.target.value)} placeholder="Acción tomada o recomendada..." />
          </div>

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

// ─── Metrics Tab ──────────────────────────────────────────────────────────────

const CHART_COLORS = {
  pass: '#22c55e',
  fail: '#ef4444',
  conditional: '#eab308',
  total: '#3b82f6',
};

const TYPE_LABELS = Object.fromEntries(FINDING_TYPES.map(f => [f.value, f.label.split(' / ')[0]]));

function QCMetricsTab({ isDark }) {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/qc/metrics`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { setMetrics(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const tooltipStyle = isDark
    ? { backgroundColor: '#0d1520', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }
    : { backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-royal" /></div>;
  if (!metrics) return <div className="text-center py-20 text-sm opacity-40">No hay datos de métricas</div>;

  const byType = (metrics.by_type || []).map(d => ({ ...d, name: TYPE_LABELS[d.name] || d.name }));
  const byInspector = metrics.by_inspector || [];
  const byMonth = metrics.by_month || [];

  return (
    <div className="space-y-8 py-2">
      {/* Monthly trend */}
      <div>
        <h3 className={cn("text-xs font-bold uppercase tracking-widest mb-4", isDark ? "text-white/50" : "text-slate-400")}>
          Tendencia Mensual
        </h3>
        {byMonth.length === 0 ? (
          <p className={cn("text-sm text-center py-6", isDark ? "text-white/30" : "text-slate-400")}>Sin datos mensuales</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={byMonth} barCategoryGap="30%">
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: isDark ? 'rgba(255,255,255,0.4)' : '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: isDark ? 'rgba(255,255,255,0.4)' : '#94a3b8' }} axisLine={false} tickLine={false} width={28} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="pass" name="Aprobado" fill={CHART_COLORS.pass} radius={[3, 3, 0, 0]} />
              <Bar dataKey="conditional" name="Condicional" fill={CHART_COLORS.conditional} radius={[3, 3, 0, 0]} />
              <Bar dataKey="fail" name="Rechazado" fill={CHART_COLORS.fail} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* By defect type */}
      <div>
        <h3 className={cn("text-xs font-bold uppercase tracking-widest mb-4", isDark ? "text-white/50" : "text-slate-400")}>
          Por Tipo de Defecto
        </h3>
        {byType.length === 0 ? (
          <p className={cn("text-sm text-center py-6", isDark ? "text-white/30" : "text-slate-400")}>Sin datos</p>
        ) : (
          <div className="space-y-2">
            {byType.map(item => {
              const total = item.total || 1;
              return (
                <div key={item.name} className={cn("p-3 rounded-xl border", isDark ? "bg-white/3 border-white/5" : "bg-slate-50 border-slate-100")}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={cn("text-xs font-bold", isDark ? "text-white" : "text-navy")}>{item.name}</span>
                    <span className={cn("text-xs font-mono", isDark ? "text-white/50" : "text-slate-500")}>{item.total} inspecciones</span>
                  </div>
                  <div className="flex h-2 rounded-full overflow-hidden gap-px">
                    {item.pass > 0 && <div style={{ width: `${(item.pass / total) * 100}%`, background: CHART_COLORS.pass }} />}
                    {item.conditional > 0 && <div style={{ width: `${(item.conditional / total) * 100}%`, background: CHART_COLORS.conditional }} />}
                    {item.fail > 0 && <div style={{ width: `${(item.fail / total) * 100}%`, background: CHART_COLORS.fail }} />}
                  </div>
                  <div className="flex gap-3 mt-1.5">
                    {[['pass', 'Aprob.', CHART_COLORS.pass], ['conditional', 'Cond.', CHART_COLORS.conditional], ['fail', 'Rech.', CHART_COLORS.fail]].map(([k, lbl, color]) => (
                      <span key={k} className="flex items-center gap-1 text-[10px]" style={{ color }}>
                        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                        {lbl}: {item[k]}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* By inspector */}
      <div>
        <h3 className={cn("text-xs font-bold uppercase tracking-widest mb-4", isDark ? "text-white/50" : "text-slate-400")}>
          Por Inspector
        </h3>
        {byInspector.length === 0 ? (
          <p className={cn("text-sm text-center py-6", isDark ? "text-white/30" : "text-slate-400")}>Sin datos</p>
        ) : (
          <div className="space-y-2">
            {byInspector.map(item => {
              const total = item.total || 1;
              const passRate = Math.round((item.pass / total) * 100);
              return (
                <div key={item.name} className={cn("flex items-center gap-3 p-3 rounded-xl border", isDark ? "bg-white/3 border-white/5" : "bg-slate-50 border-slate-100")}>
                  <div className="w-8 h-8 rounded-full bg-royal/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-bold text-royal">{(item.name || '?')[0].toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-xs font-bold truncate", isDark ? "text-white" : "text-navy")}>{item.name || 'Desconocido'}</p>
                    <div className="flex gap-3 mt-0.5">
                      <span className="text-[10px] text-green-500">{item.pass} aprobadas</span>
                      <span className="text-[10px] text-red-500">{item.fail} rechazadas</span>
                      <span className="text-[10px] text-yellow-500">{item.conditional} cond.</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className={cn("text-sm font-bold", passRate >= 80 ? "text-green-500" : passRate >= 50 ? "text-yellow-500" : "text-red-500")}>
                      {passRate}%
                    </p>
                    <p className={cn("text-[10px]", isDark ? "text-white/30" : "text-slate-400")}>{item.total} total</p>
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

// ─── Pagination ───────────────────────────────────────────────────────────────

function Pagination({ page, pages, total, limit, onPage, isDark }) {
  if (pages <= 1) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <div className={cn("px-4 py-2.5 border-t flex items-center justify-between", isDark ? "border-white/5 text-white/40" : "border-slate-100 text-slate-400")}>
      <span className="text-[11px]">{from}–{to} de {total} registros</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(page - 1)} disabled={page <= 1}
          className={cn("p-1.5 rounded-lg transition-colors disabled:opacity-30", isDark ? "hover:bg-white/10" : "hover:bg-slate-100")}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-[11px] px-2 font-semibold">{page} / {pages}</span>
        <button
          onClick={() => onPage(page + 1)} disabled={page >= pages}
          className={cn("p-1.5 rounded-lg transition-colors disabled:opacity-30", isDark ? "hover:bg-white/10" : "hover:bg-slate-100")}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

const QC_TABS = [
  { id: 'general',     label: 'General',     icon: ClipboardList, countKey: null },
  { id: 'pass',        label: 'Aprobado',    icon: CheckCircle2,  countKey: 'passed',      activeText: 'text-green-400',  activeBorder: 'border-green-500' },
  { id: 'conditional', label: 'Condicional', icon: AlertCircle,   countKey: 'conditional', activeText: 'text-yellow-400', activeBorder: 'border-yellow-500' },
  { id: 'fail',        label: 'Rechazado',   icon: XCircle,       countKey: 'failed',      activeText: 'text-red-400',    activeBorder: 'border-red-500' },
  { id: 'metrics',     label: 'Métricas',    icon: BarChart2,     countKey: null,          activeText: 'text-purple-400', activeBorder: 'border-purple-500' },
];

const TAB_BORDER = { general: 'border-slate-400', pass: 'border-green-500', conditional: 'border-yellow-500', fail: 'border-red-500', metrics: 'border-purple-500' };
const TAB_TEXT  = { general: 'text-slate-300',    pass: 'text-green-400',   conditional: 'text-yellow-400',  fail: 'text-red-400',   metrics: 'text-purple-400' };
const RESULT_TAB_MAP = { PASS: 'pass', CONDITIONAL: 'conditional', FAIL: 'fail' };

export default function QCDashboard() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [currentUser, setCurrentUser] = useState(null);
  const [records, setRecords] = useState([]);
  const [unauditedOrders, setUnauditedOrders] = useState([]);
  const [stats, setStats] = useState({ total: 0, passed: 0, conditional: 0, failed: 0, critical_findings: 0, pass_rate: 0 });
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('general');
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [editRecord, setEditRecord] = useState(null);
  const [prefillOrder, setPrefillOrder] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [releasing, setReleasing] = useState(null);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalRecords, setTotalRecords] = useState(0);
  const PAGE_LIMIT = 50;

  // Filters
  const [search, setSearch] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Notifications
  const [notifications, setNotifications] = useState([]);
  const [unreadNotifs, setUnreadNotifs] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);

  const canWrite = currentUser && WRITE_ROLES.includes(currentUser.role);
  const canRelease = currentUser && RELEASE_ROLES.includes(currentUser.role);

  // Fetch current user
  useEffect(() => {
    fetch(`${API}/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => setCurrentUser(u))
      .catch(() => {});
  }, []);

  // Fetch notifications
  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch(`${API}/qc/notifications`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadNotifs(data.unread || 0);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  // Poll notifications every 30 seconds
  useEffect(() => {
    const id = setInterval(fetchNotifications, 30_000);
    return () => clearInterval(id);
  }, [fetchNotifications]);

  // Close notif dropdown on outside click
  useEffect(() => {
    const handler = (e) => { if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fetchAll = useCallback(async (pageOverride) => {
    setLoading(true);
    const currentPage = pageOverride ?? page;
    try {
      const statRes = await fetch(`${API}/qc/stats`, { credentials: 'include' });
      if (statRes.ok) setStats(await statRes.json());

      if (activeTab === 'general') {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        const res = await fetch(`${API}/qc/unaudited?${params}`, { credentials: 'include' });
        if (res.ok) setUnauditedOrders(await res.json());
      } else if (activeTab !== 'metrics') {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (filterSeverity) params.set('severity', filterSeverity);
        if (dateFrom) params.set('date_from', dateFrom);
        if (dateTo) params.set('date_to', dateTo);
        const resultMap = { pass: 'PASS', conditional: 'CONDITIONAL', fail: 'FAIL' };
        params.set('result', resultMap[activeTab]);
        params.set('page', currentPage);
        params.set('limit', PAGE_LIMIT);
        const res = await fetch(`${API}/qc?${params}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setRecords(data.records || []);
          setTotalPages(data.pages || 1);
          setTotalRecords(data.total || 0);
        }
      }
    } catch { toast.error('Error al cargar datos'); }
    finally { setLoading(false); }
  }, [search, activeTab, filterSeverity, dateFrom, dateTo, page]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handlePageChange = (newPage) => {
    setPage(newPage);
    fetchAll(newPage);
  };

  const handleTabChange = (tabId) => {
    setActiveTab(tabId);
    setPage(1);
    setSearch('');
    setFilterSeverity('');
    setDateFrom('');
    setDateTo('');
  };

  const handleSaved = (saved) => {
    setRecords(prev => {
      const idx = prev.findIndex(r => r.qc_id === saved.qc_id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [saved, ...prev];
    });
    if (saved.result && RESULT_TAB_MAP[saved.result]) setActiveTab(RESULT_TAB_MAP[saved.result]);
    fetchAll();
    fetchNotifications();
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

  const handleRelease = async (order) => {
    if (!window.confirm(`¿Liberar la orden ${order.order_number} del candado QC?\nEsto permitirá mover y editar la orden nuevamente.`)) return;
    setReleasing(order.order_id);
    try {
      const res = await fetch(`${API}/qc/orders/${order.order_id}/release`, { method: 'POST', credentials: 'include' });
      if (res.ok) {
        toast.success(`Orden ${order.order_number} liberada`);
        fetchAll();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al liberar');
      }
    } catch { toast.error('Error de conexión'); }
    finally { setReleasing(null); }
  };

  const openNewQC = (order = null) => {
    setEditRecord(null);
    setPrefillOrder(order);
    setModalOpen(true);
  };

  const handleMarkRead = async (notifId) => {
    await fetch(`${API}/qc/notifications/${notifId}/read`, { method: 'PUT', credentials: 'include' });
    fetchNotifications();
  };

  const handleMarkAllRead = async () => {
    await fetch(`${API}/qc/notifications/read-all`, { method: 'PUT', credentials: 'include' });
    fetchNotifications();
  };

  const handleExportCSV = () => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (filterSeverity) params.set('severity', filterSeverity);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (activeTab !== 'general' && activeTab !== 'metrics') {
      const resultMap = { pass: 'PASS', conditional: 'CONDITIONAL', fail: 'FAIL' };
      if (resultMap[activeTab]) params.set('result', resultMap[activeTab]);
    }
    window.open(`${API}/qc/export/csv?${params}`, '_blank');
  };

  const clearFilters = () => { setSearch(''); setFilterSeverity(''); setDateFrom(''); setDateTo(''); setPage(1); };
  const hasFilters = search || filterSeverity || dateFrom || dateTo;

  const base = isDark ? "bg-[#080f1a] text-white" : "bg-slate-50 text-navy";
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

          {/* Export button */}
          {activeTab !== 'general' && activeTab !== 'metrics' && (
            <button onClick={handleExportCSV} title="Exportar CSV"
              className={cn("p-2 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/50" : "hover:bg-slate-100 text-slate-400")}>
              <Download className="w-4 h-4" />
            </button>
          )}

          {/* Notifications bell */}
          <div className="relative" ref={notifRef}>
            <button
              onClick={() => setNotifOpen(o => !o)}
              className={cn("p-2 rounded-lg transition-colors relative", isDark ? "hover:bg-white/10 text-white/50" : "hover:bg-slate-100 text-slate-400")}
            >
              <Bell className="w-4 h-4" />
              {unreadNotifs > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {unreadNotifs > 9 ? '9+' : unreadNotifs}
                </span>
              )}
            </button>
            {notifOpen && (
              <NotificationsPanel
                notifications={notifications}
                unread={unreadNotifs}
                onMarkRead={handleMarkRead}
                onMarkAllRead={handleMarkAllRead}
                isDark={isDark}
                onClose={() => setNotifOpen(false)}
              />
            )}
          </div>

          {canWrite && (
            <button
              onClick={() => openNewQC(null)}
              className="flex items-center gap-2 px-4 py-2 bg-royal text-white rounded-xl font-bold text-sm hover:bg-royal/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Nueva Inspección
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 px-6 py-6 space-y-6 max-w-7xl mx-auto w-full">

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard isDark={isDark} icon={ClipboardList} label="Total Inspecciones" value={stats.total} color="bg-royal/10 text-royal" />
          <StatCard isDark={isDark} icon={CheckCircle2} label="Aprobadas" value={stats.passed} sub={`${stats.pass_rate}% tasa`} color="bg-green-500/10 text-green-500" />
          <StatCard isDark={isDark} icon={AlertCircle} label="Condicional" value={stats.conditional ?? 0} color="bg-yellow-500/10 text-yellow-500" />
          <StatCard isDark={isDark} icon={BadgeX} label="Rechazadas" value={stats.failed} color="bg-red-500/10 text-red-500" />
        </div>

        {/* Tabs + Content */}
        <div className={cn("rounded-xl border overflow-hidden", isDark ? "bg-navy-dark border-white/8" : "bg-white border-slate-200 shadow-sm")}>

          {/* Tab bar */}
          <div className={cn("flex border-b overflow-x-auto", isDark ? "border-white/8" : "border-slate-100")}>
            {QC_TABS.map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              const count = tab.countKey ? (stats[tab.countKey] ?? 0) : null;
              return (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={cn(
                    "flex-shrink-0 flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold transition-all border-b-2 whitespace-nowrap",
                    isActive
                      ? cn(TAB_BORDER[tab.id], TAB_TEXT[tab.id], isDark ? "bg-white/5" : "bg-slate-50/80")
                      : cn("border-transparent", isDark ? "text-white/40 hover:text-white/70" : "text-slate-400 hover:text-slate-600")
                  )}
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{tab.label}</span>
                  {count !== null && (
                    <span className={cn("px-1.5 py-0.5 rounded-full text-[10px] font-bold min-w-[18px] text-center bg-current/10")}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Filters (not on metrics tab) */}
          {activeTab !== 'metrics' && (
            <div className={cn("px-4 py-3 border-b flex flex-wrap gap-3 items-center", isDark ? "border-white/5" : "border-slate-50")}>
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input className={cn(inputCls, "pl-9 w-full")} placeholder="Buscar orden o cliente..." value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
              </div>
              {activeTab !== 'general' && (
                <>
                  <select className={inputCls} value={filterSeverity} onChange={e => { setFilterSeverity(e.target.value); setPage(1); }}>
                    <option value="">Todas las severidades</option>
                    {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  <input type="date" className={inputCls} value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} title="Desde" />
                  <input type="date" className={inputCls} value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} title="Hasta" />
                </>
              )}
              {hasFilters && (
                <button onClick={clearFilters} className={cn("flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-semibold transition-colors", isDark ? "bg-white/8 text-white/60 hover:bg-white/12" : "bg-slate-100 text-slate-500 hover:bg-slate-200")}>
                  <X className="w-3.5 h-3.5" /> Limpiar
                </button>
              )}
            </div>
          )}

          {/* Tab content */}
          {activeTab === 'metrics' ? (
            <div className="px-6 py-4">
              <QCMetricsTab isDark={isDark} />
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-royal" />
            </div>
          ) : activeTab === 'general' ? (
            unauditedOrders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <CheckCircle2 className={cn("w-12 h-12", isDark ? "text-green-500/30" : "text-green-300")} />
                <p className={cn("text-sm font-medium", isDark ? "text-white/40" : "text-slate-400")}>
                  {search ? 'No hay órdenes que coincidan' : 'Todas las órdenes han sido auditadas'}
                </p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className={cn("border-b text-[11px] font-bold uppercase tracking-wide", isDark ? "border-white/8 text-white/40" : "border-slate-100 text-slate-400")}>
                        {['', 'Orden', 'Cliente', 'Estatus', 'Cantidad', 'Fecha', 'Acción'].map(h => (
                          <th key={h} className="text-left px-4 py-3 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {unauditedOrders.map(order => (
                        <tr key={order.order_id} className={cn("transition-colors", isDark ? "hover:bg-white/3" : "hover:bg-slate-50/80")}>
                          <td className="px-3 py-3">
                            <Lock className={cn("w-3.5 h-3.5", isDark ? "text-yellow-400/70" : "text-yellow-500/80")} title="Orden bloqueada por QC" />
                          </td>
                          <td className={cn("px-4 py-3 font-bold", isDark ? "text-white" : "text-navy")}>{order.order_number || '—'}</td>
                          <td className={cn("px-4 py-3 max-w-[160px] truncate", isDark ? "text-white/80" : "text-slate-700")}>{order.client || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={cn("px-2 py-0.5 rounded text-[11px] font-semibold", isDark ? "bg-white/8 text-white/60" : "bg-slate-100 text-slate-600")}>
                              {order.status || '—'}
                            </span>
                          </td>
                          <td className={cn("px-4 py-3 font-mono text-xs", isDark ? "text-white/60" : "text-slate-500")}>{order.quantity || '—'}</td>
                          <td className={cn("px-4 py-3 font-mono text-xs whitespace-nowrap", isDark ? "text-white/50" : "text-slate-400")}>
                            {order.created_at ? order.created_at.split('T')[0] : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              {canWrite && (
                                <button onClick={() => openNewQC(order)}
                                  className="flex items-center gap-1.5 px-3 py-1.5 bg-royal/10 text-royal border border-royal/20 rounded-lg text-xs font-bold hover:bg-royal hover:text-white transition-all">
                                  <Plus className="w-3 h-3" /> Crear QC
                                </button>
                              )}
                              {canRelease && (
                                <button
                                  onClick={() => handleRelease(order)}
                                  disabled={releasing === order.order_id}
                                  className={cn("flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-bold transition-all",
                                    isDark ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20 hover:bg-yellow-500 hover:text-white" : "bg-yellow-50 text-yellow-600 border-yellow-200 hover:bg-yellow-500 hover:text-white")}
                                  title="Liberar orden del candado QC"
                                >
                                  {releasing === order.order_id
                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                    : <LockOpen className="w-3 h-3" />}
                                  Liberar
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className={cn("px-4 py-2 border-t text-[11px]", isDark ? "border-white/5 text-white/30" : "border-slate-100 text-slate-400")}>
                    {unauditedOrders.length} orden{unauditedOrders.length !== 1 ? 'es' : ''} sin auditar
                  </div>
                </div>
              </>
            )
          ) : (
            records.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <ShieldCheck className={cn("w-12 h-12", isDark ? "text-white/20" : "text-slate-300")} />
                <p className={cn("text-sm font-medium", isDark ? "text-white/40" : "text-slate-400")}>
                  {hasFilters ? 'No hay registros que coincidan con los filtros' : 'No hay inspecciones en esta categoría'}
                </p>
                {!hasFilters && canWrite && (
                  <button onClick={() => openNewQC(null)} className="mt-2 px-4 py-2 bg-royal text-white rounded-lg text-sm font-bold hover:bg-royal/90 transition-colors">
                    Registrar primera inspección
                  </button>
                )}
              </div>
            ) : (
              <>
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
                          <td className={cn("px-4 py-3 font-mono text-xs whitespace-nowrap", isDark ? "text-white/60" : "text-slate-500")}>{rec.inspection_date || '—'}</td>
                          <td className={cn("px-4 py-3 font-bold", isDark ? "text-white" : "text-navy")}>{rec.order_number || '—'}</td>
                          <td className={cn("px-4 py-3 max-w-[140px] truncate", isDark ? "text-white/80" : "text-slate-700")}>{rec.client || '—'}</td>
                          <td className={cn("px-4 py-3 text-xs max-w-[120px] truncate", isDark ? "text-white/60" : "text-slate-500")}>{rec.inspector || '—'}</td>
                          <td className="px-4 py-3 text-xs">
                            <span className={cn("px-2 py-0.5 rounded font-semibold", isDark ? "bg-white/8 text-white/70" : "bg-slate-100 text-slate-600")}>
                              {FINDING_TYPES.find(f => f.value === rec.finding_type)?.label?.split(' / ')[0] || rec.finding_type}
                            </span>
                          </td>
                          <td className="px-4 py-3"><SeverityBadge value={rec.severity} /></td>
                          <td className="px-4 py-3"><ResultBadge value={rec.result} /></td>
                          <td className={cn("px-4 py-3 text-center font-mono text-xs", isDark ? "text-white/60" : "text-slate-500")}>{rec.quantity_inspected ?? '—'}</td>
                          <td className={cn("px-4 py-3 text-center font-mono text-xs", rec.quantity_rejected > 0 ? "text-red-500 font-bold" : isDark ? "text-white/60" : "text-slate-500")}>{rec.quantity_rejected ?? '—'}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <button onClick={() => { setSelectedRecord(rec); setDetailModalOpen(true); }}
                                className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/40 hover:text-white" : "hover:bg-slate-100 text-slate-400 hover:text-slate-700")} title="Ver detalles">
                                <ImageIcon className="w-3.5 h-3.5" />
                              </button>
                              {canWrite && (
                                <>
                                  <button onClick={() => { setEditRecord(rec); setPrefillOrder(null); setModalOpen(true); }}
                                    className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/10 text-white/40 hover:text-white" : "hover:bg-slate-100 text-slate-400 hover:text-slate-700")} title="Editar">
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button onClick={() => handleDelete(rec.qc_id)} disabled={deleting === rec.qc_id}
                                    className={cn("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-red-500/20 text-white/30 hover:text-red-400" : "hover:bg-red-50 text-slate-300 hover:text-red-500")} title="Eliminar">
                                    {deleting === rec.qc_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={page}
                  pages={totalPages}
                  total={totalRecords}
                  limit={PAGE_LIMIT}
                  onPage={handlePageChange}
                  isDark={isDark}
                />
              </>
            )
          )}
        </div>
      </div>

      <QCFormModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditRecord(null); setPrefillOrder(null); }}
        onSaved={handleSaved}
        editRecord={editRecord}
        prefillOrder={prefillOrder}
        isDark={isDark}
      />

      <QCDetailModal
        open={detailModalOpen}
        onClose={() => { setDetailModalOpen(false); setSelectedRecord(null); }}
        record={selectedRecord}
        isDark={isDark}
      />
    </div>
  );
}
