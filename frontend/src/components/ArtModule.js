import React, { useState, useEffect, useCallback } from 'react';
import { 
  Palette, Search, Clock, CheckCircle2, AlertCircle, 
  ChevronRight, ArrowLeft, Loader2, Tag, Layers, BarChart2,
  History, TrendingUp, BarChart3, Calendar, Plus, User, FileText, X
} from 'lucide-react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, Legend, Cell 
} from 'recharts';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { API, DEFAULT_COLUMNS } from '../lib/constants';
import { useAuth } from '../App';
import { EditableCell } from './dashboard/EditableCell';
import SearchableSelect from './SearchableSelect';
import { useLang } from '../contexts/LanguageContext';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { jsPDF } from 'jspdf';
import { Trash2, Download, Printer, CheckSquare, Square, Settings2, GripVertical, Eye, EyeOff } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator } from './ui/dropdown-menu';

const ArtModule = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [dailyStats, setDailyStats] = useState({ total_separations: 0, total_necks: 0, recent_logs: [] });
  const [historyStats, setHistoryStats] = useState({ daily: [], weekly: [], monthly: [] });
  const [historyRange, setHistoryRange] = useState('daily'); // 'daily' | 'weekly' | 'monthly'
  const [activeTab, setActiveTab] = useState('ops'); // 'ops' | 'kpis' | 'preorders'
  const [showPreOrderModal, setShowPreOrderModal] = useState(false);
  const [preOrderData, setPreOrderData] = useState({ client: '', job_title_a: '', job_title_b: '', artwork_status: 'NEW', cancel_date: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [options, setOptions] = useState({});
  const [selectedOrders, setSelectedOrders] = useState(new Set());
  const [draggedCol, setDraggedCol] = useState(null);
  const [columnOrder, setColumnOrder] = useState(() => {
    const saved = localStorage.getItem('art_module_column_order');
    return saved ? JSON.parse(saved) : {
      ops: ['selection', 'order_number', 'client', 'artwork_status', 'betty_column', 'job_title_a', 'job_title_b', 'cancel_date', 'actions'],
      preorders: ['selection', 'order_number', 'client', 'artwork_status', 'betty_column', 'job_title_a', 'cancel_date', 'actions']
    };
  });
  const [hiddenColumns, setHiddenColumns] = useState(() => {
    const saved = localStorage.getItem('art_module_hidden_columns');
    return saved ? JSON.parse(saved) : [];
  });
  const { t } = useLang();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [pendingRes, statsRes, historyRes, optionsRes] = await Promise.all([
        fetch(`${API}/art/pending`, { credentials: 'include' }),
        fetch(`${API}/art/stats/daily`, { credentials: 'include' }),
        fetch(`${API}/art/stats/history`, { credentials: 'include' }),
        fetch(`${API}/config/options`, { credentials: 'include' })
      ]);
      
      if (pendingRes.ok) setPendingOrders(await pendingRes.json());
      if (statsRes.ok) setDailyStats(await statsRes.json());
      if (historyRes.ok) setHistoryStats(await historyRes.json());
      if (optionsRes.ok) setOptions(await optionsRes.json());
    } catch (error) {
      toast.error("Error al cargar datos de arte");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSearch = async (val) => {
    setSearchQuery(val);
    if (val.length < 3) {
      setSearchResults([]);
      return;
    }
    
    setIsSearching(true);
    try {
      const res = await fetch(`${API}/orders?search=${val}&limit=5`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data);
      }
    } catch (error) {
      console.error("Search failed", error);
    } finally {
      setIsSearching(false);
    }
  };

  const logWork = async (order, type) => {
    // Check if already done
    const alreadyDone = type === 'SEPARATION' ? order.art_sep_status : order.art_neck_status;
    if (alreadyDone) {
      const confirm = window.confirm(`⚠️ Esta orden ya tiene un registro de ${type}. ¿Deseas registrar otro de todas formas?`);
      if (!confirm) return;
    }

    setActionLoading(`${order.order_id}-${type}`);
    try {
      const res = await fetch(`${API}/art/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: order.order_id,
          order_number: order.order_number,
          type: type,
          details: `Logged via Art Module by ${user.name}`
        }),
        credentials: 'include'
      });

      if (res.ok) {
        toast.success(`Trabajo de ${type === 'SEPARATION' ? 'Separación' : 'Neck'} registrado exitosamente`);
        fetchData(); // Refresh list and stats
        setSearchQuery('');
        setSearchResults([]);
      } else {
        toast.error("Error al guardar registro");
      }
    } catch (error) {
      toast.error("Error de conexión");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCellUpdate = async (orderId, field, value) => {
    try {
      const res = await fetch(`${API}/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
        credentials: 'include'
      });
      if (res.ok) {
        setPendingOrders(prev => prev.map(o => o.order_id === orderId ? { ...o, [field]: value } : o));
        toast.success("Orden actualizada");
      } else {
        toast.error("Error al actualizar orden");
      }
    } catch (err) {
      toast.error("Error de conexión");
    }
  };

  const handleCreatePreOrder = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API}/art/preorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preOrderData),
        credentials: 'include'
      });
      if (res.ok) {
        toast.success("Pre-orden creada exitosamente");
        setShowPreOrderModal(false);
        setPreOrderData({ client: '', job_title_a: '', job_title_b: '', artwork_status: 'NEW', cancel_date: '' });
        fetchData();
      }
    } catch (err) {
      toast.error("Error al crear pre-orden");
    }
  };

  const toggleSelect = (orderId) => {
    setSelectedOrders(prev => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const toggleSelectAll = (orders) => {
    const allIds = orders.map(o => o.order_id);
    const areAllSelected = allIds.length > 0 && allIds.every(id => selectedOrders.has(id));
    
    setSelectedOrders(prev => {
      const next = new Set(prev);
      if (areAllSelected) {
        allIds.forEach(id => next.delete(id));
      } else {
        allIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const handleBulkDelete = async () => {
    const ordersToDelete = pendingOrders.filter(o => selectedOrders.has(o.order_id));
    const preOrderIds = ordersToDelete.filter(o => o.is_preorder).map(o => o.order_id);
    const realOrders = ordersToDelete.filter(o => !o.is_preorder);

    if (realOrders.length > 0) {
      if (!window.confirm(`Has seleccionado ${realOrders.length} órdenes reales. Por seguridad, solo las pre-órdenes se pueden eliminar en masa desde aquí. ¿Deseas eliminar solo las ${preOrderIds.length} pre-órdenes seleccionadas?`)) return;
    } else {
      if (!window.confirm(`¿Estás seguro de eliminar las ${preOrderIds.length} pre-órdenes seleccionadas?`)) return;
    }

    if (preOrderIds.length === 0) return;

    try {
      await Promise.all(preOrderIds.map(id => 
        fetch(`${API}/orders/${id}`, { method: 'DELETE', credentials: 'include' })
      ));
      toast.success(`${preOrderIds.length} pre-órdenes eliminadas`);
      setSelectedOrders(new Set());
      fetchData();
    } catch (err) {
      toast.error("Error al eliminar órdenes");
    }
  };

  const handleExportExcel = () => {
    const ordersToExport = pendingOrders.filter(o => selectedOrders.has(o.order_id));
    if (ordersToExport.length === 0) return;

    const data = ordersToExport.map(o => ({
      'Orden': o.order_number,
      'Cliente': o.client,
      'Board': o.board,
      'Status Arte': o.artwork_status,
      'Betty Column': o.betty_column,
      'Job Title A': o.job_title_a,
      'Cancel Date': o.cancel_date,
      'Separación': o.art_sep_status ? 'SI' : 'NO',
      'Neck': o.art_neck_status ? 'SI' : 'NO',
      'Es Pre-orden': o.is_preorder ? 'SI' : 'NO'
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Art_Orders");
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([buf], { type: 'application/octet-stream' }), `Art_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const handleExportPdf = () => {
    const ordersToExport = pendingOrders.filter(o => selectedOrders.has(o.order_id));
    if (ordersToExport.length === 0) return;

    const doc = new jsPDF('l', 'mm', 'a4');
    doc.setFontSize(18);
    doc.text("Reporte de Arte - MOS System", 14, 20);
    doc.setFontSize(10);
    doc.text(`Generado: ${new Date().toLocaleString()}`, 14, 28);

    let y = 40;
    const headers = ["ORDEN", "CLIENTE", "STATUS ARTE", "BETTY", "JOB TITLE", "CANCEL", "SEP", "NECK"];
    const colWidths = [25, 40, 30, 30, 60, 25, 15, 15];

    // Draw header
    doc.setFillColor(240, 240, 240);
    doc.rect(14, y - 5, 270, 7, 'F');
    let x = 14;
    headers.forEach((h, i) => {
      doc.setFont(undefined, 'bold');
      doc.text(h, x, y);
      x += colWidths[i];
    });

    y += 10;
    doc.setFont(undefined, 'normal');
    ordersToExport.forEach(o => {
      if (y > 180) { doc.addPage(); y = 20; }
      x = 14;
      const row = [
        o.order_number || '',
        o.client || '',
        o.artwork_status || '',
        o.betty_column || '',
        (o.job_title_a || '').substring(0, 30),
        o.cancel_date || '',
        o.art_sep_status ? 'X' : '',
        o.art_neck_status ? 'X' : ''
      ];
      row.forEach((cell, i) => {
        doc.text(String(cell), x, y);
        x += colWidths[i];
      });
      y += 8;
      doc.setDrawColor(230, 230, 230);
      doc.line(14, y - 5, 284, y - 5);
    });

    doc.save(`Art_Report_${new Date().toISOString().split('T')[0]}.pdf`);
  };

  const handleColumnDragStart = (colKey) => setDraggedCol(colKey);
  const handleColumnDragOver = (e, targetKey, tab) => {
    e.preventDefault();
    if (!draggedCol || draggedCol === targetKey) return;
    
    setColumnOrder(prev => {
      const currentOrder = [...prev[tab]];
      const dragIdx = currentOrder.indexOf(draggedCol);
      const targetIdx = currentOrder.indexOf(targetKey);
      if (dragIdx === -1 || targetIdx === -1) return prev;
      
      const newOrder = [...currentOrder];
      newOrder.splice(dragIdx, 1);
      newOrder.splice(targetIdx, 0, draggedCol);
      const next = { ...prev, [tab]: newOrder };
      localStorage.setItem('art_module_column_order', JSON.stringify(next));
      return next;
    });
  };

  const toggleColumnVisibility = (colKey) => {
    setHiddenColumns(prev => {
      const next = prev.includes(colKey) ? prev.filter(k => k !== colKey) : [...prev, colKey];
      localStorage.setItem('art_module_hidden_columns', JSON.stringify(next));
      return next;
    });
  };

  const OPS_COL_DEFS = {
    selection: { label: '', width: 'w-10' },
    order_number: { label: 'Orden' },
    client: { label: 'Cliente' },
    artwork_status: { label: 'Status Arte' },
    betty_column: { label: 'Betty' },
    job_title_a: { label: 'Job Title A' },
    job_title_b: { label: 'Job Title B' },
    cancel_date: { label: 'Cancel' },
    actions: { label: 'Acciones', align: 'center' }
  };

  const PRE_COL_DEFS = {
    selection: { label: '', width: 'w-10' },
    order_number: { label: 'ID Temp' },
    client: { label: 'Cliente' },
    artwork_status: { label: 'Status Arte' },
    betty_column: { label: 'Betty' },
    job_title_a: { label: 'Job Title A' },
    cancel_date: { label: 'Cancel' },
    actions: { label: 'Acciones', align: 'center' }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-barlow pb-20">
      {/* HEADER */}
      <header className="bg-white border-b border-slate-200 px-8 py-6 sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <button 
              onClick={() => navigate('/home')}
              className="p-3 hover:bg-slate-100 rounded-2xl transition-all text-slate-400 hover:text-slate-900"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-emerald-500 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <Palette className="w-7 h-7 text-white" />
              </div>
              <div className="flex flex-col">
                <h1 className="text-2xl font-black uppercase tracking-tighter text-slate-900">Módulo de <span className="text-emerald-500">Arte</span></h1>
                <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-400 mt-0.5">Medición de Productividad</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-8">
            <div className="flex flex-col items-end">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Separaciones Hoy</span>
              <span className="text-3xl font-black text-emerald-600">{dailyStats.total_separations}</span>
            </div>
            <div className="w-px h-10 bg-slate-200" />
            <div className="flex flex-col items-end">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Necks Hoy</span>
              <span className="text-3xl font-black text-blue-600">{dailyStats.total_necks}</span>
            </div>
          </div>
        </div>
      </header>

      {/* TABS NAVIGATION */}
      <nav className="bg-white border-b border-slate-200 px-8 sticky top-[97px] z-30">
        <div className="max-w-7xl mx-auto flex items-center justify-between py-4">
          <div className="flex gap-4">
            <button 
              onClick={() => setActiveTab('ops')}
              className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'ops' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}
            >
              Operaciones
            </button>
            <button 
              onClick={() => setActiveTab('preorders')}
              className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'preorders' ? 'bg-amber-500 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}
            >
              Pre-Órdenes
            </button>
            <button 
              onClick={() => setActiveTab('kpis')}
              className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'kpis' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}
            >
              KPIs y Productividad
            </button>
          </div>

            <div className="flex items-center gap-4">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">
                    <Settings2 className="w-4 h-4" />
                    Columnas
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 bg-white p-2 rounded-2xl shadow-2xl border border-slate-100">
                  <DropdownMenuLabel className="text-[10px] font-black uppercase tracking-widest text-slate-400 p-2">Visibilidad de Columnas</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {Object.entries(activeTab === 'ops' ? OPS_COL_DEFS : PRE_COL_DEFS).map(([key, def]) => (
                    def.label && (
                      <DropdownMenuCheckboxItem
                        key={key}
                        checked={!hiddenColumns.includes(key)}
                        onCheckedChange={() => toggleColumnVisibility(key)}
                        className="text-xs font-bold text-slate-600 rounded-lg hover:bg-slate-50 cursor-pointer"
                      >
                        {def.label}
                      </DropdownMenuCheckboxItem>
                    )
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {selectedOrders.size > 0 && (
            <div className="flex items-center gap-4 bg-slate-100 px-4 py-1.5 rounded-2xl animate-in fade-in slide-in-from-right-4">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                {selectedOrders.size} {t('selected')}
              </span>
              <div className="w-px h-4 bg-slate-300" />
              <div className="flex gap-2">
                <button 
                  onClick={handleExportExcel}
                  className="p-2 hover:bg-white rounded-lg text-emerald-600 transition-all"
                  title={t('export_excel')}
                >
                  <Download className="w-4 h-4" />
                </button>
                <button 
                  onClick={handleExportPdf}
                  className="p-2 hover:bg-white rounded-lg text-red-600 transition-all"
                  title="Exportar PDF"
                >
                  <Printer className="w-4 h-4" />
                </button>
                <button 
                  onClick={handleBulkDelete}
                  className="p-2 hover:bg-white rounded-lg text-slate-600 hover:text-red-600 transition-all"
                  title={t('delete_selected')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setSelectedOrders(new Set())}
                  className="p-2 hover:bg-white rounded-lg text-slate-400 transition-all"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </nav>

      <main className="max-w-7xl mx-auto px-8 mt-10">
        {activeTab === 'ops' ? (
          <div className="space-y-10">
            {/* SEARCH BAR */}
            <section className="bg-white rounded-[2rem] border border-slate-200 p-8 shadow-xl shadow-slate-200/40 relative">
            <div className="flex items-center gap-4 mb-6">
               <Search className="w-5 h-5 text-emerald-500" />
               <h2 className="text-lg font-black uppercase tracking-tight text-slate-900">Registrar Trabajo de Orden</h2>
            </div>
            
            <div className="relative">
              <input 
                type="text"
                placeholder="Escribe el número de orden (ej: 12345)..."
                className="w-full bg-slate-50 border-2 border-slate-100 rounded-2xl py-4 px-6 text-lg font-bold text-slate-900 focus:border-emerald-500 outline-none transition-all"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
              />
              {isSearching && <Loader2 className="absolute right-6 top-5 w-6 h-6 text-emerald-500 animate-spin" />}
            </div>

            {/* SEARCH RESULTS DROPDOWN */}
            {searchResults.length > 0 && searchQuery.length >= 3 && (
              <div className="absolute left-8 right-8 mt-2 bg-white border border-slate-200 rounded-2xl shadow-2xl z-50 overflow-hidden divide-y divide-slate-100">
                {searchResults.map(order => (
                  <div key={order.order_id} className="p-4 hover:bg-slate-50 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-black text-slate-900">#{order.order_number}</span>
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest bg-slate-100 px-2 py-0.5 rounded-full">{order.board}</span>
                      </div>
                      <p className="text-sm font-medium text-slate-500">{order.client}</p>
                    </div>
                    
                    <div className="flex gap-2">
                      <button 
                        onClick={() => logWork(order, 'SEPARATION')}
                        disabled={actionLoading}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${order.art_sep_status ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
                      >
                        {actionLoading === `${order.order_id}-SEPARATION` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
                        {order.art_sep_status ? 'Separación Hecha' : 'Log Separación'}
                      </button>
                      <button 
                        onClick={() => logWork(order, 'NECK')}
                        disabled={actionLoading}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${order.art_neck_status ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                      >
                        {actionLoading === `${order.order_id}-NECK` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Tag className="w-3 h-3" />}
                        {order.art_neck_status ? 'Neck Hecho' : 'Log Neck'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* PENDING ORDERS TABLE */}
          <section className="space-y-6">
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-3">
                <div className="w-1.5 h-6 bg-emerald-500 rounded-full" />
                <h2 className="text-xl font-black uppercase tracking-tighter text-slate-900">
                  Pendientes de Arte ({pendingOrders.filter(o => !o.is_preorder).length})
                </h2>
              </div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Priorizado por entrega</span>
            </div>

            <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-xl shadow-slate-200/40">
              <div className="max-h-[calc(100vh-450px)] overflow-auto scrollbar-thin scrollbar-thumb-slate-200">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 z-20 bg-white">
                    <tr className="bg-slate-50/80 backdrop-blur-sm border-b border-slate-100">
                      {columnOrder.ops.filter(key => !hiddenColumns.includes(key)).map(colKey => {
                        const def = OPS_COL_DEFS[colKey];
                        if (colKey === 'selection') return (
                          <th key="selection" className="py-5 px-6 w-10">
                            <button 
                              onClick={() => toggleSelectAll(pendingOrders.filter(o => !o.is_preorder))}
                              className="text-slate-400 hover:text-slate-600 transition-colors"
                            >
                              {pendingOrders.filter(o => !o.is_preorder).length > 0 && pendingOrders.filter(o => !o.is_preorder).every(o => selectedOrders.has(o.order_id)) 
                                ? <CheckSquare className="w-4 h-4 text-emerald-500" /> 
                                : <Square className="w-4 h-4" />}
                            </button>
                          </th>
                        );
                        return (
                          <th 
                            key={colKey} 
                            draggable
                            onDragStart={() => handleColumnDragStart(colKey)}
                            onDragOver={(e) => handleColumnDragOver(e, colKey, 'ops')}
                            onDragEnd={() => setDraggedCol(null)}
                            className={`py-5 px-6 text-[10px] font-black uppercase tracking-widest text-slate-400 cursor-move transition-colors hover:bg-slate-100/50 group ${def.align === 'center' ? 'text-center' : ''}`}
                          >
                            <div className="flex items-center gap-2">
                              <GripVertical className="w-3 h-3 opacity-30 group-hover:opacity-100 transition-opacity" />
                              {def.label}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {pendingOrders.filter(o => !o.is_preorder).map(order => (
                      <tr key={order.order_id} className={`hover:bg-slate-50/30 transition-colors group ${selectedOrders.has(order.order_id) ? 'bg-emerald-50/50' : ''}`}>
                        {columnOrder.ops.filter(key => !hiddenColumns.includes(key)).map(colKey => {
                          if (colKey === 'selection') return (
                            <td key="selection" className="py-4 px-6">
                              <button 
                                onClick={() => toggleSelect(order.order_id)}
                                className={`transition-colors ${selectedOrders.has(order.order_id) ? 'text-emerald-500' : 'text-slate-300 group-hover:text-slate-400'}`}
                              >
                                {selectedOrders.has(order.order_id) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                              </button>
                            </td>
                          );
                          if (colKey === 'order_number') return (
                            <td key="order_number" className="py-4 px-6">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-black text-slate-900">#{order.order_number}</span>
                                {order.priority === 'RUSH' && <span className="bg-amber-100 text-amber-600 text-[7px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest">RUSH</span>}
                              </div>
                              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">{order.board}</p>
                            </td>
                          );
                          if (colKey === 'client') return (
                            <td key="client" className="py-4 px-6 text-[11px] font-bold text-slate-500 uppercase tracking-tight max-w-[120px] truncate">
                              {order.client}
                            </td>
                          );
                          if (colKey === 'artwork_status') return (
                            <td key="artwork_status" className="py-4 px-6">
                              <EditableCell value={order.artwork_status} field="artwork_status" orderId={order.order_id} options={options.artwork_statuses} onUpdate={handleCellUpdate} />
                            </td>
                          );
                          if (colKey === 'betty_column') return (
                            <td key="betty_column" className="py-4 px-6">
                              <EditableCell value={order.betty_column} field="betty_column" orderId={order.order_id} options={options.betty_columns} onUpdate={handleCellUpdate} />
                            </td>
                          );
                          if (colKey === 'job_title_a') return (
                            <td key="job_title_a" className="py-4 px-6">
                              <EditableCell value={order.job_title_a} field="job_title_a" orderId={order.order_id} onUpdate={handleCellUpdate} type="link_desc" />
                            </td>
                          );
                          if (colKey === 'job_title_b') return (
                            <td key="job_title_b" className="py-4 px-6">
                              <EditableCell value={order.job_title_b} field="job_title_b" orderId={order.order_id} onUpdate={handleCellUpdate} type="link_desc" />
                            </td>
                          );
                          if (colKey === 'cancel_date') return (
                            <td key="cancel_date" className="py-4 px-6">
                              <EditableCell value={order.cancel_date} field="cancel_date" orderId={order.order_id} onUpdate={handleCellUpdate} type="date" />
                            </td>
                          );
                          if (colKey === 'actions') return (
                            <td key="actions" className="py-4 px-6">
                              <div className="flex gap-2 justify-center">
                                {!order.art_sep_status ? (
                                  <button onClick={() => logWork(order, 'SEPARATION')} disabled={actionLoading === `${order.order_id}-SEPARATION`} className="w-10 h-10 bg-emerald-50 hover:bg-emerald-500 text-emerald-600 hover:text-white rounded-xl transition-all flex items-center justify-center border border-emerald-100">
                                    {actionLoading === `${order.order_id}-SEPARATION` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
                                  </button>
                                ) : <div className="w-10 h-10 bg-emerald-500 text-white rounded-xl flex items-center justify-center opacity-40"><CheckCircle2 className="w-4 h-4" /></div>}
                                {!order.art_neck_status ? (
                                  <button onClick={() => logWork(order, 'NECK')} disabled={actionLoading === `${order.order_id}-NECK`} className="w-10 h-10 bg-blue-50 hover:bg-blue-500 text-blue-600 hover:text-white rounded-xl transition-all flex items-center justify-center border border-blue-100">
                                    {actionLoading === `${order.order_id}-NECK` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tag className="w-4 h-4" />}
                                  </button>
                                ) : <div className="w-10 h-10 bg-blue-500 text-white rounded-xl flex items-center justify-center opacity-40"><CheckCircle2 className="w-4 h-4" /></div>}
                              </div>
                            </td>
                          );
                          return null;
                        })}
                      </tr>
                    ))}
                    
                    {pendingOrders.filter(o => !o.is_preorder).length === 0 && (
                      <tr>
                        <td colSpan="9" className="py-20 text-center">
                          <div className="flex flex-col items-center justify-center text-slate-300 gap-4">
                            <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center text-emerald-300">
                              <CheckCircle2 className="w-8 h-8" />
                            </div>
                            <div className="text-center">
                              <p className="text-sm font-black uppercase tracking-widest text-slate-900">¡Todo al día!</p>
                              <p className="text-xs font-bold text-slate-400 mt-1 uppercase tracking-tight">No hay órdenes con arte pendiente.</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      ) : activeTab === 'preorders' ? (
        <div className="space-y-10">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-black uppercase tracking-tighter text-slate-900">Gestión de Pre-Órdenes</h2>
              <p className="text-sm font-bold text-slate-400 uppercase tracking-tight">Adelanta el arte de trabajos que aún no tienen número de orden oficial.</p>
            </div>
            <button 
              onClick={() => setShowPreOrderModal(true)}
              className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white px-6 py-3 rounded-2xl font-black uppercase tracking-widest text-xs shadow-lg shadow-amber-500/20 transition-all"
            >
              <Plus className="w-4 h-4" />
              Nueva Pre-Orden
            </button>
          </div>

          <section className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-xl shadow-slate-200/40">
            <div className="max-h-[calc(100vh-350px)] overflow-auto scrollbar-thin scrollbar-thumb-slate-200">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-20 bg-white">
                  <tr className="bg-amber-50/50 backdrop-blur-sm border-b border-amber-100">
                    {columnOrder.preorders.filter(key => !hiddenColumns.includes(key)).map(colKey => {
                      const def = PRE_COL_DEFS[colKey];
                      if (colKey === 'selection') return (
                        <th key="selection" className="py-5 px-6 w-10">
                          <button 
                            onClick={() => toggleSelectAll(pendingOrders.filter(o => o.is_preorder))}
                            className="text-amber-400 hover:text-amber-600 transition-colors"
                          >
                            {pendingOrders.filter(o => o.is_preorder).length > 0 && pendingOrders.filter(o => o.is_preorder).every(o => selectedOrders.has(o.order_id)) 
                              ? <CheckSquare className="w-4 h-4 text-amber-600" /> 
                              : <Square className="w-4 h-4" />}
                          </button>
                        </th>
                      );
                      return (
                        <th 
                          key={colKey} 
                          draggable
                          onDragStart={() => handleColumnDragStart(colKey)}
                          onDragOver={(e) => handleColumnDragOver(e, colKey, 'preorders')}
                          onDragEnd={() => setDraggedCol(null)}
                          className={`py-5 px-6 text-[10px] font-black uppercase tracking-widest text-amber-700 cursor-move transition-colors hover:bg-amber-100/30 group ${def.align === 'center' ? 'text-center' : ''}`}
                        >
                          <div className="flex items-center gap-2">
                             <GripVertical className="w-3 h-3 opacity-30" />
                             {def.label}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {pendingOrders.filter(o => o.is_preorder).map(order => (
                    <tr key={order.order_id} className={`hover:bg-amber-50/20 transition-colors group ${selectedOrders.has(order.order_id) ? 'bg-amber-50' : ''}`}>
                      {columnOrder.preorders.filter(key => !hiddenColumns.includes(key)).map(colKey => {
                        if (colKey === 'selection') return (
                          <td key="selection" className="py-4 px-6">
                            <button 
                              onClick={() => toggleSelect(order.order_id)}
                              className={`transition-colors ${selectedOrders.has(order.order_id) ? 'text-amber-600' : 'text-slate-300 group-hover:text-slate-400'}`}
                            >
                              {selectedOrders.has(order.order_id) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                            </button>
                          </td>
                        );
                        if (colKey === 'order_number') return (
                          <td key="order_number" className="py-4 px-6">
                            <EditableCell value={order.order_number} field="order_number" orderId={order.order_id} onUpdate={handleCellUpdate} className="font-black text-slate-900" />
                            <p className="text-[8px] font-black text-amber-600 uppercase tracking-widest mt-1">Pre-Orden</p>
                          </td>
                        );
                        if (colKey === 'client') return (
                          <td key="client" className="py-4 px-6 text-[11px] font-bold text-slate-500 uppercase tracking-tight max-w-[120px] truncate">{order.client}</td>
                        );
                        if (colKey === 'artwork_status') return (
                          <td key="artwork_status" className="py-4 px-6"><EditableCell value={order.artwork_status} field="artwork_status" orderId={order.order_id} options={options.artwork_statuses} onUpdate={handleCellUpdate} /></td>
                        );
                        if (colKey === 'betty_column') return (
                          <td key="betty_column" className="py-4 px-6"><EditableCell value={order.betty_column} field="betty_column" orderId={order.order_id} options={options.betty_columns} onUpdate={handleCellUpdate} /></td>
                        );
                        if (colKey === 'job_title_a') return (
                          <td key="job_title_a" className="py-4 px-6"><EditableCell value={order.job_title_a} field="job_title_a" orderId={order.order_id} onUpdate={handleCellUpdate} type="link_desc" /></td>
                        );
                        if (colKey === 'cancel_date') return (
                          <td key="cancel_date" className="py-4 px-6"><EditableCell value={order.cancel_date} field="cancel_date" orderId={order.order_id} onUpdate={handleCellUpdate} type="date" /></td>
                        );
                        if (colKey === 'actions') return (
                          <td key="actions" className="py-4 px-6">
                            <div className="flex gap-2 justify-center">
                              <button onClick={() => logWork(order, 'SEPARATION')} className="w-10 h-10 bg-emerald-50 hover:bg-emerald-500 text-emerald-600 hover:text-white rounded-xl transition-all flex items-center justify-center border border-emerald-100"><Layers className="w-4 h-4" /></button>
                              <button onClick={() => logWork(order, 'NECK')} className="w-10 h-10 bg-blue-50 hover:bg-blue-500 text-blue-600 hover:text-white rounded-xl transition-all flex items-center justify-center border border-blue-100"><Tag className="w-4 h-4" /></button>
                            </div>
                          </td>
                        );
                        return null;
                      })}
                    </tr>
                  ))}
                  {pendingOrders.filter(o => o.is_preorder).length === 0 && (
                    <tr>
                      <td colSpan={columnOrder.preorders.filter(key => !hiddenColumns.includes(key)).length} className="py-20 text-center">
                        <div className="flex flex-col items-center justify-center text-slate-300 gap-4">
                          <div className="w-16 h-16 bg-amber-50 rounded-full flex items-center justify-center text-amber-300">
                            <AlertCircle className="w-8 h-8" />
                          </div>
                          <div className="text-center">
                            <p className="text-sm font-black uppercase tracking-widest text-slate-900">No hay pre-órdenes</p>
                            <p className="text-xs font-bold text-slate-400 mt-1 uppercase tracking-tight">Crea una para empezar a adelantar trabajo.</p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : (
          /* KPI TAB CONTENT */
          <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* TOP ROW: KPI CARDS & RECENT ACTIVITY */}
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              {/* STATS CARDS */}
              <div className="lg:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm hover:shadow-md transition-all">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Total Separaciones (Periodo)</p>
                  <p className="text-4xl font-black text-emerald-600">
                    {historyStats[historyRange].reduce((acc, curr) => acc + curr.separations, 0)}
                  </p>
                </div>
                <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm hover:shadow-md transition-all">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Total Necks (Periodo)</p>
                  <p className="text-4xl font-black text-blue-600">
                    {historyStats[historyRange].reduce((acc, curr) => acc + curr.necks, 0)}
                  </p>
                </div>
                <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm hover:shadow-md transition-all">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Promedio Diario</p>
                  <p className="text-4xl font-black text-slate-900">
                    {Math.round(historyStats[historyRange].reduce((acc, curr) => acc + curr.separations + curr.necks, 0) / (historyStats[historyRange].length || 1))}
                  </p>
                </div>
              </div>

              {/* RECENT ACTIVITY (MOVED HERE) */}
              <aside className="lg:row-span-2 space-y-6">
                <div className="flex items-center gap-3 px-2">
                   <div className="w-1.5 h-6 bg-slate-400 rounded-full" />
                   <h2 className="text-lg font-black uppercase tracking-tighter text-slate-900">Actividad Reciente</h2>
                </div>

                <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm max-h-[800px] overflow-y-auto scrollbar-none">
                  <div className="p-6 divide-y divide-slate-50">
                    {dailyStats.recent_logs.map(log => (
                      <div key={log.log_id} className="py-4 first:pt-0 last:pb-0">
                        <div className="flex justify-between items-start mb-1">
                          <div className="flex items-center gap-2">
                            <span className="font-black text-slate-900 text-sm">#{log.order_number}</span>
                            {log.is_preorder && (
                              <span className="text-[7px] font-black bg-amber-500 text-white px-1 py-0.5 rounded uppercase tracking-widest">PRE</span>
                            )}
                          </div>
                          <span className="text-[10px] text-slate-400 font-bold">{new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest ${log.type === 'SEPARATION' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                            {log.type}
                          </span>
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight truncate">{log.client}</span>
                        </div>
                        {log.user_name && log.user_name !== user.name && (
                          <p className="text-[9px] text-slate-300 mt-1 font-medium">Por: {log.user_name}</p>
                        )}
                      </div>
                    ))}
                    
                    {dailyStats.recent_logs.length === 0 && (
                      <div className="py-10 text-center text-slate-400">
                        <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-20" />
                        <p className="text-[10px] font-black uppercase tracking-widest leading-tight">No hay registros hoy</p>
                      </div>
                    )}
                  </div>
                </div>
              </aside>

              {/* MAIN CHART */}
              <div className="lg:col-span-3">
                <section className="bg-white rounded-[2rem] border border-slate-200 p-10 shadow-xl shadow-slate-200/40">
                  <div className="flex items-center justify-between mb-10">
                    <div className="flex items-center gap-4">
                      <div className="p-4 bg-emerald-50 text-emerald-600 rounded-2xl">
                        <BarChart2 className="w-8 h-8" />
                      </div>
                      <div>
                        <h2 className="text-2xl font-black uppercase tracking-tight text-slate-900">Métricas de Productividad</h2>
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Análisis histórico detallado</p>
                      </div>
                    </div>

                    <div className="flex bg-slate-100 p-2 rounded-2xl gap-2">
                      {['daily', 'weekly', 'monthly'].map(range => (
                        <button
                          key={range}
                          onClick={() => setHistoryRange(range)}
                          className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] transition-all ${historyRange === range ? 'bg-white text-slate-900 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                          {range === 'daily' ? 'Diario' : range === 'weekly' ? 'Semanal' : 'Mensual'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="h-[450px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={historyStats[historyRange]}>
                        <defs>
                          <linearGradient id="colorSeps" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.8}/>
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0.1}/>
                          </linearGradient>
                          <linearGradient id="colorNecks" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.1}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis 
                          dataKey="label" 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{fill: '#94a3b8', fontSize: 11, fontWeight: 'bold'}}
                          dy={15}
                        />
                        <YAxis 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{fill: '#94a3b8', fontSize: 11, fontWeight: 'bold'}}
                        />
                        <Tooltip 
                          cursor={{fill: '#f8fafc'}}
                          contentStyle={{ borderRadius: '1.5rem', border: 'none', boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.15)', padding: '1.5rem' }}
                        />
                        <Legend 
                          verticalAlign="top" 
                          align="right" 
                          iconType="circle"
                          wrapperStyle={{ paddingBottom: '30px', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.15em' }}
                        />
                        <Bar 
                          stackId="a"
                          name="Separaciones" 
                          dataKey="separations" 
                          fill="url(#colorSeps)" 
                          radius={[0, 0, 0, 0]} 
                        />
                        <Bar 
                          stackId="a"
                          name="Seps (Pre)" 
                          dataKey="separations_pre" 
                          fill="#f59e0b" 
                          radius={[10, 10, 0, 0]} 
                        />
                        <Bar 
                          stackId="b"
                          name="Necks" 
                          dataKey="necks" 
                          fill="url(#colorNecks)" 
                          radius={[0, 0, 0, 0]} 
                        />
                        <Bar 
                          stackId="b"
                          name="Necks (Pre)" 
                          dataKey="necks_pre" 
                          fill="#fbbf24" 
                          radius={[10, 10, 0, 0]} 
                          barSize={historyRange === 'daily' ? 15 : 40}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* PRE-ORDER MODAL */}
      <Dialog open={showPreOrderModal} onOpenChange={setShowPreOrderModal}>
        <DialogContent className="max-w-2xl bg-white rounded-[2rem] border-none shadow-2xl p-0 overflow-hidden">
          <form onSubmit={handleCreatePreOrder}>
            <DialogHeader className="bg-amber-500 p-8 text-white">
              <DialogTitle className="text-2xl font-black uppercase tracking-tighter flex items-center gap-3">
                <Plus className="w-6 h-6" />
                Nueva Pre-Orden
              </DialogTitle>
              <p className="text-amber-100 text-xs font-bold uppercase tracking-widest mt-1">Crea una orden temporal para adelantar arte</p>
            </DialogHeader>
            
            <div className="p-8 space-y-6">
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <User className="w-3 h-3" /> Cliente
                  </label>
                  <SearchableSelect 
                    options={options.clients || []}
                    value={preOrderData.client}
                    onChange={(val) => setPreOrderData({...preOrderData, client: val})}
                    placeholder="Seleccionar Cliente"
                    allowCreate={false}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <Calendar className="w-3 h-3" /> Cancel Date (Est.)
                  </label>
                  <input 
                    type="date"
                    className="w-full bg-slate-50 border-2 border-slate-100 rounded-xl p-3 text-sm font-bold outline-none focus:border-amber-500"
                    value={preOrderData.cancel_date}
                    onChange={(e) => setPreOrderData({...preOrderData, cancel_date: e.target.value})}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                  <FileText className="w-3 h-3" /> Job Title / Diseño
                </label>
                <input 
                  type="text"
                  placeholder="Nombre del diseño o descripción..."
                  className="w-full bg-slate-50 border-2 border-slate-100 rounded-xl p-3 text-sm font-bold outline-none focus:border-amber-500"
                  value={preOrderData.job_title_a}
                  onChange={(e) => setPreOrderData({...preOrderData, job_title_a: e.target.value})}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    Artwork Status
                  </label>
                  <SearchableSelect 
                    options={options.artwork_statuses || []}
                    value={preOrderData.artwork_status}
                    onChange={(val) => setPreOrderData({...preOrderData, artwork_status: val})}
                    placeholder="Status"
                    allowCreate={false}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    Betty Column
                  </label>
                  <SearchableSelect 
                    options={options.betty_columns || []}
                    value={preOrderData.betty_column}
                    onChange={(val) => setPreOrderData({...preOrderData, betty_column: val})}
                    placeholder="Seleccionar..."
                    allowCreate={false}
                  />
                </div>
              </div>
            </div>

            <DialogFooter className="p-8 bg-slate-50 flex gap-4">
              <button 
                type="button"
                onClick={() => setShowPreOrderModal(false)}
                className="flex-1 py-4 text-xs font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 transition-all"
              >
                Cancelar
              </button>
              <button 
                type="submit"
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-4 rounded-2xl text-xs font-black uppercase tracking-widest shadow-lg shadow-amber-500/20 transition-all"
              >
                Crear Pre-Orden
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ArtModule;
