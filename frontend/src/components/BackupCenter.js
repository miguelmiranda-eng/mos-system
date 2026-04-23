import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Database, FileText, Download, ShieldCheck, ArrowLeft, 
  Search, Filter, CheckCircle2, Loader2, Archive, FileJson,
  LayoutDashboard, Info, Upload, Trash2, RefreshCw, Eye, ChevronRight
} from 'lucide-react';
import { API } from '../lib/constants';
import { toast, Toaster } from 'sonner';

const BackupCenter = () => {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  
  const [viewMode, setViewMode] = useState('system'); // 'system' or 'external'
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(null); 
  
  const [orders, setOrders] = useState([]);
  const [externalOrders, setExternalOrders] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  
  const [search, setSearch] = useState('');
  const [boardFilter, setBoardFilter] = useState('MASTER');
  const [boards, setBoards] = useState([]);

  useEffect(() => {
    if (viewMode === 'system') {
      fetchBoards();
      fetchOrders();
    }
  }, [boardFilter, viewMode]);

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

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data && data.orders) {
          setExternalOrders(data.orders);
          setViewMode('external');
          setSelectedIds([]);
          toast.success(`Se cargaron ${data.orders.length} órdenes del archivo externo`);
        } else {
          toast.error("Formato de respaldo incorrecto");
        }
      } catch (err) {
        toast.error("Error al leer el archivo JSON");
      }
    };
    reader.readAsText(file);
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    const currentOrders = viewMode === 'system' ? orders : externalOrders;
    if (selectedIds.length === currentOrders.length && currentOrders.length > 0) setSelectedIds([]);
    else setSelectedIds(currentOrders.map(o => o.order_id));
  };

  const handleExportPDF = async () => {
    if (selectedIds.length === 0) return;
    setExporting('pdf');
    try {
      if (viewMode === 'external') {
         toast.error("Restaura las órdenes primero para generar el PDF.");
         setExporting(null); return;
      }
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
        toast.success("PDF generado");
      }
    } catch (err) { toast.error("Error de conexión"); }
    finally { setExporting(null); }
  };

  const handleExportJSON = async () => {
    if (selectedIds.length === 0) return;
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
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `respaldo_mos_${dateStr}_${new Date().getTime()}`;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${filename}.json`;
        link.click();
        toast.success("Archivo llave creado");
      }
    } catch (err) { toast.error("Error de conexión"); }
    finally { setExporting(null); }
  };

  const handleRestore = async () => {
    if (selectedIds.length === 0) return;
    setExporting('restore');
    try {
      const ordersToRestore = externalOrders.filter(o => selectedIds.includes(o.order_id));
      const res = await fetch(`${API}/orders/import-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ orders: ordersToRestore, update_existing: true })
      });
      if (res.ok) {
        const stats = await res.json();
        toast.success(`Restauración completa: ${stats.orders} nuevas.`);
        setViewMode('system');
        fetchOrders();
      }
    } catch (err) { toast.error("Error al restaurar"); }
    finally { setExporting(null); }
  };

  const handleDeleteFromSystem = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`¿ELIMINAR PERMANENTEMENTE ${selectedIds.length} órdenes?`)) return;
    setExporting('delete');
    try {
      for (const id of selectedIds) {
        await fetch(`${API}/orders/${id}/permanent`, { method: 'DELETE', credentials: 'include' });
      }
      toast.success("Órdenes eliminadas");
      fetchOrders();
      setSelectedIds([]);
    } catch (err) { toast.error("Error al eliminar"); }
    finally { setExporting(null); }
  };

  const displayedOrders = (viewMode === 'system' ? orders : externalOrders)
    .filter(o => 
      !search || 
      o.order_number?.toLowerCase().includes(search.toLowerCase()) || 
      o.client?.toLowerCase().includes(search.toLowerCase())
    );

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-barlow overflow-y-auto pb-20">
      <Toaster position="bottom-right" />
      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".json" className="hidden" />
      
      {/* HEADER EXECUTIVE */}
      <header className="bg-white border-b border-slate-200 px-8 py-8 mb-10 shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
           <div className="flex items-center gap-6">
              <button 
                onClick={() => navigate('/home')} 
                className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 transition-all border border-slate-200 group">
                <ArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
              </button>
              <div className="flex flex-col leading-none">
                <h1 className="text-3xl font-black uppercase tracking-tighter text-slate-900">
                  BACKUP <span className="text-emerald-500">CENTER</span>
                </h1>
                <div className="flex items-center gap-2 mt-2">
                   <ShieldCheck className="w-4 h-4 text-emerald-500/60" />
                   <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-400">Security & Archive Management</span>
                </div>
              </div>
           </div>

           <div className="flex items-center gap-3 p-1.5 bg-slate-100 border border-slate-200 rounded-[1.5rem]">
              <button 
                 onClick={() => setViewMode('system')}
                 className={`px-8 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${viewMode === 'system' ? 'bg-white text-emerald-600 shadow-md border border-emerald-100' : 'text-slate-500 hover:text-slate-800'}`}>
                 Archivo del Sistema
              </button>
              <button 
                 onClick={() => viewMode === 'external' ? setViewMode('system') : fileInputRef.current.click()}
                 className={`px-8 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'external' ? 'bg-emerald-500 text-white shadow-lg' : 'text-slate-500 hover:text-slate-800'}`}>
                 {viewMode === 'external' ? 'Archivo Externo' : <><Upload className="w-3.5 h-3.5" /> Explorar USB</>}
              </button>
           </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-8 space-y-8">
        
        {/* ACTION BAR CARD */}
        <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm flex flex-col md:flex-row gap-6 items-center justify-between">
            <div className="flex flex-wrap gap-3 items-center">
              {viewMode === 'system' ? (
                <>
                  <button 
                    onClick={handleExportPDF}
                    disabled={exporting || selectedIds.length === 0}
                    className="px-6 py-3.5 bg-white hover:bg-emerald-50 border border-slate-200 hover:border-emerald-200 text-slate-700 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all disabled:opacity-30 shadow-sm">
                    {exporting === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-4 h-4 text-emerald-500" />}
                    PDF Resumen
                  </button>
                  <button 
                    onClick={handleExportJSON}
                    disabled={exporting || selectedIds.length === 0}
                    className="px-6 py-3.5 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all disabled:opacity-30 shadow-lg shadow-slate-900/10">
                    {exporting === 'json' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-4 h-4 text-emerald-400" />}
                    Descargar Respaldo JSON
                  </button>
                  <div className="w-px h-10 bg-slate-200 mx-2 hidden md:block"></div>
                  <button 
                    onClick={handleDeleteFromSystem}
                    disabled={exporting || selectedIds.length === 0}
                    className="px-6 py-3.5 bg-red-50 text-red-600 border border-red-100 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all hover:bg-red-500 hover:text-white disabled:opacity-20">
                    <Trash2 className="w-4 h-4" /> Eliminar de MOS
                  </button>
                </>
              ) : (
                <>
                  <button 
                    onClick={handleRestore}
                    disabled={exporting || selectedIds.length === 0}
                    className="px-8 py-3.5 bg-emerald-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 shadow-xl shadow-emerald-500/20 transition-all disabled:opacity-30">
                    {exporting === 'restore' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Restaurar Selección
                  </button>
                  <button 
                    onClick={() => {setExternalOrders([]); setViewMode('system');}}
                    className="px-8 py-3.5 bg-white border border-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all hover:bg-slate-50">
                    Cerrar Archivo
                  </button>
                </>
              )}
            </div>

            <div className="flex items-center gap-4 w-full md:w-auto">
                <div className="relative flex-1 md:w-72">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                  <input 
                    className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-3 pl-12 pr-4 text-xs text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500/10 focus:border-emerald-500/20 transition-all placeholder:text-slate-400 font-bold"
                    placeholder="Filtrar por número u orden..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {viewMode === 'system' && (
                  <div className="relative">
                    <Filter className="absolute left-4 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-emerald-500" />
                    <select 
                      className="bg-slate-50 border border-slate-100 rounded-2xl py-3 pl-10 pr-8 text-[10px] font-black uppercase tracking-widest text-slate-600 outline-none focus:border-emerald-500/20 transition-all cursor-pointer appearance-none"
                      value={boardFilter}
                      onChange={(e) => setBoardFilter(e.target.value)}
                    >
                      <option value="MASTER">TODOS ACTIVOS</option>
                      <option value="PAPELERA DE RECICLAJE">PAPELERA</option>
                      {boards.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </div>
                )}
                <button 
                  onClick={selectAll}
                  className="px-5 py-3 bg-white border border-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all hover:bg-slate-50">
                  {selectedIds.length === displayedOrders.length && displayedOrders.length > 0 ? 'Deseleccionar' : 'Seleccionar Todo'}
                </button>
            </div>
        </div>

        {/* DATA TABLE CARD */}
        <div className="bg-white border border-slate-200 rounded-[2.5rem] overflow-hidden shadow-sm min-h-[600px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-[600px]">
              <Loader2 className="w-12 h-12 animate-spin text-emerald-500" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50/50 border-b border-slate-100">
                    <th className="px-10 py-6 w-20"></th>
                    <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Orden / PO</th>
                    <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Cliente</th>
                    <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Contenido</th>
                    <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Tablero Origen</th>
                    <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.3em] text-slate-400"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {displayedOrders.map(order => {
                    const isSelected = selectedIds.includes(order.order_id);
                    return (
                      <tr 
                        key={order.order_id} 
                        onClick={() => toggleSelect(order.order_id)}
                        className={`group transition-all cursor-pointer ${isSelected ? 'bg-emerald-50/40' : 'hover:bg-slate-50/30'}`}>
                        <td className="px-10 py-6">
                          <div className={`w-7 h-7 rounded-xl border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-emerald-500 border-emerald-500 shadow-lg shadow-emerald-500/20' : 'border-slate-200 bg-white'}`}>
                            {isSelected && <CheckCircle2 className="w-4 h-4 text-white" />}
                          </div>
                        </td>
                        <td className="px-6 py-6">
                          <div className="flex flex-col">
                            <span className="text-xl font-black text-slate-900 group-hover:text-emerald-600 transition-colors tracking-tighter">{order.order_number}</span>
                            <span className="text-[11px] text-slate-400 font-bold uppercase tracking-widest mt-1">{order.customer_po || 'SIN PO'}</span>
                          </div>
                        </td>
                        <td className="px-6 py-6">
                          <span className="text-sm font-bold text-slate-600 group-hover:text-slate-900 transition-colors uppercase">{order.client || '—'}</span>
                        </td>
                        <td className="px-6 py-6">
                          <div className="flex gap-2">
                             {order._comments?.length > 0 && <span className="px-3 py-1 bg-blue-50 text-blue-600 text-[10px] font-black rounded-lg uppercase tracking-tighter border border-blue-100">{order._comments.length} Coments</span>}
                             {order._image_files?.length > 0 && <span className="px-3 py-1 bg-emerald-50 text-emerald-600 text-[10px] font-black rounded-lg uppercase tracking-tighter border border-emerald-100">{order._image_files.length} Fotos</span>}
                          </div>
                        </td>
                        <td className="px-6 py-6">
                          <span className="inline-flex items-center px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-500 border border-slate-200">
                            {viewMode === 'system' ? order.board : (order.production_status || 'EXTERNO')}
                          </span>
                        </td>
                        <td className="px-6 py-6">
                           <div className="opacity-0 group-hover:opacity-100 transition-all translate-x-4 group-hover:translate-x-0">
                              <ChevronRight className="w-5 h-5 text-emerald-500" />
                           </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          
          {displayedOrders.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-40 text-slate-300">
              <Archive className="w-24 h-24 mb-6 opacity-10" />
              <h3 className="text-2xl font-black uppercase tracking-[0.3em] opacity-20">
                 {viewMode === 'system' ? 'Sin registros' : 'Esperando archivo USB...'}
              </h3>
              {viewMode === 'external' && (
                <button 
                  onClick={() => fileInputRef.current.click()}
                  className="mt-10 px-10 py-4 bg-emerald-500 text-white rounded-2xl font-black uppercase tracking-widest shadow-2xl shadow-emerald-500/30 hover:bg-emerald-600 transition-all">
                  Cargar JSON de Respaldo
                </button>
              )}
            </div>
          )}
        </div>
        
        {/* FOOTER STATUS */}
        <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-[0.5em] text-slate-400 px-10">
           <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                 <div className={`w-2 h-2 rounded-full ${viewMode === 'system' ? 'bg-blue-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}`} />
                 <span>MODO: {viewMode === 'system' ? 'INTERNO' : 'EXTERNO (USB)'}</span>
              </div>
              <div className="w-1 h-1 bg-slate-300 rounded-full" />
              <span>{selectedIds.length} ÓRDENES SELECCIONADAS</span>
           </div>
           {viewMode === 'external' && <span className="text-emerald-600 italic">Explorando almacenamiento externo con éxito.</span>}
        </div>
      </main>
    </div>
  );
};

export default BackupCenter;
