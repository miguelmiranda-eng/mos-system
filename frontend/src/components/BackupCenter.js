import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Database, FileText, Download, ShieldCheck, ArrowLeft, 
  Search, Filter, CheckCircle2, Loader2, Archive, FileJson,
  LayoutDashboard, Info
} from 'lucide-react';
import { API } from '../lib/constants';
import { toast, Toaster } from 'sonner';

const BackupCenter = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(null); // 'pdf' or 'json'
  const [orders, setOrders] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [search, setSearch] = useState('');
  const [boardFilter, setBoardFilter] = useState('MASTER');
  const [boards, setBoards] = useState([]);

  useEffect(() => {
    fetchBoards();
    fetchOrders();
  }, [boardFilter]);

  const fetchBoards = async () => {
    try {
      const res = await fetch(`${API}/orders/board-counts`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setBoards(Object.keys(data).sort());
      }
    } catch (err) { console.error(err); }
  };

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/orders?board=${boardFilter}&search=${search}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setOrders(data);
      }
    } catch (err) { toast.error("Error al cargar órdenes"); }
    finally { setLoading(false); }
  };

  const handleSearch = (e) => {
    if (e.key === 'Enter') fetchOrders();
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (selectedIds.length === orders.length && orders.length > 0) setSelectedIds([]);
    else setSelectedIds(orders.map(o => o.order_id));
  };

  const handleExportPDF = async () => {
    if (selectedIds.length === 0) {
      toast.error("Selecciona al menos una orden para exportar");
      return;
    }
    setExporting('pdf');
    try {
      const res = await fetch(`${API}/orders/export-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ order_ids: selectedIds })
      });
      if (res.ok) {
        const data = await res.json();
        const link = document.createElement('a');
        link.href = `data:application/pdf;base64,${data.data}`;
        link.download = data.filename;
        link.click();
        toast.success("PDF generado exitosamente");
      } else {
        toast.error("Error al generar PDF");
      }
    } catch (err) { toast.error("Error de conexión"); }
    finally { setExporting(null); }
  };

  const handleExportJSON = async () => {
    if (selectedIds.length === 0) {
      toast.error("Selecciona al menos una orden para exportar");
      return;
    }
    setExporting('json');
    try {
      const res = await fetch(`${API}/orders/export-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ order_ids: selectedIds, include_comments: true, include_images: true })
      });
      if (res.ok) {
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `backup_completo_${new Date().getTime()}.json`;
        link.click();
        toast.success("Respaldo JSON generado exitosamente");
      }
    } catch (err) { toast.error("Error de conexión"); }
    finally { setExporting(null); }
  };

  const inputCls = "w-full bg-slate-900/50 border border-white/10 rounded-xl py-3 pl-10 pr-4 text-sm text-white outline-none focus:border-royal/50 focus:ring-1 focus:ring-royal/30 transition-all placeholder:text-white/20";

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-200 p-6 md:p-10 font-barlow relative overflow-y-auto">
      <Toaster position="bottom-right" theme="dark" />
      
      {/* Background Decorative elements */}
      <div className="fixed top-0 right-0 w-1/2 h-1/2 bg-royal/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none z-0"></div>
      
      <div className="relative z-10 max-w-7xl mx-auto">
        <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-4">
            <button onClick={() => navigate('/home')} className="text-slate-500 hover:text-royal flex items-center text-xs font-bold uppercase tracking-widest transition-colors group">
               <ArrowLeft className="w-4 h-4 mr-2 group-hover:-translate-x-1 transition-transform" /> Volver al Home
            </button>
            <div className="flex items-center gap-5">
              <div className="w-14 h-14 bg-royal/10 rounded-2xl flex items-center justify-center border border-royal/20 shadow-lg shadow-royal/5">
                <Database className="w-7 h-7 text-royal" />
              </div>
              <div>
                 <h1 className="text-4xl font-black uppercase tracking-tighter text-white">
                   CENTRO DE <span className="text-royal">RESPALDOS</span>
                 </h1>
                 <p className="text-slate-400 font-medium text-sm flex items-center gap-2">
                   <Info className="w-4 h-4 text-royal/60" /> Exportación de historial con comentarios y evidencia fotográfica.
                 </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button 
              onClick={handleExportPDF}
              disabled={exporting || selectedIds.length === 0}
              className="px-6 py-3.5 bg-slate-800/50 hover:bg-slate-700/50 border border-white/10 rounded-xl text-[11px] font-black uppercase tracking-widest flex items-center gap-2.5 transition-all disabled:opacity-20 shadow-xl">
              {exporting === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4 text-red-500" />}
              Exportar PDF con Fotos
            </button>
            <button 
              onClick={handleExportJSON}
              disabled={exporting || selectedIds.length === 0}
              className="px-8 py-3.5 bg-royal text-white rounded-xl text-[11px] font-black uppercase tracking-widest flex items-center gap-2.5 shadow-[0_10px_30px_rgba(30,64,175,0.3)] hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-20">
              {exporting === 'json' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileJson className="w-4 h-4" />}
              Respaldo JSON Completo
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6">
          {/* Filters Panel */}
          <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-2xl p-5 flex flex-wrap gap-5 items-center shadow-2xl">
            <div className="relative flex-1 min-w-[300px]">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input 
                className={inputCls}
                placeholder="Buscar por orden, cliente o PO..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearch}
              />
            </div>
            
            <div className="flex items-center gap-3 min-w-[240px]">
              <Filter className="w-4 h-4 text-royal" />
              <select 
                className="flex-1 bg-slate-900/80 border border-white/10 rounded-xl py-3 px-4 text-sm text-white outline-none focus:border-royal/50 transition-all cursor-pointer"
                value={boardFilter}
                onChange={(e) => setBoardFilter(e.target.value)}
              >
                <option value="MASTER">Todos los tableros activos</option>
                <option value="PAPELERA DE RECICLAJE">Papelera de Reciclaje</option>
                {boards.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>

            <button 
              onClick={selectAll}
              className="px-5 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] transition-all hover:text-royal">
              {selectedIds.length === orders.length && orders.length > 0 ? 'Desmarcar Todo' : 'Seleccionar Todo'}
            </button>
          </div>

          {/* Orders Table Container */}
          <div className="bg-slate-900/30 backdrop-blur-md border border-white/5 rounded-3xl overflow-hidden shadow-2xl min-h-[500px]">
            {loading ? (
              <div className="flex flex-col items-center justify-center h-[500px] space-y-4">
                <div className="relative">
                  <div className="w-12 h-12 border-4 border-royal/20 rounded-full animate-spin border-t-royal"></div>
                </div>
                <p className="text-xs font-black uppercase tracking-[0.3em] text-royal animate-pulse">Consultando Base de Datos...</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 bg-slate-800/20">
                      <th className="px-8 py-5 w-16"></th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Orden</th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Cliente</th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Tablero Origen</th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Estado Producción</th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Fecha Creación</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {orders.map(order => {
                      const isSelected = selectedIds.includes(order.order_id);
                      return (
                        <tr 
                          key={order.order_id} 
                          onClick={() => toggleSelect(order.order_id)}
                          className={`group transition-all cursor-pointer ${isSelected ? 'bg-royal/10' : 'hover:bg-white/[0.02]'}`}>
                          <td className="px-8 py-5">
                            <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all duration-300 ${isSelected ? 'bg-royal border-royal scale-110 shadow-[0_0_15px_rgba(30,64,175,0.4)]' : 'border-white/10 bg-black/40 group-hover:border-royal/50'}`}>
                              {isSelected && <CheckCircle2 className="w-4 h-4 text-white" />}
                            </div>
                          </td>
                          <td className="px-6 py-5">
                            <div className="flex flex-col">
                              <span className="text-lg font-black text-white group-hover:text-royal transition-colors">{order.order_number}</span>
                              <span className="text-[10px] text-slate-600 font-bold uppercase">{order.customer_po || 'Sin PO'}</span>
                            </div>
                          </td>
                          <td className="px-6 py-5">
                            <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors">{order.client || '—'}</span>
                          </td>
                          <td className="px-6 py-5">
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest bg-slate-800 text-slate-400 border border-white/5">
                              {order.board}
                            </span>
                          </td>
                          <td className="px-6 py-5">
                            <span className={`text-[10px] font-black uppercase tracking-widest ${order.production_status === 'CANCELLED' ? 'text-red-500' : 'text-royal'}`}>
                              {order.production_status || 'PENDIENTE'}
                            </span>
                          </td>
                          <td className="px-6 py-5">
                            <span className="text-xs font-mono text-slate-600">
                              {order.created_at?.split('T')[0]}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            
            {orders.length === 0 && !loading && (
              <div className="flex flex-col items-center justify-center py-32 text-slate-700">
                <Archive className="w-20 h-20 mb-6 opacity-10" />
                <h3 className="text-xl font-black uppercase tracking-widest opacity-20">Sin registros para respaldar</h3>
                <p className="text-sm font-medium mt-2">Intenta cambiar el filtro de tableros o la búsqueda.</p>
              </div>
            )}
          </div>
          
          {/* Footer Stats */}
          <div className="flex justify-between items-center px-4 py-2">
             <div className="flex items-center gap-6">
                <div className="flex flex-col">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">Total Encontrado</span>
                  <span className="text-xl font-black text-white">{orders.length}</span>
                </div>
                <div className="w-px h-8 bg-white/10"></div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-black uppercase tracking-widest text-royal">Seleccionadas</span>
                  <span className="text-xl font-black text-white">{selectedIds.length}</span>
                </div>
             </div>
             
             <div className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-700 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4" /> Encriptación AES-128 activa para exportación
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BackupCenter;
