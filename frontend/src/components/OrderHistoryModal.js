import React, { useState, useEffect } from 'react';
import { 
  X, History, FileText, Package, Factory, MessageSquare, 
  ChevronDown, ChevronUp, Download, Loader2, Calendar, 
  User, ArrowRight, ClipboardList
} from 'lucide-react';
import { API } from '../lib/constants';
import { useLang } from '../contexts/LanguageContext';
import { toast } from 'sonner';

const OrderHistoryModal = ({ order, isOpen, onClose }) => {
  const { t } = useLang();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (isOpen && order) {
      fetchHistory();
    }
  }, [isOpen, order]);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/reports/order-history/${order.order_id}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setHistory(data.history);
      } else {
        toast.error('Error al cargar historial');
      }
    } catch (err) {
      toast.error('Error de conexión');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPDF = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`${API}/reports/order-history/${order.order_id}/pdf`, { 
        method: 'POST', 
        credentials: 'include' 
      });
      if (res.ok) {
        const data = await res.json();
        const link = document.createElement('a');
        link.href = `data:${data.content_type};base64,${data.data}`;
        link.download = data.filename;
        link.click();
        toast.success('Reporte descargado correctamente');
      } else {
        toast.error('Error al generar PDF');
      }
    } catch (err) {
      toast.error('Error de conexión');
    } finally {
      setDownloading(false);
    }
  };

  if (!isOpen) return null;

  const getEventIcon = (type) => {
    switch (type) {
      case 'production': return <Factory className="w-4 h-4 text-emerald-400" />;
      case 'wms': return <Package className="w-4 h-4 text-blue-400" />;
      case 'comment': return <MessageSquare className="w-4 h-4 text-amber-400" />;
      case 'activity': return <History className="w-4 h-4 text-indigo-400" />;
      default: return <ClipboardList className="w-4 h-4 text-slate-400" />;
    }
  };

  const getEventBadgeClass = (type) => {
    switch (type) {
      case 'production': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'wms': return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case 'comment': return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      case 'activity': return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
      default: return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    }
  };

  const formatTimestamp = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-card border border-border/50 rounded-3xl w-full max-w-4xl max-h-[90vh] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="p-6 bg-secondary/30 border-b border-border/50 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary/20 rounded-2xl flex items-center justify-center border border-primary/30 shadow-lg shadow-primary/20">
              <ClipboardList className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-black uppercase tracking-tighter text-foreground">
                Reporte <span className="text-primary text-glow-primary">Extendido</span>
              </h2>
              <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest">
                PO: <span className="text-foreground">{order.order_number}</span> | {order.client}
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={handleDownloadPDF} 
              disabled={downloading}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-xs font-black uppercase tracking-widest hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-50"
            >
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Exportar PDF
            </button>
            <button 
              onClick={onClose} 
              className="p-2 hover:bg-secondary rounded-xl transition-all text-muted-foreground hover:text-foreground"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          
          {/* Executive Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Estado Actual', value: order.board, icon: FileText, color: 'text-indigo-400' },
              { label: 'Producción', value: order.production_status || 'N/A', icon: Factory, color: 'text-emerald-400' },
              { label: 'Cantidad', value: order.quantity || 0, icon: Package, color: 'text-blue-400' },
              { label: 'Fecha Entrega', value: order.due_date || 'N/A', icon: Calendar, color: 'text-amber-400' },
            ].map((stat, i) => (
              <div key={i} className="bg-secondary/20 border border-border/30 rounded-2xl p-4 flex flex-col gap-1">
                <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  <stat.icon className={`w-3 h-3 ${stat.color}`} /> {stat.label}
                </div>
                <div className="text-sm font-black truncate">{stat.value}</div>
              </div>
            ))}
          </div>

          {/* Timeline Section */}
          <div className="space-y-6 relative">
            <h3 className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground flex items-center gap-2">
              <History className="w-4 h-4" /> Historial de Vida de la Orden
            </h3>

            {loading ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <Loader2 className="w-10 h-10 animate-spin text-primary" />
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground animate-pulse">Compilando historial completo...</p>
              </div>
            ) : history.length > 0 ? (
              <div className="relative pl-4 ml-2 border-l-2 border-border/50 space-y-8">
                {history.map((event, idx) => (
                  <div key={idx} className="relative group">
                    {/* Dot on the line */}
                    <div className={`absolute -left-[23px] top-1 w-4 h-4 rounded-full border-2 border-card bg-card flex items-center justify-center shadow-lg transition-transform group-hover:scale-125 z-10`}>
                       <div className={`w-2 h-2 rounded-full ${event.type === 'production' ? 'bg-emerald-400' : event.type === 'wms' ? 'bg-blue-400' : event.type === 'comment' ? 'bg-amber-400' : 'bg-indigo-400'}`} />
                    </div>

                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] font-mono text-muted-foreground opacity-60">
                          {formatTimestamp(event.timestamp)}
                        </span>
                        <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest border ${getEventBadgeClass(event.type)}`}>
                          {event.type}
                        </span>
                        <span className="text-[10px] font-bold text-foreground/80 flex items-center gap-1">
                          <User className="w-3 h-3" /> {event.user}
                        </span>
                      </div>
                      
                      <div className="text-sm font-bold text-foreground group-hover:text-primary transition-colors flex items-center gap-2">
                        {getEventIcon(event.type)}
                        {event.description}
                      </div>

                      {/* Extra context specifically for comments or specific activities */}
                      {event.details && (
                        <div className="mt-1 pl-6">
                           {event.type === 'comment' && (
                             <p className="text-xs italic text-muted-foreground bg-secondary/30 p-2 rounded-lg border border-border/20">
                               "{event.details.content}"
                             </p>
                           )}
                           {event.type === 'activity' && event.action === 'update_order' && event.details.changed_fields && (
                             <p className="text-[10px] text-muted-foreground font-medium">
                               Campos modificados: <span className="text-foreground/70">{event.details.changed_fields.join(', ')}</span>
                             </p>
                           )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-20 opacity-30">
                <FileText className="w-12 h-12 mx-auto mb-2" />
                <p className="text-sm font-bold uppercase tracking-widest">Sin registros históricos detectados</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-secondary/10 border-t border-border/50 text-center">
          <p className="text-[8px] font-black uppercase tracking-[0.5em] text-muted-foreground/40">
            Módulo de Auditoría Industrial Avanzada - MOS v5.4.2
          </p>
        </div>
      </div>
    </div>
  );
};

export default OrderHistoryModal;
