import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Database, FileText, Download, ShieldCheck, ArrowLeft, 
  Search, Filter, CheckCircle2, Loader2, Archive, FileJson,
  LayoutDashboard, Info, Upload, Trash2, RefreshCw, Eye
} from 'lucide-react';
import { API } from '../lib/constants';
import { toast, Toaster } from 'sonner';

const BackupCenter = () => {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  
  const [viewMode, setViewMode] = useState('system'); // 'system' or 'external'
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(null); // 'pdf', 'json', 'restore', 'delete'
  
  const [orders, setOrders] = useState([]);
  const [externalOrders, setExternalOrders] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  
  const [search, setSearch] = useState('');
  const [boardFilter, setBoardFilter] = useState('MASTER');
  const [boards, setBoards] = useState([]);

  // Load system data
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

  // --- External File Logic ---
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
          toast.error("El archivo no tiene el formato correcto de respaldo MOS");
        }
      } catch (err) {
        toast.error("Error al leer el archivo JSON");
      }
    };
    reader.readAsText(file);
  };

  // --- Actions ---
  const handleSearch = (e) => {
    if (e.key === 'Enter') {
      if (viewMode === 'system') fetchOrders();
    }
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
    if (selectedIds.length === 0) {
      toast.error("Selecciona al menos una orden");
      return;
    }
    setExporting('pdf');
    try {
      // PDF only works for system orders currently
      if (viewMode === 'external') {
         toast.error("La exportación a PDF solo está disponible para órdenes en el sistema. Restáuralas primero si necesitas el reporte.");
         setExporting(null);
         return;
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
        toast.success("PDF generado exitosamente");
      }
    } catch (err) { toast.error("Error de conexión"); }
    finally { setExporting(null); }
  };

  const handleExportJSON = async () => {
    if (selectedIds.length === 0) {
      toast.error("Selecciona al menos una orden");
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
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `respaldo_mos_${dateStr}_${new Date().getTime()}`;

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${filename}.json`;
        link.click();
        toast.success("Archivo llave (JSON) creado exitosamente");
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
        toast.success(`Restauración completa: ${stats.orders} nuevas, ${stats.updated_orders} actualizadas.`);
        setViewMode('system');
        fetchOrders();
      }
    } catch (err) { toast.error("Error al restaurar órdenes"); }
    finally { setExporting(null); }
  };

  const handleDeleteFromSystem = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`¿Estás seguro de ELIMINAR PERMANENTEMENTE ${selectedIds.length} órdenes del sistema? Asegúrate de tener tu respaldo descargado primero.`)) return;
    
    setExporting('delete');
    try {
      let count = 0;
      for (const id of selectedIds) {
        const res = await fetch(`${API}/orders/${id}/permanent`, { 
          method: 'DELETE',
          credentials: 'include' 
        });
        if (res.ok) count++;
      }
      toast.success(`${count} órdenes eliminadas del sistema permanentemente.`);
      fetchOrders();
      setSelectedIds([]);
    } catch (err) { toast.error("Error al eliminar órdenes"); }
    finally { setExporting(null); }
  };

  const inputCls = "w-full bg-slate-900/50 border border-white/10 rounded-xl py-3 pl-10 pr-4 text-sm text-white outline-none focus:border-royal/50 focus:ring-1 focus:ring-royal/30 transition-all placeholder:text-white/20";

  const displayedOrders = (viewMode === 'system' ? orders : externalOrders)
    .filter(o => 
      !search || 
      o.order_number?.toLowerCase().includes(search.toLowerCase()) || 
      o.client?.toLowerCase().includes(search.toLowerCase())
    );

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-200 p-6 md:p-10 font-barlow relative overflow-y-auto">
      <Toaster position="bottom-right" theme="dark" />
      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".json" className="hidden" />
      
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
                   <ShieldCheck className="w-4 h-4 text-royal/60" /> Gestión de archivo muerto y restauración externa.
                 </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 p-1 bg-slate-900/50 border border-white/5 rounded-2xl backdrop-blur-xl">
             <button 
                onClick={() => setViewMode('system')}
                className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${viewMode === 'system' ? 'bg-royal text-white shadow-lg' : 'text-slate-500 hover:text-white'}`}>
                En Sistema
             </button>
             <button 
                onClick={() => viewMode === 'external' ? setViewMode('system') : fileInputRef.current.click()}
                className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${viewMode === 'external' ? 'bg-royal text-white shadow-lg' : 'text-slate-500 hover:text-white flex items-center gap-2'}`}>
                {viewMode === 'external' ? 'Vista Externa' : <><Upload className="w-3.5 h-3.5" /> Explorar USB</>}
             </button>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6">
          {/* Action Bar */}
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-6 shadow-2xl">
            <div className="flex flex-wrap gap-3 items-center">
              {viewMode === 'system' ? (
                <>
                  <button 
                    onClick={handleExportPDF}
                    disabled={exporting || selectedIds.length === 0}
                    className="px-5 py-3 bg-slate-800/50 hover:bg-slate-700/50 border border-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all disabled:opacity-20">
                    {exporting === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5 text-red-500" />}
                    Exportar PDF
                  </button>
                  <button 
                    onClick={handleExportJSON}
                    disabled={exporting || selectedIds.length === 0}
                    className="px-5 py-3 bg-slate-800/50 hover:bg-slate-700/50 border border-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all disabled:opacity-20">
                    {exporting === 'json' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileJson className="w-3.5 h-3.5 text-royal" />}
                    Crear Archivo Llave
                  </button>
                  <div className="w-px h-8 bg-white/5 mx-2"></div>
                  <button 
                    onClick={handleDeleteFromSystem}
                    disabled={exporting || selectedIds.length === 0}
                    className="px-5 py-3 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-500 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all disabled:opacity-20">
                    {exporting === 'delete' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Borrar de MOS
                  </button>
                </>
              ) : (
                <>
                  <button 
                    onClick={handleRestore}
                    disabled={exporting || selectedIds.length === 0}
                    className="px-6 py-3 bg-royal text-white rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg transition-all disabled:opacity-20">
                    {exporting === 'restore' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Restaurar Seleccionadas
                  </button>
                  <button 
                    onClick={() => {setExternalOrders([]); setViewMode('system');}}
                    className="px-6 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">
                    Cerrar Archivo
                  </button>
                </>
              )}
            </div>

            <div className="flex items-center gap-4 w-full md:w-auto">
                <div className="relative flex-1 md:w-64">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input 
                    className={inputCls}
                    placeholder="Filtrar en lista..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {viewMode === 'system' && (
                  <select 
                    className="bg-slate-900 border border-white/10 rounded-xl py-3 px-4 text-[10px] font-black uppercase tracking-widest text-white outline-none focus:border-royal/50 transition-all cursor-pointer"
                    value={boardFilter}
                    onChange={(e) => setBoardFilter(e.target.value)}
                  >
                    <option value="MASTER">TODOS ACTIVOS</option>
                    <option value="PAPELERA DE RECICLAJE">PAPELERA</option>
                    {boards.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                )}
                <button 
                  onClick={selectAll}
                  className="px-4 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">
                  {selectedIds.length === displayedOrders.length && displayedOrders.length > 0 ? 'Nada' : 'Todo'}
                </button>
            </div>
          </div>

          {/* Data Table */}
          <div className="bg-slate-900/30 backdrop-blur-md border border-white/5 rounded-3xl overflow-hidden shadow-2xl min-h-[500px]">
            {loading ? (
              <div className="flex flex-col items-center justify-center h-[500px]">
                <Loader2 className="w-10 h-10 animate-spin text-royal" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 bg-slate-800/20">
                      <th className="px-8 py-5 w-16"></th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Orden</th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Cliente</th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Detalles</th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">{viewMode === 'system' ? 'Tablero' : 'Estado en Archivo'}</th>
                      <th className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {displayedOrders.map(order => {
                      const isSelected = selectedIds.includes(order.order_id);
                      return (
                        <tr 
                          key={order.order_id} 
                          onClick={() => toggleSelect(order.order_id)}
                          className={`group transition-all cursor-pointer ${isSelected ? 'bg-royal/10' : 'hover:bg-white/[0.02]'}`}>
                          <td className="px-8 py-5">
                            <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-royal border-royal' : 'border-white/10 bg-black/40'}`}>
                              {isSelected && <CheckCircle2 className="w-4 h-4 text-white" />}
                            </div>
                          </td>
                          <td className="px-6 py-5">
                            <div className="flex flex-col">
                              <span className="text-lg font-black text-white group-hover:text-royal transition-colors">{order.order_number}</span>
                              <span className="text-[10px] text-slate-600 font-bold uppercase tracking-widest">{order.customer_po || 'Sin PO'}</span>
                            </div>
                          </td>
                          <td className="px-6 py-5">
                            <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors">{order.client || '—'}</span>
                          </td>
                          <td className="px-6 py-5">
                            <div className="flex gap-2">
                               {order._comments?.length > 0 && <span className="px-2 py-0.5 bg-royal/20 text-royal text-[9px] font-bold rounded flex items-center gap-1"><Info className="w-3 h-3" /> {order._comments.length} Mensajes</span>}
                               {order._image_files?.length > 0 && <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-500 text-[9px] font-bold rounded flex items-center gap-1"><Eye className="w-3 h-3" /> {order._image_files.length} Fotos</span>}
                            </div>
                          </td>
                          <td className="px-6 py-5">
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest bg-slate-800 text-slate-400 border border-white/5">
                              {viewMode === 'system' ? order.board : (order.production_status || 'ARCHIVADO')}
                            </span>
                          </td>
                          <td className="px-6 py-5">
                             <button className="p-2 hover:bg-white/5 rounded-lg transition-colors text-slate-600 hover:text-royal">
                                <LayoutDashboard className="w-4 h-4" />
                             </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            
            {displayedOrders.length === 0 && !loading && (
              <div className="flex flex-col items-center justify-center py-32 text-slate-700">
                <Archive className="w-20 h-20 mb-6 opacity-10" />
                <h3 className="text-xl font-black uppercase tracking-widest opacity-20">
                   {viewMode === 'system' ? 'Sin registros en el sistema' : 'Sube un archivo de tu USB para explorar'}
                </h3>
                {viewMode === 'external' && (
                  <button 
                    onClick={() => fileInputRef.current.click()}
                    className="mt-6 px-8 py-3 bg-royal text-white rounded-xl font-black uppercase tracking-widest shadow-xl">
                    Seleccionar Archivo Llave
                  </button>
                )}
              </div>
            )}
          </div>
          
          {/* Status Bar */}
          <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-[0.3em] text-slate-700 px-2">
             <div className="flex items-center gap-4">
                <span>Modo: <span className={viewMode === 'system' ? 'text-royal' : 'text-emerald-500'}>{viewMode === 'system' ? 'GESTIÓN INTERNA' : 'EXPLORADOR USB'}</span></span>
                <span>•</span>
                <span>{selectedIds.length} seleccionadas</span>
             </div>
             {viewMode === 'external' && <span>Estas órdenes están en tu USB, no en el servidor.</span>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BackupCenter;
