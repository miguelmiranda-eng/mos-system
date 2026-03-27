import React, { useState, useCallback, useEffect, useRef } from "react";
import { useAuth } from "../App";
import { useLang } from "../contexts/LanguageContext";
import {
  Search, Plus, LogOut, X, RefreshCw, Trash2,
  Download, Sun, Moon, Settings, GripVertical, PlusCircle,
  BarChart3, UserPlus, Bell, Eye, EyeOff, CalendarDays, CalendarCheck, Pin, Save, Table2, Undo2,
  Factory, GanttChart, TrendingUp, Languages, Monitor, MessageSquare, Loader2, History, Zap, AtSign, AlertTriangle, Users, ClipboardList, DatabaseBackup, Warehouse, ImageDown, ImageUp, FileJson, ArrowRightLeft
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Toaster, toast } from "sonner";
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';

// Sub-components
import { LoadingOverlay } from "./dashboard/LoadingOverlay";
import { ColoredBadge } from "./dashboard/ColoredBadge";
import { EditableCell } from "./dashboard/EditableCell";
import { CommentsModal } from "./dashboard/CommentsModal";
import { NewOrderModal } from "./dashboard/NewOrderModal";
import { AddColumnModal } from "./dashboard/AddColumnModal";
import { AutomationsModal } from "./dashboard/AutomationsModal";
import { ActivityLogModal } from "./dashboard/ActivityLogModal";
import { OptionsManagerModal } from "./dashboard/OptionsManagerModal";
import { OperatorsManagerModal } from "./dashboard/OperatorsManagerModal";
import { FormFieldsManagerModal } from "./dashboard/FormFieldsManagerModal";

// Existing top-level components
import AnalyticsView from "./AnalyticsView";
import InviteUsersModal from "./InviteUsersModal";
import CalendarView from "./CalendarView";
import BlanksTrackingView from "./BlanksTrackingView";
import ProductionModal from "./ProductionModal";
import GanttView from "./GanttView";
import CapacityPlanModal from "./CapacityPlanModal";
import ProductionScreen from "./ProductionScreen";

// Shared constants and hooks
import { BOARDS, BOARD_COLORS, FILTER_COLUMNS, STATUS_COLORS, getBoardStyle, evaluateFormula, API } from "../lib/constants";
import { useOrders } from "../hooks/useOrders";

const Dashboard = () => {
  const { user, logout } = useAuth();
  const { t, lang, toggleLang } = useLang();

  // Board & filter state
  const [currentBoard, setCurrentBoard] = useState("SCHEDULING");
  const [boardFilters, setBoardFilters] = useState({});
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('theme');
    return saved ? saved === 'dark' : true;
  });

  // Column visibility & ordering
  const [hiddenColumns, setHiddenColumns] = useState({});
  const [boardColumnOrders, setBoardColumnOrders] = useState({});
  const [showColumnManager, setShowColumnManager] = useState(false);
  const [draggedCol, setDraggedCol] = useState(null);

  // Modal visibility
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [commentsOrder, setCommentsOrder] = useState(null);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showOptionsManager, setShowOptionsManager] = useState(false);
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showSaveView, setShowSaveView] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [calendarMode, setCalendarMode] = useState(false);
  const [blanksTrackingMode, setBlanksTrackingMode] = useState(false);
  const [readyCalendarMode, setReadyCalendarMode] = useState(false);
  const [blanksOrders, setBlanksOrders] = useState([]);
  const [readyOrders, setReadyOrders] = useState([]);
  const [showProduction, setShowProduction] = useState(false);
  const [showGantt, setShowGantt] = useState(false);
  const [showCapacityPlan, setShowCapacityPlan] = useState(false);
  const [showProductionScreen, setShowProductionScreen] = useState(false);
  const [showOperators, setShowOperators] = useState(false);
  const [showFormFields, setShowFormFields] = useState(false);
  const [showBoardVisibility, setShowBoardVisibility] = useState(false);
  const [savedViews, setSavedViews] = useState({});
  const [activeViewName, setActiveViewName] = useState(null);
  const activeViewIdRef = useRef(null);
  const viewApplyingRef = useRef(false);
  const [trashOrders, setTrashOrders] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [groupByDate, setGroupByDate] = useState(null);
  const [openFilterKey, setOpenFilterKey] = useState(null);
  const [searchResults, setSearchResults] = useState(null);
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [deleteBoardConfirm, setDeleteBoardConfirm] = useState(null); // null | { step: 1|2, name: string }

  // Core data hook
  const {
    orders, setOrders, allOrders, unfilteredOrders, loading, operationLoading, setOperationLoading,
    options, productionSummary, notifications, unreadCount, markNotificationsRead,
    automationRunning, automationMessage, columns, columnWidths, setColumnWidths,
    fetchOrders, fetchAllOrders, fetchOptions, fetchProductionSummary,
    handleCellUpdate, handleBulkMove, handleQuickUndo, handleGlobalSearch,
    handleAddColumn, handleDeleteColumn, saveCustomColumns,
    dynamicBoards, hiddenBoards, createBoard, deleteBoard, fetchBoards, toggleBoardVisibility,
  } = useOrders(currentBoard, boardFilters);

  const activeBoards = (dynamicBoards.length > 0 ? dynamicBoards : BOARDS).filter(b => !hiddenBoards.includes(b));
  const allBoardsIncludingHidden = dynamicBoards.length > 0 ? dynamicBoards : BOARDS;

  const isAdmin = user?.role === 'admin';
  const filters = boardFilters[currentBoard] || {};

  // Board permissions for non-admin users
  const [myBoardPerms, setMyBoardPerms] = useState({});
  useEffect(() => {
    if (!isAdmin && user) {
      fetch(`${API}/board-permissions/me`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : {}).then(setMyBoardPerms).catch(() => { });
    }
  }, [isAdmin, user]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleBoards = isAdmin ? activeBoards : activeBoards.filter(b => (myBoardPerms[b] || 'edit') !== 'none');
  const canEditBoard = isAdmin || (myBoardPerms[currentBoard] || 'edit') === 'edit';
  const setFilters = (updater) => {
    setBoardFilters(prev => ({ ...prev, [currentBoard]: typeof updater === 'function' ? updater(prev[currentBoard] || {}) : updater }));
  };

  // Close filter dropdown on outside click
  const filterRef = useRef(null);
  useEffect(() => {
    if (!openFilterKey) return;
    const handler = (e) => { if (!e.target.closest('[data-testid^="filter-"]')) setOpenFilterKey(null); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openFilterKey]);

  // Auto-load MASTER view config per user
  const masterConfigLoaded = useRef(false);
  useEffect(() => {
    if (currentBoard !== 'MASTER' || masterConfigLoaded.current) return;
    const loadMasterConfig = async () => {
      try {
        const res = await fetch(`${API}/user-view-config/MASTER`, { credentials: 'include' });
        if (res.ok) {
          const config = await res.json();
          if (config.user_id) {
            if (config.filters && Object.keys(config.filters).length > 0) setBoardFilters(prev => ({ ...prev, MASTER: config.filters }));
            if (config.group_by_date) setGroupByDate(config.group_by_date);
            masterConfigLoaded.current = true;
          }
        }
      } catch { /* silent */ }
    };
    loadMasterConfig();
  }, [currentBoard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save MASTER view config per user (debounced)
  const saveTimerRef = useRef(null);
  useEffect(() => {
    if (currentBoard !== 'MASTER') return;
    if (!masterConfigLoaded.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const configPayload = {
        filters: boardFilters['MASTER'] || {},
        group_by_date: groupByDate
      };
      fetch(`${API}/user-view-config/MASTER`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(configPayload)
      }).catch(() => { });
    }, 1500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [currentBoard, boardFilters, groupByDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load user's personal board layout (column_order + hidden_columns)
  const layoutLoaded = useRef({});
  useEffect(() => {
    if (layoutLoaded.current[currentBoard]) return;
    const loadLayout = async () => {
      try {
        const res = await fetch(`${API}/config/board-layout/${currentBoard}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.board) {
            if (data.column_order?.length) setBoardColumnOrders(prev => ({ ...prev, [currentBoard]: data.column_order }));
            if (data.hidden_columns?.length) setHiddenColumns(prev => ({ ...prev, [currentBoard]: data.hidden_columns }));
            layoutLoaded.current[currentBoard] = true;
          }
        }
      } catch { /* silent */ }
    };
    loadLayout();
  }, [currentBoard]);

  // Auto-save personal layout when user changes columns (debounced)
  const layoutSaveRef = useRef(null);
  const layoutInitRef = useRef(false);
  useEffect(() => {
    if (!layoutLoaded.current[currentBoard] && !layoutInitRef.current) { layoutInitRef.current = true; return; }
    if (layoutSaveRef.current) clearTimeout(layoutSaveRef.current);
    layoutSaveRef.current = setTimeout(() => {
      fetch(`${API}/config/board-layout/${currentBoard}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ column_order: boardColumnOrders[currentBoard] || [], hidden_columns: hiddenColumns[currentBoard] || [] })
      }).catch(() => { });
    }, 800);
    return () => { if (layoutSaveRef.current) clearTimeout(layoutSaveRef.current); };
  }, [boardColumnOrders, hiddenColumns, currentBoard]);

  // Theme
  useState(() => {
    if (isDark) { document.documentElement.classList.remove('light-theme'); document.documentElement.classList.add('dark'); }
    else { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light-theme'); }
  });

  // Fetch BLANKS + READY TO SCHEDULE orders for views in SCHEDULING
  useEffect(() => {
    if (currentBoard !== 'SCHEDULING') return;
    const fetchExtra = async () => {
      try {
        const [bRes, rRes] = await Promise.all([
          fetch(`${API}/orders?board=BLANKS`, { credentials: 'include' }),
          fetch(`${API}/orders?board=READY TO SCHEDULED`, { credentials: 'include' })
        ]);
        if (bRes.ok) setBlanksOrders(await bRes.json());
        if (rRes.ok) setReadyOrders(await rRes.json());
      } catch { }
    };
    fetchExtra();
  }, [currentBoard, orders]);
  const toggleTheme = () => {
    setIsDark(prev => {
      const next = !prev;
      localStorage.setItem('theme', next ? 'dark' : 'light');
      if (next) { document.documentElement.classList.remove('light-theme'); document.documentElement.classList.add('dark'); }
      else { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light-theme'); }
      return next;
    });
  };

  // Visible columns
  const visibleColumns = (() => {
    const hidden = hiddenColumns[currentBoard] || [];
    const order = boardColumnOrders[currentBoard];
    let cols = columns.filter(c => !hidden.includes(c.key));
    if (order) { cols = order.map(key => cols.find(c => c.key === key)).filter(Boolean); const ordered = new Set(order); cols = [...cols, ...columns.filter(c => !ordered.has(c.key) && !hidden.includes(c.key))]; }
    return cols;
  })();

  // Saved views
  const fetchSavedViews = useCallback(async () => {
    try { const res = await fetch(`${API}/saved-views`, { credentials: 'include' }); if (res.ok) { const data = await res.json(); const grouped = {}; data.forEach(v => { if (!grouped[v.board]) grouped[v.board] = []; grouped[v.board].push(v); }); setSavedViews(grouped); } } catch { /* silent */ }
  }, []);
  useState(() => { fetchSavedViews(); });

  const handleSaveView = async () => {
    if (!newViewName.trim()) return;
    try { await fetch(`${API}/saved-views`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: newViewName.trim(), board: currentBoard, filters, pinned: false }) }); toast.success(`${t('save_view')}: "${newViewName}"`); setNewViewName(''); setShowSaveView(false); fetchSavedViews(); } catch { toast.error(t('save_view_err')); }
  };
  const handleApplyView = (view) => {
    viewApplyingRef.current = true;
    if (view === null) { setFilters({}); setActiveViewName(null); activeViewIdRef.current = null; }
    else { setFilters(view.filters || {}); setActiveViewName(view.name); activeViewIdRef.current = view.view_id; }
  };
  const handleTogglePinView = async (viewId, pinned) => { try { await fetch(`${API}/saved-views/${viewId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ pinned: !pinned }) }); fetchSavedViews(); } catch { /* silent */ } };
  const handleDeleteView = async (viewId) => { try { await fetch(`${API}/saved-views/${viewId}`, { method: 'DELETE', credentials: 'include' }); fetchSavedViews(); toast.success(t('view_deleted')); } catch { /* silent */ } };

  // Auto-update saved view when user manually modifies filters while a view is active
  const viewAutoSaveRef = useRef(null);
  useEffect(() => {
    if (viewApplyingRef.current) { viewApplyingRef.current = false; return; }
    const viewId = activeViewIdRef.current;
    if (!viewId || !activeViewName) return;
    if (viewAutoSaveRef.current) clearTimeout(viewAutoSaveRef.current);
    viewAutoSaveRef.current = setTimeout(() => {
      fetch(`${API}/saved-views/${viewId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ filters })
      }).then(() => fetchSavedViews()).catch(() => { });
    }, 1200);
    return () => { if (viewAutoSaveRef.current) clearTimeout(viewAutoSaveRef.current); };
  }, [filters, activeViewName, fetchSavedViews]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentBoardViews = savedViews[currentBoard] || [];
  const pinnedViews = currentBoardViews.filter(v => v.pinned);
  const unpinnedViews = currentBoardViews.filter(v => !v.pinned);

  // Selection
  const handleSelectAll = () => setSelectedOrders(orders.map(o => o.order_id));
  const handleDeselectAll = () => setSelectedOrders([]);
  const toggleOrderSelection = (orderId) => { setSelectedOrders(prev => prev.includes(orderId) ? prev.filter(id => id !== orderId) : [...prev, orderId]); };

  // Column drag
  const handleColumnDragStart = (colKey) => setDraggedCol(colKey);
  const handleColumnDragOver = (e, targetKey) => {
    e.preventDefault();
    if (!draggedCol || draggedCol === targetKey) return;
    const allKeys = visibleColumns.map(c => c.key);
    const savedOrder = boardColumnOrders[currentBoard];
    let currentOrder = savedOrder ? [...savedOrder.filter(k => allKeys.includes(k)), ...allKeys.filter(k => !new Set(savedOrder).has(k))] : allKeys;
    const dragIdx = currentOrder.indexOf(draggedCol);
    const targetIdx = currentOrder.indexOf(targetKey);
    if (dragIdx === -1 || targetIdx === -1) return;
    const newOrder = [...currentOrder]; newOrder.splice(dragIdx, 1); newOrder.splice(targetIdx, 0, draggedCol);
    setBoardColumnOrders(prev => ({ ...prev, [currentBoard]: newOrder }));
  };
  const handleColumnDragEnd = () => setDraggedCol(null);

  const handleToggleColumnVisibility = (colKey) => {
    setHiddenColumns(prev => { const boardHidden = prev[currentBoard] || []; const isHidden = boardHidden.includes(colKey); return { ...prev, [currentBoard]: isHidden ? boardHidden.filter(k => k !== colKey) : [...boardHidden, colKey] }; });
  };

  // Trash
  const fetchTrashOrders = async () => {
    setTrashLoading(true);
    try { const res = await fetch(`${API}/orders?board=PAPELERA DE RECICLAJE`, { credentials: 'include' }); if (res.ok) setTrashOrders(await res.json()); } catch { toast.error(t('trash_load_err')); } finally { setTrashLoading(false); }
  };
  const handleRestoreFromTrash = async (orderIds, targetBoard = 'SCHEDULING') => {
    setOperationLoading(true);
    try { await fetch(`${API}/orders/bulk-move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ order_ids: orderIds, board: targetBoard }) }); toast.success(`${orderIds.length} ${t('orders')} → ${targetBoard}`); fetchTrashOrders(); fetchOrders(); } catch { toast.error(t('restore_err')); } finally { setOperationLoading(false); }
  };
  const handlePermanentDelete = async (orderIds) => {
    if (!window.confirm(t('permanent_delete') + ` ${orderIds.length}?`)) return;
    setOperationLoading(true);
    try { for (const oid of orderIds) { await fetch(`${API}/orders/${oid}/permanent`, { method: 'DELETE', credentials: 'include' }); } toast.success(`${orderIds.length} ${t('orders')} ${t('delete').toLowerCase()}`); fetchTrashOrders(); } catch { toast.error(t('perm_del_err')); } finally { setOperationLoading(false); }
  };

  // Export
  const handleExportExcel = () => {
    const ordersToExport = orders.filter(o => selectedOrders.includes(o.order_id));
    if (ordersToExport.length === 0) { toast.error(t('select_export')); return; }
    try {
      const exportData = ordersToExport.map(o => { const row = {}; columns.forEach(col => { row[col.label] = o[col.key] || ''; }); row[t('board')] = o.board; return row; });
      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, t('orders'));
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `orders_export_${new Date().toISOString().split('T')[0]}.xlsx`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      toast.success(`${ordersToExport.length} ${t('orders')} exported`);
    } catch (e) { toast.error('Error exporting: ' + (e.message || '')); }
  };

  // Export Complete (with comments & images)
  const handleExportComplete = async (withImages = true) => {
    if (selectedOrders.length === 0) { toast.error(t('select_export')); return; }
    try {
      toast.info(`Exportando ${selectedOrders.length} órdenes${withImages ? ' con imágenes' : ''}...`);
      const res = await fetch(`${API}/orders/export-complete`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_ids: selectedOrders, include_comments: true, include_images: withImages })
      });
      if (!res.ok) { toast.error('Error al exportar'); return; }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.download = `orders_complete_${new Date().toISOString().split('T')[0]}.json`;
      a.click(); URL.revokeObjectURL(url);
      const imgCount = data.orders.reduce((sum, o) => sum + (o._image_files?.length || 0), 0);
      const commentCount = data.orders.reduce((sum, o) => sum + (o._comments?.length || 0), 0);
      toast.success(`${data.total} órdenes, ${commentCount} comentarios${withImages ? `, ${imgCount} imágenes` : ''} exportados`);
    } catch (e) { toast.error('Error: ' + e.message); }
  };

  // Import Complete (orders + comments + images)
  const handleImportComplete = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      toast.info('Leyendo archivo...');
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const ordersData = data.orders || [];
        if (!ordersData.length) { toast.error('No se encontraron órdenes'); return; }
        toast.info(`Importando ${ordersData.length} órdenes...`);
        const res = await fetch(`${API}/orders/import-complete`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders: ordersData })
        });
        if (res.ok) {
          const stats = await res.json();
          toast.success(`Importado: ${stats.orders} órdenes, ${stats.comments} comentarios, ${stats.images} imágenes (${stats.skipped_orders} ya existían)`);
          fetchOrders();
        } else { toast.error('Error al importar'); }
      } catch (err) { toast.error('Error: ' + err.message); }
    };
    input.click();
  };

  const EMPTY_FILTER = '—Ninguno—';
  const getFilterOptions = (col) => {
    if (col.key === 'board') return allBoardsIncludingHidden;
    const mapping = { 'blank_status': options.blank_statuses, 'production_status': options.production_statuses, 'trim_status': options.trim_statuses, 'artwork_status': options.artwork_statuses, 'client': options.clients, 'priority': options.priorities, 'sample': options.samples, 'screens': options.screens };
    let opts = mapping[col.key] || [];
    if (!opts || opts.length === 0) {
      if (col.isDate) {
        const vals = [...new Set(unfilteredOrders.map(o => {
          const v = o[col.key];
          if (!v) return null;
          try { return new Date(v).toLocaleDateString(); } catch { return String(v); }
        }).filter(v => v !== null))].sort();
        opts = vals;
      } else {
        const vals = [...new Set(unfilteredOrders.map(o => o[col.key]).filter(v => v !== null && v !== undefined && String(v) !== ''))].map(String).sort();
        opts = vals;
      }
    }
    return [...opts, EMPTY_FILTER];
  };

  return (
    <div className={`h-screen flex flex-col overflow-hidden ${isDark ? 'bg-background text-foreground' : 'bg-white text-gray-900'}`}>
      <Toaster position="bottom-right" theme={isDark ? "dark" : "light"} />
      <LoadingOverlay isLoading={operationLoading} message={t('processing')} />

      {automationRunning && (
        <div className="fixed bottom-6 right-6 z-[200] flex items-center gap-3 bg-primary text-primary-foreground px-5 py-3 rounded-lg shadow-2xl animate-pulse" data-testid="automation-running-indicator">
          <Loader2 className="w-5 h-5 animate-spin" />
          <div><div className="text-sm font-bold">Ejecutando automatizacion...</div><div className="text-xs opacity-80">{automationMessage}</div></div>
        </div>
      )}

      {/* Header */}
      <header className={`border-b px-2 md:px-4 py-2 flex items-center justify-between z-50 ${isDark ? 'glass-header border-border' : 'bg-gray-50 border-gray-200'}`}>
        <div className="flex items-center gap-3 flex-shrink-0">
          <h1 className={`font-barlow font-bold text-base md:text-lg tracking-tight uppercase ${isDark ? '' : 'text-gray-900'}`}>MOS <span className="text-primary">S</span><span className="text-primary hidden md:inline">YSTEM</span></h1>
          {/* Notifications Bell - next to logo */}
          <div>
            <button onClick={() => { setShowNotifications(!showNotifications); if (!showNotifications && unreadCount > 0) markNotificationsRead(); }} className={`p-2 rounded-lg relative flex items-center justify-center transition-all ${unreadCount > 0 ? 'text-primary' : (isDark ? 'text-muted-foreground hover:text-foreground' : 'text-gray-500 hover:text-gray-900')}`} title={t('notifications')} data-testid="notifications-btn">
              <Bell className="w-5 h-5 md:w-6 md:h-6" />
              {unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-destructive text-white text-[9px] font-bold rounded-full flex items-center justify-center px-1" data-testid="notification-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
            </button>
            {showNotifications && require('react-dom').createPortal(
              <div className={`fixed left-2 md:left-4 top-[60px] w-80 max-h-80 overflow-y-auto rounded-lg shadow-2xl border z-[99999] ${isDark ? 'bg-card border-border' : 'bg-white border-gray-200'}`} data-testid="notifications-dropdown">
                <div className="p-3 border-b border-border font-barlow font-bold text-sm uppercase tracking-wide">Notificaciones</div>
                {notifications.length > 0 ? notifications.slice(0, 20).map(n => (
                  <div key={n.notification_id} className={`p-3 border-b border-border/50 text-sm cursor-pointer hover:bg-secondary/30 ${!n.read ? 'bg-primary/5' : ''}`}
                    onClick={async () => {
                      setShowNotifications(false);
                      if (!n.order_id) return;
                      let targetOrder = allOrders.find(o => o.order_id === n.order_id);
                      if (!targetOrder) {
                        try { const res = await fetch(`${API}/orders/${n.order_id}`, { credentials: 'include' }); if (res.ok) targetOrder = await res.json(); } catch { /* silent */ }
                      }
                      if (targetOrder) {
                        setCurrentBoard(targetOrder.board);
                        if (n.type === 'comment' || n.type === 'mention') setTimeout(() => setCommentsOrder(targetOrder), 300);
                      }
                    }}
                    data-testid={`notification-${n.notification_id}`}>
                    <div className="flex items-center gap-2">
                      {n.type === 'mention' && <AtSign className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                      {n.type === 'move' && <ArrowRightLeft className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />}
                      <div className="text-foreground flex-1">{n.message}</div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{new Date(n.created_at).toLocaleString()}</div>
                  </div>
                )) : <div className="p-4 text-center text-muted-foreground text-sm">Sin notificaciones</div>}
              </div>,
              document.body
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-1 justify-center max-w-xs md:max-w-md mx-2 md:mx-4">
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter') { const results = await handleGlobalSearch(searchQuery, setCurrentBoard); if (results) setSearchResults(results); } }} placeholder={t('search_placeholder')} className={`w-full rounded px-2 md:px-3 py-1.5 text-sm ${isDark ? 'bg-secondary border border-border text-foreground' : 'bg-white border border-gray-300 text-gray-900'}`} data-testid="global-search-input" />
          <button onClick={async () => { const results = await handleGlobalSearch(searchQuery, setCurrentBoard); if (results) setSearchResults(results); }} className={`p-1.5 rounded flex-shrink-0 ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} data-testid="global-search-btn"><Search className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0 overflow-x-auto max-w-[40vw] md:max-w-none scrollbar-hide">
          <button onClick={toggleTheme} className={`p-1.5 rounded flex-shrink-0 ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title={isDark ? t('light_mode') : t('dark_mode')} data-testid="theme-toggle-btn">{isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}</button>
          <button onClick={toggleLang} className={`p-1.5 rounded flex items-center gap-0.5 text-[10px] font-bold flex-shrink-0 ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} data-testid="lang-toggle-btn"><Languages className="w-3.5 h-3.5" />{lang === 'es' ? 'EN' : 'ES'}</button>
          <button onClick={() => setShowAutomations(true)} className={`p-1.5 rounded flex-shrink-0 hidden md:flex ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title={t('automations')} data-testid="automations-btn"><Zap className="w-3.5 h-3.5" /></button>
          <button onClick={() => { setShowTrash(true); fetchTrashOrders(); }} className={`p-1.5 rounded flex-shrink-0 ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title={t('trash')} data-testid="trash-btn"><Trash2 className="w-3.5 h-3.5 text-destructive" /></button>
          <button onClick={() => { setShowAnalytics(true); fetchAllOrders(); }} className={`p-1.5 rounded flex-shrink-0 hidden md:flex ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title={t('analytics')} data-testid="analytics-btn"><BarChart3 className="w-3.5 h-3.5" /></button>
          {isAdmin && (<>
            <div className="w-px h-5 bg-border mx-0.5 hidden md:block"></div>
            <button onClick={handleQuickUndo} className={`p-1.5 rounded flex-shrink-0 hidden md:flex ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title={t('undo_last')} data-testid="quick-undo-btn"><Undo2 className="w-3.5 h-3.5" /></button>
            <button onClick={() => setShowInvite(true)} className={`p-1.5 rounded flex-shrink-0 hidden md:flex ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title={t('invite_users')} data-testid="invite-users-btn"><UserPlus className="w-3.5 h-3.5" /></button>
            <button onClick={() => setShowActivityLog(true)} className={`p-1.5 rounded flex-shrink-0 hidden md:flex ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title={t('activity_log')} data-testid="activity-log-btn"><History className="w-3.5 h-3.5" /></button>
            <button onClick={() => setShowOptionsManager(true)} className={`p-1.5 rounded flex-shrink-0 ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title={t('manage_options')} data-testid="manage-options-btn"><Settings className="w-3.5 h-3.5" /></button>
            <button onClick={() => setShowOperators(true)} className={`p-1.5 rounded flex-shrink-0 hidden lg:flex ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title="Gestionar Operadores" data-testid="manage-operators-btn"><Users className="w-3.5 h-3.5" /></button>
            <button onClick={() => setShowFormFields(true)} className={`p-1.5 rounded flex-shrink-0 hidden lg:flex ${isDark ? 'bg-secondary border border-border hover:bg-secondary/80' : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'}`} title="Campos del Formulario" data-testid="manage-form-fields-btn"><ClipboardList className="w-3.5 h-3.5" /></button>
          </>)}
        </div>
        <div className="w-px h-5 bg-border mx-0.5 flex-shrink-0"></div>
        <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
          {user?.picture && <img src={user.picture} alt="" className="w-6 h-6 md:w-7 md:h-7 rounded-full" />}
          <div className="flex-col leading-tight hidden sm:flex"><span className={`text-xs font-medium ${isDark ? 'text-foreground' : 'text-gray-900'}`}>{user?.name}</span>{isAdmin && <span className="text-[10px] text-primary font-bold">Admin</span>}</div>
          <button onClick={logout} className="p-1.5 text-muted-foreground hover:text-foreground flex-shrink-0" title={t('logout')}><LogOut className="w-3.5 h-3.5" /></button>
        </div>
      </header>

      {/* Board Indicator + Actions */}
      <div className="px-2 md:px-4 py-2 md:py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2 shadow-lg" style={{ ...getBoardStyle(currentBoard), color: '#FFFFFF' }}>
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <Select value={currentBoard} onValueChange={setCurrentBoard}>
            <SelectTrigger className="w-36 md:w-52 bg-white/15 border-white/25 text-white font-barlow font-bold text-xs md:text-sm backdrop-blur-sm flex-shrink-0" data-testid="board-selector"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-popover border-border z-[100]">{visibleBoards.map(board => <SelectItem key={board} value={board}>{board}</SelectItem>)}</SelectContent>
          </Select>
          <div className="flex flex-col min-w-0 hidden md:flex"><span className="font-barlow font-black text-base md:text-2xl uppercase tracking-wider drop-shadow-lg truncate" data-testid="board-name-display">{currentBoard}</span><span className="text-[9px] md:text-[10px] uppercase tracking-widest opacity-70 font-medium">{currentBoard === 'MASTER' ? 'Vista consolidada' : 'Tablero Activo'}</span></div>
          <span className="text-xs md:text-sm font-barlow font-bold bg-white/15 backdrop-blur-sm px-2 md:px-3 py-1 rounded-lg flex-shrink-0 whitespace-nowrap" data-testid="order-count">{orders.length} <span className="text-[10px] font-normal opacity-80">ord</span></span>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2 overflow-visible flex-wrap">
          {currentBoard === 'SCHEDULING' && <button onClick={() => setShowNewOrder(true)} className="flex items-center gap-1 px-2 md:px-3 py-1.5 bg-white/20 hover:bg-white/30 text-white rounded text-xs font-bold backdrop-blur-sm transition-all flex-shrink-0 whitespace-nowrap" data-testid="new-order-btn"><Plus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t('new_order')}</span><span className="sm:hidden">+</span></button>}
          <button onClick={() => { setShowProduction(true); fetchAllOrders(); }} className="flex items-center gap-1 px-2 md:px-3 py-1.5 bg-green-500/80 hover:bg-green-500 text-white rounded text-xs font-bold transition-all flex-shrink-0 whitespace-nowrap" data-testid="production-btn"><Factory className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t('production')}</span></button>
          <button onClick={() => setShowGantt(true)} className="flex items-center gap-1 px-2 md:px-3 py-1.5 bg-white/15 hover:bg-white/25 text-white rounded text-xs font-bold backdrop-blur-sm transition-all flex-shrink-0 whitespace-nowrap" data-testid="gantt-btn"><GanttChart className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t('gantt')}</span></button>
          <button onClick={() => setShowCapacityPlan(true)} className="flex items-center gap-1 px-2 md:px-3 py-1.5 bg-orange-500/80 hover:bg-orange-500 text-white rounded text-xs font-bold transition-all flex-shrink-0 whitespace-nowrap" data-testid="capacity-plan-btn"><TrendingUp className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t('plan')}</span></button>
          <button onClick={() => setShowProductionScreen(true)} className="flex items-center gap-1 px-2 md:px-3 py-1.5 bg-white/15 hover:bg-white/25 text-white rounded text-xs font-bold backdrop-blur-sm transition-all flex-shrink-0 whitespace-nowrap" data-testid="production-screen-btn"><Monitor className="w-3.5 h-3.5" /> <span className="hidden md:inline">{t('prod_screen_title')}</span></button>
          <button onClick={() => window.location.href = '/wms'} className="flex items-center gap-1 px-2 md:px-3 py-1.5 bg-white/15 hover:bg-white/25 text-white rounded text-xs font-bold backdrop-blur-sm transition-all flex-shrink-0 whitespace-nowrap" data-testid="wms-btn"><Warehouse className="w-3.5 h-3.5" /> WMS</button>
          {isAdmin && (
            <div className="flex items-center gap-1 ml-1 pl-2 border-l border-white/20">
              {!showNewBoard ? (
                <button onClick={() => setShowNewBoard(true)} className="p-2 bg-white/15 rounded-lg hover:bg-white/25 backdrop-blur-sm transition-all" title="Crear tablero" data-testid="create-board-btn"><Plus className="w-4 h-4" /></button>
              ) : (
                <div className="flex items-center gap-1 bg-white/15 backdrop-blur-sm rounded-lg px-2 py-1">
                  <input type="text" value={newBoardName} onChange={e => setNewBoardName(e.target.value)} onKeyDown={async e => { if (e.key === 'Enter' && newBoardName.trim()) { const ok = await createBoard(newBoardName.trim()); if (ok) { setNewBoardName(''); setShowNewBoard(false); } } if (e.key === 'Escape') setShowNewBoard(false); }} placeholder="Nombre..." className="w-28 h-6 px-2 text-xs bg-white/20 border border-white/30 rounded text-white placeholder-white/50" autoFocus data-testid="new-board-input" />
                  <button onClick={async () => { if (newBoardName.trim()) { const ok = await createBoard(newBoardName.trim()); if (ok) { setNewBoardName(''); setShowNewBoard(false); } } }} className="p-0.5 hover:bg-white/20 rounded"><Plus className="w-3.5 h-3.5" /></button>
                  <button onClick={() => { setShowNewBoard(false); setNewBoardName(''); }} className="p-0.5 hover:bg-white/20 rounded"><X className="w-3.5 h-3.5" /></button>
                </div>
              )}
              {currentBoard !== 'MASTER' && currentBoard !== 'COMPLETOS' && currentBoard !== 'PAPELERA DE RECICLAJE' && (
                <button onClick={() => setDeleteBoardConfirm({ step: 1, name: currentBoard })} className="p-2 bg-white/15 rounded-lg hover:bg-red-500/50 backdrop-blur-sm transition-all" title={`Eliminar ${currentBoard}`} data-testid="delete-board-btn"><Trash2 className="w-4 h-4" /></button>
              )}
              {isAdmin && <button onClick={() => setShowAddColumn(true)} className="p-2 bg-white/15 rounded-lg hover:bg-white/25 backdrop-blur-sm transition-all" title={t('add_column')} data-testid="add-column-btn"><PlusCircle className="w-4 h-4" /></button>}
              {isAdmin && (
                <div className="relative">
                  <button onClick={() => setShowBoardVisibility(!showBoardVisibility)} className="p-2 bg-white/15 rounded-lg hover:bg-white/25 backdrop-blur-sm transition-all" title="Ocultar/Mostrar Tableros" data-testid="board-visibility-btn"><Eye className="w-4 h-4" /></button>
                  {showBoardVisibility && (
                    <div className="absolute right-0 top-11 w-64 max-h-80 overflow-y-auto rounded-lg shadow-xl border z-[300] bg-card border-border" data-testid="board-visibility-panel">
                      <div className="p-3 border-b border-border font-barlow font-bold text-xs uppercase tracking-wide text-foreground">Visibilidad de Tableros</div>
                      {allBoardsIncludingHidden.filter(b => b !== 'MASTER').map(b => {
                        const isHidden = hiddenBoards.includes(b);
                        return (
                          <button key={b} onClick={() => toggleBoardVisibility(b)} className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-all ${isHidden ? 'opacity-50' : ''}`} data-testid={`board-vis-${b}`}>
                            {isHidden ? <EyeOff className="w-3.5 h-3.5 text-muted-foreground" /> : <Eye className="w-3.5 h-3.5 text-green-500" />}
                            <span className={`flex-1 ${isHidden ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{b}</span>
                          </button>
                        );
                      })}
                      <div className="p-2 border-t border-border">
                        <p className="text-[10px] text-muted-foreground">Los tableros ocultos no aparecen en el selector.</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <button onClick={() => setShowColumnManager(!showColumnManager)} className="p-2 bg-white/15 rounded-lg hover:bg-white/25 backdrop-blur-sm transition-all ml-1" title={t('show_columns')} data-testid="column-manager-btn"><Settings className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Column Manager Panel */}
      {showColumnManager && (
        <div className={`border-b px-4 py-3 ${isDark ? 'border-border bg-zinc-900/80' : 'border-gray-200 bg-gray-50'}`} data-testid="column-manager-panel">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Columnas del tablero: {currentBoard}</span>
            <button onClick={() => setShowColumnManager(false)} className="p-1 hover:bg-secondary rounded"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex flex-wrap gap-2">
            {columns.map(col => {
              const isHidden = (hiddenColumns[currentBoard] || []).includes(col.key);
              return (
                <div key={col.key} className={`flex items-center gap-1 px-2 py-1 rounded text-xs border transition-all ${isHidden ? 'opacity-40 border-dashed border-border' : isDark ? 'bg-secondary border-border' : 'bg-white border-gray-300'}`} data-testid={`col-mgr-${col.key}`}>
                  <button onClick={() => handleToggleColumnVisibility(col.key)} className="hover:text-primary" title={isHidden ? 'Mostrar' : 'Ocultar'}>{isHidden ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}</button>
                  <span className={isHidden ? 'line-through' : ''}>{col.label}</span>
                  {isAdmin && <button onClick={() => handleDeleteColumn(col.key)} className="hover:text-destructive ml-1" title={t('delete')} data-testid={`delete-col-${col.key}`}><X className="w-3 h-3" /></button>}
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">{lang === 'en' ? 'Drag columns in the table to reorder. Changes saved per user.' : 'Arrastra las columnas en la tabla para reordenar. Cambios guardados por usuario.'}</p>
        </div>
      )}

      {/* Saved Views + Filters */}
      <div className={`border-b px-2 md:px-4 py-2 relative z-50 ${isDark ? 'border-border bg-secondary/30' : 'border-gray-200 bg-gray-50'}`}>
        <div className="flex items-center gap-2 mb-2 overflow-x-auto pb-3 pt-1 scrollbar-hide">
          <button onClick={() => handleApplyView(null)} className={`px-3 py-1 text-xs rounded-full whitespace-nowrap transition-colors ${activeViewName === null ? 'bg-primary text-primary-foreground' : isDark ? 'bg-secondary border border-border hover:bg-secondary/80 text-muted-foreground' : 'bg-white border border-gray-300 hover:bg-gray-100 text-gray-600'}`} data-testid="view-general">{t('general')}</button>
          {pinnedViews.map(v => (
            <div key={v.view_id} className="relative group flex-shrink-0">
              <button onClick={() => handleApplyView(v)} className={`px-3 py-1 text-xs rounded-full whitespace-nowrap flex items-center gap-1 transition-colors ${activeViewName === v.name ? 'bg-primary text-primary-foreground' : isDark ? 'bg-secondary border border-border hover:bg-secondary/80 text-muted-foreground' : 'bg-white border border-gray-300 hover:bg-gray-100 text-gray-600'}`} data-testid={`view-pinned-${v.name}`}><Pin className="w-3 h-3" /> {v.name}</button>
              <div className="absolute -top-1.5 -right-1.5 hidden group-hover:flex gap-0.5 z-10">
                <button onClick={(e) => { e.stopPropagation(); handleTogglePinView(v.view_id, v.pinned); }} className="w-5 h-5 bg-yellow-500 rounded-full flex items-center justify-center shadow-sm" title={t('unpin')}><Pin className="w-3 h-3 text-white" /></button>
                <button onClick={(e) => { e.stopPropagation(); handleDeleteView(v.view_id); }} className="w-5 h-5 bg-destructive rounded-full flex items-center justify-center shadow-sm" title={t('delete')}><X className="w-3 h-3 text-white" /></button>
              </div>
            </div>
          ))}
          {unpinnedViews.map(v => (
            <div key={v.view_id} className="relative group flex-shrink-0">
              <button onClick={() => handleApplyView(v)} className={`px-3 py-1 text-xs rounded-full whitespace-nowrap transition-colors ${activeViewName === v.name ? 'bg-primary text-primary-foreground' : isDark ? 'bg-secondary/50 border border-border/50 hover:bg-secondary/80 text-muted-foreground' : 'bg-gray-50 border border-gray-200 hover:bg-gray-100 text-gray-500'}`}>{v.name}</button>
              <div className="absolute -top-1.5 -right-1.5 hidden group-hover:flex gap-0.5 z-10">
                <button onClick={(e) => { e.stopPropagation(); handleTogglePinView(v.view_id, v.pinned); }} className="w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow-sm"><Pin className="w-3 h-3 text-white" /></button>
                <button onClick={(e) => { e.stopPropagation(); handleDeleteView(v.view_id); }} className="w-5 h-5 bg-destructive rounded-full flex items-center justify-center shadow-sm"><X className="w-3 h-3 text-white" /></button>
              </div>
            </div>
          ))}
          {Object.keys(filters).some(k => filters[k]) && (
            showSaveView ? (
              <div className="flex items-center gap-1">
                <input type="text" value={newViewName} onChange={(e) => setNewViewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSaveView()} placeholder={t('view_name')} className="bg-secondary border border-border rounded px-2 py-1 text-xs w-32 text-foreground" autoFocus data-testid="save-view-input" />
                <button onClick={handleSaveView} className="px-2 py-1 bg-primary text-primary-foreground rounded text-xs" data-testid="save-view-confirm"><Save className="w-3 h-3" /></button>
                <button onClick={() => setShowSaveView(false)} className="px-1 py-1 text-muted-foreground"><X className="w-3 h-3" /></button>
              </div>
            ) : <button onClick={() => setShowSaveView(true)} className="px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded-full flex items-center gap-1" data-testid="save-view-btn"><Save className="w-3 h-3" /> {t('save_view')}</button>
          )}
          {currentBoard === 'SCHEDULING' && (
            <div className="ml-auto flex items-center gap-1 border-l border-border pl-3">
              <button onClick={() => { setCalendarMode(false); setBlanksTrackingMode(false); setReadyCalendarMode(false); }} className={`p-1.5 rounded ${!calendarMode && !blanksTrackingMode && !readyCalendarMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`} title={t('table_view')} data-testid="toggle-table-view"><Table2 className="w-4 h-4" /></button>
              <button onClick={() => { setCalendarMode(true); setBlanksTrackingMode(false); setReadyCalendarMode(false); }} className={`p-1.5 rounded ${calendarMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`} title={t('calendar_view')} data-testid="toggle-calendar-view"><CalendarDays className="w-4 h-4" /></button>
              <button onClick={() => { setReadyCalendarMode(true); setCalendarMode(false); setBlanksTrackingMode(false); }} className={`p-1.5 rounded ${readyCalendarMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`} title="Ready To Schedule" data-testid="toggle-ready-calendar"><CalendarCheck className="w-4 h-4" /></button>
              <button onClick={() => { setBlanksTrackingMode(true); setCalendarMode(false); setReadyCalendarMode(false); }} className={`p-1.5 rounded ${blanksTrackingMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`} title="Seguimiento de Blanks" data-testid="toggle-blanks-tracking"><ClipboardList className="w-4 h-4" /></button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 md:gap-3 flex-wrap overflow-visible">
          {/* Board filter for MASTER view - FIRST position with distinctive color */}
          {currentBoard === 'MASTER' && (() => {
            const boardFilter = filters['_board'] || [];
            const allBoards = [...new Set(unfilteredOrders.map(o => o.board).filter(Boolean))].sort();
            const isOpen = openFilterKey === '_board';
            return (
              <div className="flex flex-col gap-0.5 relative" data-testid="filter-board">
                <label className="text-[9px] uppercase tracking-wider font-bold text-orange-500 dark:text-orange-400">Tablero</label>
                <button onClick={() => setOpenFilterKey(isOpen ? null : '_board')}
                  className={`w-44 text-xs h-7 px-2 flex items-center justify-between rounded-md border-2 font-semibold ${boardFilter.length ? 'border-orange-400 bg-orange-100 text-orange-700 dark:border-orange-500 dark:bg-orange-900/40 dark:text-orange-300' : 'border-orange-300 bg-orange-50 text-orange-600 dark:border-orange-700 dark:bg-orange-950/30 dark:text-orange-400'}`}
                  data-testid="filter-btn-board">
                  <span className="truncate">{boardFilter.length ? `${boardFilter.length} tablero${boardFilter.length > 1 ? 's' : ''}` : 'Todos'}</span>
                  {boardFilter.length > 0 && <X className="w-3 h-3 flex-shrink-0" onClick={(e) => { e.stopPropagation(); setFilters(prev => { const n = { ...prev }; delete n['_board']; return n; }); }} />}
                </button>
                {isOpen && (
                  <div className={`absolute top-full left-0 mt-1 z-[200] w-52 rounded-lg border shadow-xl max-h-64 overflow-y-auto ${isDark ? 'bg-popover border-border' : 'bg-white border-gray-300'}`} data-testid="filter-board-dropdown">
                    {allBoards.map(b => {
                      const checked = boardFilter.includes(b);
                      return (
                        <label key={b} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-orange-50 dark:hover:bg-orange-900/20 cursor-pointer">
                          <input type="checkbox" checked={checked} onChange={() => {
                            setFilters(prev => {
                              const cur = prev['_board'] || [];
                              const next = checked ? cur.filter(x => x !== b) : [...cur, b];
                              if (!next.length) { const n = { ...prev }; delete n['_board']; return n; }
                              return { ...prev, '_board': next };
                            });
                          }} className="w-3 h-3 rounded accent-orange-500" />
                          <span className={`font-medium ${checked ? 'text-orange-600 dark:text-orange-400' : 'text-muted-foreground'}`}>{b}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
          {(() => {
            const dateColsFromColumns = columns.filter(c => c.type === 'date').map(c => ({ key: c.key, label: c.label, isDate: true }));
            const builtInDateKeys = new Set(dateColsFromColumns.map(c => c.key));
            if (!builtInDateKeys.has('created_at')) dateColsFromColumns.push({ key: 'created_at', label: lang === 'es' ? 'Creacion' : 'Created', isDate: true });
            // Status/select filters only (non-date)
            return FILTER_COLUMNS.map(col => {
              const filterVals = Array.isArray(filters[col.key]) ? filters[col.key] : (filters[col.key] ? [filters[col.key]] : []);
              const isOpen = openFilterKey === col.key;
              return (
                <div key={col.key} className="flex flex-col gap-0.5 relative" data-testid={`filter-${col.key}`}>
                  <label className={`text-[9px] uppercase tracking-wider font-bold ${isDark ? 'text-muted-foreground' : 'text-gray-500'}`}>{col.label}</label>
                  <button onClick={() => setOpenFilterKey(isOpen ? null : col.key)} className={`w-36 text-xs h-7 px-2 flex items-center justify-between rounded border ${filterVals.length > 0 ? 'border-primary bg-primary/10 text-primary' : (isDark ? 'bg-secondary border-border text-muted-foreground' : 'bg-white border-gray-300 text-gray-600')}`} data-testid={`filter-btn-${col.key}`}>
                    <span className="truncate">{filterVals.length === 0 ? t('all') : filterVals.length === 1 ? filterVals[0] : `${filterVals.length} sel.`}</span>
                    <X className={`w-3 h-3 flex-shrink-0 ${filterVals.length > 0 ? '' : 'opacity-0'}`} onClick={(e) => { e.stopPropagation(); setFilters(prev => { const n = { ...prev }; delete n[col.key]; return n; }); }} />
                  </button>
                  {isOpen && (
                    <div className={`absolute top-full left-0 mt-1 z-[200] w-48 max-h-56 overflow-y-auto rounded-lg border shadow-xl ${isDark ? 'bg-popover border-border' : 'bg-white border-gray-300'}`} data-testid={`filter-dropdown-${col.key}`}>
                      {getFilterOptions(col).map(opt => {
                        const checked = filterVals.includes(opt);
                        return (
                          <label key={opt} className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-secondary/50 ${checked ? 'font-semibold text-primary' : ''}`}>
                            <input type="checkbox" checked={checked} onChange={() => {
                              setFilters(prev => {
                                const cur = Array.isArray(prev[col.key]) ? [...prev[col.key]] : (prev[col.key] ? [prev[col.key]] : []);
                                const next = checked ? cur.filter(v => v !== opt) : [...cur, opt];
                                return { ...prev, [col.key]: next.length > 0 ? next : undefined };
                              });
                            }} className="w-3.5 h-3.5 rounded" />
                            <span className="truncate">{opt}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            });
          })()}
          {/* Date range filters */}
          {(() => {
            const checkboxDateKeys = new Set(FILTER_COLUMNS.map(c => c.key));
            const excludeDateKeys = new Set([...checkboxDateKeys]);
            const dateColsForFilter = columns.filter(c => c.type === 'date' && !excludeDateKeys.has(c.key)).map(c => ({ key: c.key, label: c.label }));
            const dateKeys = new Set(dateColsForFilter.map(c => c.key));
            if (!dateKeys.has('created_at')) dateColsForFilter.push({ key: 'created_at', label: lang === 'es' ? 'Creacion' : 'Created' });
            return dateColsForFilter.map(dc => {
              const dateRange = filters[dc.key];
              const hasRange = dateRange && typeof dateRange === 'object' && !Array.isArray(dateRange) && (dateRange.from || dateRange.to);
              const isOpen = openFilterKey === dc.key;
              const fromVal = hasRange ? dateRange.from || '' : '';
              const toVal = hasRange ? dateRange.to || '' : '';
              const displayText = hasRange ? `${fromVal || '...'} - ${toVal || '...'}` : (lang === 'es' ? 'Fecha especifica' : 'Specific date');
              return (
                <div key={dc.key} className="flex flex-col gap-0.5 relative" data-testid={`filter-date-${dc.key}`}>
                  <label className={`text-[9px] uppercase tracking-wider font-bold ${isDark ? 'text-muted-foreground' : 'text-gray-500'}`}>{dc.label}</label>
                  <button onClick={() => setOpenFilterKey(isOpen ? null : dc.key)} className={`w-44 text-xs h-7 px-2 flex items-center justify-between rounded border ${hasRange ? 'border-primary bg-primary/10 text-primary' : (isDark ? 'bg-secondary border-border text-muted-foreground' : 'bg-white border-gray-300 text-gray-600')}`} data-testid={`filter-btn-date-${dc.key}`}>
                    <span className="truncate">{displayText}</span>
                    <X className={`w-3 h-3 flex-shrink-0 ${hasRange ? '' : 'opacity-0'}`} onClick={(e) => { e.stopPropagation(); setFilters(prev => { const n = { ...prev }; delete n[dc.key]; return n; }); }} />
                  </button>
                  {isOpen && (
                    <div className={`absolute top-full left-0 mt-1 z-[200] w-56 rounded-lg border shadow-xl p-3 space-y-2 ${isDark ? 'bg-popover border-border' : 'bg-white border-gray-300'}`} data-testid={`filter-date-dropdown-${dc.key}`}>
                      <div>
                        <label className="text-[10px] text-muted-foreground uppercase font-medium">{lang === 'es' ? 'Desde' : 'From'}</label>
                        <input type="date" value={fromVal} onChange={(e) => {
                          setFilters(prev => ({ ...prev, [dc.key]: { from: e.target.value, to: (prev[dc.key] && typeof prev[dc.key] === 'object' && !Array.isArray(prev[dc.key])) ? prev[dc.key].to || '' : '' } }));
                        }} className={`w-full px-2 py-1.5 rounded border text-xs ${isDark ? 'bg-secondary border-border text-foreground' : 'bg-white border-gray-300 text-gray-800'}`} data-testid={`date-from-${dc.key}`} />
                      </div>
                      <div>
                        <label className="text-[10px] text-muted-foreground uppercase font-medium">{lang === 'es' ? 'Hasta' : 'To'}</label>
                        <input type="date" value={toVal} onChange={(e) => {
                          setFilters(prev => ({ ...prev, [dc.key]: { from: (prev[dc.key] && typeof prev[dc.key] === 'object' && !Array.isArray(prev[dc.key])) ? prev[dc.key].from || '' : '', to: e.target.value } }));
                        }} className={`w-full px-2 py-1.5 rounded border text-xs ${isDark ? 'bg-secondary border-border text-foreground' : 'bg-white border-gray-300 text-gray-800'}`} data-testid={`date-to-${dc.key}`} />
                      </div>
                      <button onClick={() => { setFilters(prev => { const n = { ...prev }; delete n[dc.key]; return n; }); setOpenFilterKey(null); }}
                        className="text-xs text-destructive hover:underline">{lang === 'es' ? 'Limpiar' : 'Clear'}</button>
                    </div>
                  )}
                </div>
              );
            });
          })()}
          {/* Group by date - dynamic */}
          {(() => {
            const dateCols = columns.filter(c => c.type === 'date');
            const dateKeys = new Set(dateCols.map(c => c.key));
            if (!dateKeys.has('created_at')) dateCols.push({ key: 'created_at', label: lang === 'es' ? 'Creacion' : 'Created' });
            return (
              <div className="flex flex-col gap-0.5">
                <label className={`text-[9px] uppercase tracking-wider font-bold ${isDark ? 'text-muted-foreground' : 'text-gray-500'}`}>{lang === 'es' ? 'Agrupar' : 'Group'}</label>
                <Select value={groupByDate || 'none'} onValueChange={(v) => setGroupByDate(v === 'none' ? null : v)}>
                  <SelectTrigger className={`w-36 text-xs h-7 ${isDark ? 'bg-secondary border-border' : 'bg-white border-gray-300'}`} data-testid="group-by-select"><SelectValue placeholder={t('all')} /></SelectTrigger>
                  <SelectContent className={`z-[100] ${isDark ? 'bg-popover border-border' : 'bg-white border-gray-300'}`}>
                    <SelectItem value="none">{lang === 'es' ? 'Sin agrupar' : 'No grouping'}</SelectItem>
                    {dateCols.map(dc => (
                      <SelectItem key={dc.key} value={dc.key}>{dc.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })()}
          {(Object.keys(filters).some(k => {
            const v = filters[k];
            if (!v) return false;
            if (Array.isArray(v)) return v.length > 0;
            if (typeof v === 'object' && (v.from || v.to)) return true;
            return true;
          }) || groupByDate) && <button onClick={() => { setFilters({}); setActiveViewName(null); setGroupByDate(null); }} className="text-xs text-primary hover:underline flex items-center gap-1 ml-2"><X className="w-3 h-3" /> {t('clear')}</button>}
        </div>
      </div>

      {/* Bulk Actions Modal */}
      {selectedOrders.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={(e) => { if (e.target === e.currentTarget) { setSelectedOrders([]); } }} data-testid="bulk-actions-overlay">
          <div className={`rounded-xl shadow-2xl border p-4 md:p-5 w-[90vw] max-w-md ${isDark ? 'bg-card border-border' : 'bg-white border-gray-200'}`} data-testid="bulk-actions-modal">
            <div className="flex items-center justify-between mb-4">
              <span className="text-base font-semibold">{selectedOrders.length} {t('selected')}</span>
              <button onClick={() => setSelectedOrders([])} className="p-1 rounded hover:bg-secondary transition-colors" data-testid="close-bulk-modal"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-1.5 block">{t('move_to')}</label>
                <Select onValueChange={(board) => { handleBulkMove(selectedOrders, board); setSelectedOrders([]); }}>
                  <SelectTrigger className={`w-full h-9 text-sm ${isDark ? 'bg-secondary border-border' : 'bg-gray-50 border-gray-300'}`} data-testid="bulk-move-select"><SelectValue placeholder={`${t('move_to')}...`} /></SelectTrigger>
                  <SelectContent className={`z-[200] ${isDark ? 'bg-popover border-border' : 'bg-white border-gray-300'}`}>{allBoardsIncludingHidden.filter(b => b !== currentBoard && b !== 'PAPELERA DE RECICLAJE').map(board => <SelectItem key={board} value={board}>{board}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={handleExportExcel} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-green-500/15 text-green-600 rounded-lg text-sm font-medium hover:bg-green-500/25 transition-colors" data-testid="export-excel-btn"><Download className="w-4 h-4" /> Excel</button>
                <button onClick={() => handleExportComplete(true)} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-500/15 text-blue-500 rounded-lg text-sm font-medium hover:bg-blue-500/25 transition-colors" data-testid="export-complete-btn"><FileJson className="w-4 h-4" /> Completo</button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { if (selectedOrders.length === 0) return; if (!window.confirm(`${t('delete')} ${selectedOrders.length} ${t('orders')}?`)) return; handleBulkMove(selectedOrders, "PAPELERA DE RECICLAJE"); setSelectedOrders([]); }} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-destructive/15 text-destructive rounded-lg text-sm font-medium hover:bg-destructive/25 transition-colors" data-testid="bulk-delete-btn"><Trash2 className="w-4 h-4" /> {t('trash')}</button>
                <button onClick={handleImportComplete} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-500/15 text-purple-500 rounded-lg text-sm font-medium hover:bg-purple-500/25 transition-colors" data-testid="import-complete-btn"><ImageUp className="w-4 h-4" /> Importar</button>
              </div>
              <div className="flex items-center justify-center gap-3 pt-1 border-t border-border">
                <button onClick={handleSelectAll} className="text-xs text-primary hover:underline pt-2">{t('all')}</button>
                <span className="text-muted-foreground pt-2">|</span>
                <button onClick={handleDeselectAll} className="text-xs text-primary hover:underline pt-2">{t('none')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-auto relative">
        {loading ? <div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div> :
          calendarMode && currentBoard === 'SCHEDULING' ? <CalendarView orders={orders} isDark={isDark} fetchOrders={fetchOrders} /> :
            readyCalendarMode && currentBoard === 'SCHEDULING' ? <CalendarView orders={readyOrders} isDark={isDark} fetchOrders={fetchOrders} label="Ready To Scheduled" /> :
              blanksTrackingMode && currentBoard === 'SCHEDULING' ? <BlanksTrackingView orders={blanksOrders} isDark={isDark} options={options} readOnly /> : (
                <>
                  <table className="text-sm border-collapse" style={{ minWidth: '100%' }}>
                    <thead className="sticky top-0 z-30">
                      <tr className={isDark ? 'bg-zinc-900 border-b-2 border-border' : 'bg-gray-200 border-b-2 border-gray-300'}>
                        <th className={`w-11 py-3.5 px-2 sticky left-0 z-30 ${isDark ? 'bg-zinc-900 border-b-2 border-border' : 'bg-gray-200 border-b-2 border-gray-300'}`}><input type="checkbox" checked={selectedOrders.length === orders.length && orders.length > 0} onChange={(e) => e.target.checked ? handleSelectAll() : handleDeselectAll()} className="w-4 h-4 rounded" data-testid="select-all-checkbox" /></th>
                        <th className={`w-10 py-3.5 px-1 sticky left-[44px] z-30 ${isDark ? 'bg-zinc-900 border-b-2 border-border' : 'bg-gray-200 border-b-2 border-gray-300'}`}></th>
                        {currentBoard === 'MASTER' && <th className={`py-3.5 px-3 text-left font-barlow uppercase text-base font-extrabold tracking-wider ${isDark ? 'text-zinc-200' : 'text-gray-800'}`} style={{ minWidth: 160 }}>Board</th>}
                        {visibleColumns.map(col => {
                          const isOrderNum = col.key === 'order_number';
                          const width = isOrderNum ? 120 : (columnWidths[col.key] || col.width);
                          return (
                            <th key={col.key} className={`py-3.5 px-3 text-left font-barlow uppercase text-base font-extrabold tracking-wider ${isDark ? 'text-zinc-200' : 'text-gray-800'} ${draggedCol === col.key ? 'opacity-50' : ''} ${isOrderNum ? `sticky left-[88px] z-30 ${isDark ? 'bg-zinc-900 border-b-2 border-border' : 'bg-gray-200 border-b-2 border-gray-300'}` : ''}`} style={{ width: width, minWidth: width, maxWidth: isOrderNum ? 120 : 'none' }} data-testid={`column-header-${col.key}`} draggable onDragStart={() => handleColumnDragStart(col.key)} onDragOver={(e) => handleColumnDragOver(e, col.key)} onDragEnd={handleColumnDragEnd}>
                              <div className="flex items-center justify-between gap-1">
                                <span className="cursor-grab active:cursor-grabbing select-none">{currentBoard === 'MASTER' && <svg className="w-3.5 h-3.5 inline-block mr-1 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0-6v6m18-6v6" /></svg>}{col.label}</span>
                                <div className="cursor-col-resize px-1 opacity-40 hover:opacity-100" onMouseDown={(e) => { e.stopPropagation(); const startX = e.clientX; const startWidth = columnWidths[col.key] || col.width; const onMouseMove = (ev) => { setColumnWidths(prev => ({ ...prev, [col.key]: Math.max(80, startWidth + (ev.clientX - startX)) })); }; const onMouseUp = () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp); }}><GripVertical className="w-4 h-4" /></div>
                              </div>
                            </th>
                          );
                        })}
                        <th className={`py-3.5 px-3 text-left font-barlow uppercase text-base font-extrabold tracking-wider ${isDark ? 'text-zinc-200' : 'text-gray-800'}`} style={{ minWidth: 180 }} data-testid="column-header-restante">{t('restante')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const renderOrderRow = (order) => {
                          const isSearchMatch = searchQuery && order.order_number && order.order_number.toLowerCase().includes(searchQuery.toLowerCase());
                          return (
                            <tr key={order.order_id} className={`border-b transition-colors ${isDark ? 'border-border/50 hover:bg-zinc-800/50' : 'border-gray-200 hover:bg-gray-100'} ${selectedOrders.includes(order.order_id) ? (isDark ? 'bg-primary/10' : 'bg-blue-50') : ''} ${isSearchMatch ? 'ring-2 ring-primary ring-inset bg-primary/10' : ''}`} data-testid={`order-row-${order.order_id}`}>
                              <td className={`py-2 px-2 sticky left-0 z-10 ${isSearchMatch ? 'bg-primary/10' : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-primary/10' : 'bg-blue-50') : (isDark ? 'bg-background' : 'bg-white')}`}><input type="checkbox" checked={selectedOrders.includes(order.order_id)} onChange={() => toggleOrderSelection(order.order_id)} className="w-4 h-4 rounded" /></td>
                              <td className={`py-2 px-1 sticky left-[44px] z-10 ${isSearchMatch ? 'bg-primary/10' : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-primary/10' : 'bg-blue-50') : (isDark ? 'bg-background' : 'bg-white')}`}><button onClick={() => setCommentsOrder(order)} className="p-1 rounded transition-colors hover:bg-secondary" title={t('comments')}><MessageSquare className="w-3.5 h-3.5 text-muted-foreground hover:text-primary" /></button></td>
                              {currentBoard === 'MASTER' && <td className="py-2 px-3"><span className="px-2.5 py-1 rounded text-xs font-bold" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666', color: '#fff' }}>{order.board}</span></td>}
                              {visibleColumns.map(col => {
                                const isOrderNum = col.key === 'order_number';
                                const width = isOrderNum ? 120 : (columnWidths[col.key] || col.width);
                                return (
                                  <td key={col.key} className={`py-2 px-3 ${isOrderNum ? `sticky left-[88px] z-10 ${isSearchMatch ? 'bg-primary/10' : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-primary/10' : 'bg-blue-50') : (isDark ? 'bg-background' : 'bg-white')}` : ''}`} style={{ width: width, minWidth: width, maxWidth: isOrderNum ? 120 : 'none' }}>
                                    {isOrderNum ? <span className={`font-mono font-medium truncate block ${isSearchMatch ? 'text-primary font-bold' : ''}`} title={order[col.key]}>{isSearchMatch ? <mark className="bg-yellow-300/60 text-foreground px-0.5 rounded">{order[col.key]}</mark> : order[col.key]}</span> : (
                                      <EditableCell value={order[col.key]} field={col.key} orderId={order.order_id} options={col.optionKey ? (options[col.optionKey] || col.statusOptions?.map(s => s.value)) : null} onUpdate={handleCellUpdate} type={col.type} isDark={isDark} allOrders={orders} columns={columns} readOnly={!canEditBoard} />
                                    )}
                                  </td>
                                );
                              })}
                              {(() => {
                                const ps = productionSummary[order.order_id]; const totalProduced = ps ? ps.total_produced : 0; const qty = order.quantity || 0; const remaining = Math.max(0, qty - totalProduced); const pct = qty > 0 ? Math.min(100, (totalProduced / qty) * 100) : 0; return (
                                  <td className="py-2 px-3" style={{ minWidth: 180 }} data-testid={`restante-${order.order_id}`}>{qty > 0 ? (<div className="space-y-1"><div className="flex justify-between text-[11px]"><span className="font-mono font-bold">{remaining}</span><span className={`font-bold ${pct >= 100 ? 'text-green-400' : pct >= 50 ? 'text-yellow-400' : 'text-muted-foreground'}`}>{pct.toFixed(0)}%</span></div><div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all ${pct >= 100 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div></div>) : <span className="text-xs text-muted-foreground">—</span>}</td>
                                );
                              })()}
                            </tr>
                          );
                        };
                        if (!groupByDate) return orders.map(renderOrderRow);
                        const groups = {};
                        const dateLabelsMap = {};
                        columns.filter(c => c.type === 'date').forEach(c => { dateLabelsMap[c.key] = c.label; });
                        dateLabelsMap['created_at'] = lang === 'es' ? 'Creacion' : 'Created';
                        orders.forEach(o => {
                          const raw = o[groupByDate];
                          const dateKey = raw ? new Date(raw).toLocaleDateString() : (lang === 'es' ? 'Sin fecha' : 'No date');
                          if (!groups[dateKey]) groups[dateKey] = [];
                          groups[dateKey].push(o);
                        });
                        const colSpan = 3 + visibleColumns.length + (currentBoard === 'MASTER' ? 1 : 0);
                        const noDateLabel = lang === 'es' ? 'Sin fecha' : 'No date';
                        const sortedEntries = Object.entries(groups).sort(([a], [b]) => {
                          if (a === noDateLabel) return 1;
                          if (b === noDateLabel) return -1;
                          const da = new Date(a), db = new Date(b);
                          return da - db;
                        });
                        return sortedEntries.map(([dateKey, groupOrders]) => (
                          <React.Fragment key={dateKey}>
                            <tr data-testid={`date-group-${dateKey}`}>
                              <td colSpan={colSpan} className={`py-2 px-4 font-barlow font-bold text-sm uppercase tracking-wide ${isDark ? 'bg-primary/10 text-primary border-b border-primary/30' : 'bg-blue-50 text-blue-700 border-b border-blue-200'}`}>
                                <CalendarDays className="w-4 h-4 inline mr-2 -mt-0.5" />{dateLabelsMap[groupByDate] || groupByDate}: {dateKey} <span className="font-normal text-xs text-muted-foreground ml-2">({groupOrders.length})</span>
                              </td>
                            </tr>
                            {groupOrders.map(renderOrderRow)}
                          </React.Fragment>
                        ));
                      })()}
                    </tbody>
                    <tfoot className={`sticky bottom-0 z-20 ${isDark ? 'bg-zinc-900 border-t-2 border-border' : 'bg-gray-200 border-t-2 border-gray-300'}`}>
                      <tr className={isDark ? 'bg-zinc-900/95 border-t-2 border-border' : 'bg-gray-200/95 border-t-2 border-gray-300'}>
                        <td className={`py-2 px-2 sticky left-0 z-20 font-barlow font-bold text-sm text-primary ${isDark ? 'bg-zinc-900' : 'bg-gray-200'}`} style={{ minWidth: 110 }}>{t('total')}</td>
                        <td className={`py-2 px-1 sticky left-[48px] z-20 ${isDark ? 'bg-zinc-900 border-t-2 border-border' : 'bg-gray-200 border-t-2 border-gray-300'}`}></td>
                        {visibleColumns.map(col => {
                          const isNumeric = col.type === 'number' || col.key === 'quantity';
                          const isFormula = col.type === 'formula';
                          const isOrderCol = col.key === 'order_number';
                          const width = isOrderCol ? 120 : (columnWidths[col.key] || col.width);
                          let total = null;
                          if (isNumeric) total = orders.reduce((sum, o) => sum + (parseFloat(o[col.key]) || 0), 0);
                          else if (isFormula) total = orders.reduce((sum, o) => { const v = parseFloat(evaluateFormula(col.key, o, columns)); return sum + (isNaN(v) ? 0 : v); }, 0);
                          return <td key={col.key} className={`py-2 px-3 ${isOrderCol ? `sticky left-[88px] z-20 ${isDark ? 'bg-zinc-900 border-t-2 border-border' : 'bg-gray-200 border-t-2 border-gray-300'}` : ''}`} style={{ width: width, minWidth: width, maxWidth: isOrderCol ? 120 : 'none' }}>{total !== null ? <span className="font-barlow font-bold text-sm text-primary" data-testid={`footer-total-${col.key}`}>{Number.isInteger(total) ? total.toLocaleString() : total.toFixed(2)}</span> : isOrderCol ? <span className="font-barlow font-bold text-sm text-primary">{t('total')}</span> : null}</td>;
                        })}
                        {(() => { const totalRemaining = orders.reduce((sum, o) => { const ps = productionSummary[o.order_id]; return sum + Math.max(0, (o.quantity || 0) - (ps ? ps.total_produced : 0)); }, 0); return <td className="py-2 px-3" style={{ minWidth: 180 }}><span className="font-barlow font-bold text-sm text-primary" data-testid="footer-total-restante">{totalRemaining.toLocaleString()}</span></td>; })()}
                      </tr>
                    </tfoot>
                  </table>
                  {orders.length === 0 && <div className="text-center py-12 text-muted-foreground">{t('no_orders')}</div>}
                </>
              )}
      </main>

      {/* Modals */}
      <NewOrderModal isOpen={showNewOrder} onClose={() => setShowNewOrder(false)} onCreate={(order) => { setOrders(prev => [order, ...prev]); }} options={options} columns={columns} />
      <CommentsModal order={commentsOrder} isOpen={!!commentsOrder} onClose={() => setCommentsOrder(null)} currentUser={user} />
      <AutomationsModal isOpen={showAutomations} onClose={() => setShowAutomations(false)} options={options} columns={columns} dynamicBoards={activeBoards} />
      {isAdmin && <ActivityLogModal isOpen={showActivityLog} onClose={() => setShowActivityLog(false)} onUndoSuccess={fetchOrders} t={t} />}
      {isAdmin && <OptionsManagerModal isOpen={showOptionsManager} onClose={() => setShowOptionsManager(false)} options={options} onOptionsUpdate={fetchOptions} onColorsUpdate={(colors) => { Object.entries(colors).forEach(([k, v]) => { STATUS_COLORS[k] = v; }); fetchOrders(); }} />}
      {isAdmin && <OperatorsManagerModal isOpen={showOperators} onClose={() => setShowOperators(false)} />}
      {isAdmin && <FormFieldsManagerModal isOpen={showFormFields} onClose={() => setShowFormFields(false)} columns={columns} />}
      {isAdmin && <InviteUsersModal isOpen={showInvite} onClose={() => setShowInvite(false)} boards={allBoardsIncludingHidden} />}
      <AddColumnModal isOpen={showAddColumn} onClose={() => setShowAddColumn(false)} onAdd={handleAddColumn} existingColumns={columns} options={options} />
      <AnalyticsView isOpen={showAnalytics} onClose={() => setShowAnalytics(false)} allOrders={allOrders} options={options} />
      <ProductionModal isOpen={showProduction} onClose={() => setShowProduction(false)} orders={allOrders} onProductionUpdate={() => { fetchProductionSummary(); fetchOrders(); }} isAdmin={isAdmin} />
      <GanttView isOpen={showGantt} onClose={() => setShowGantt(false)} isDark={isDark} />
      <CapacityPlanModal isOpen={showCapacityPlan} onClose={() => setShowCapacityPlan(false)} />
      {showProductionScreen && <ProductionScreen onClose={() => setShowProductionScreen(false)} isDark={isDark} />}

      {/* Trash Modal */}
      <Dialog open={showTrash} onOpenChange={setShowTrash}>
        <DialogContent className="max-w-4xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col" data-testid="trash-modal">
          <DialogHeader><DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-3"><Trash2 className="w-5 h-5 text-destructive" /> {t('trash_title')} <span className="text-sm font-normal text-muted-foreground">({trashOrders.length})</span></DialogTitle></DialogHeader>
          <div className="flex-1 overflow-y-auto py-4">
            {trashLoading ? <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div> :
              trashOrders.length > 0 ? (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card"><tr className="border-b border-border"><th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">{t('order')}</th><th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">{t('client')}</th><th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">{t('priority')}</th><th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">{t('date_time')}</th><th className="text-right py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">{t('actions')}</th></tr></thead>
                  <tbody>{trashOrders.map(order => (
                    <tr key={order.order_id} className="border-b border-border/50 hover:bg-secondary/30" data-testid={`trash-order-${order.order_id}`}>
                      <td className="py-2 px-3 font-mono text-foreground">{order.order_number}</td>
                      <td className="py-2 px-3 text-foreground">{order.client || '-'}</td>
                      <td className="py-2 px-3"><ColoredBadge value={order.priority} isDark={isDark} /></td>
                      <td className="py-2 px-3 text-muted-foreground text-xs">{order.updated_at ? new Date(order.updated_at).toLocaleString() : '-'}</td>
                      <td className="py-2 px-3 text-right"><div className="flex items-center justify-end gap-1">
                        <Select onValueChange={(board) => handleRestoreFromTrash([order.order_id], board)}>
                          <SelectTrigger className="w-36 h-7 text-xs bg-secondary border-border" data-testid={`restore-select-${order.order_id}`}><SelectValue placeholder={t('restore')} /></SelectTrigger>
                          <SelectContent className="bg-popover border-border z-[300]">{activeBoards.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}</SelectContent>
                        </Select>
                        <button onClick={() => handlePermanentDelete([order.order_id])} className="p-1.5 rounded hover:bg-destructive/20 transition-colors" title={t('permanent_delete')} data-testid={`permanent-delete-${order.order_id}`}><X className="w-4 h-4 text-destructive" /></button>
                      </div></td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <p className="text-center text-muted-foreground py-8">{t('no_trash')}</p>}
          </div>
          {trashOrders.length > 0 && (
            <div className="flex justify-between items-center pt-4 border-t border-border">
              <button onClick={() => handleRestoreFromTrash(trashOrders.map(o => o.order_id), 'SCHEDULING')} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 flex items-center gap-2" data-testid="restore-all-btn"><RefreshCw className="w-4 h-4" /> {t('restore')} → SCHEDULING</button>
              <button onClick={() => handlePermanentDelete(trashOrders.map(o => o.order_id))} className="px-4 py-2 bg-destructive/20 text-destructive rounded text-sm hover:bg-destructive/30 flex items-center gap-2" data-testid="empty-trash-btn"><Trash2 className="w-4 h-4" /> {t('empty_trash')}</button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Search Results Modal */}
      <Dialog open={!!searchResults} onOpenChange={() => setSearchResults(null)}>
        <DialogContent className="max-w-2xl max-h-[70vh] bg-card border-border overflow-hidden flex flex-col" data-testid="search-results-modal">
          <DialogHeader>
            <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-3">
              <Search className="w-5 h-5" /> Resultados de busqueda <span className="text-sm font-normal text-muted-foreground">({searchResults?.length || 0})</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto py-2">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">{t('order')}</th>
                  <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Store PO</th>
                  <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Customer PO</th>
                  <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">{t('client')}</th>
                  <th className="text-left py-2 px-3 font-barlow uppercase text-xs text-muted-foreground">Tablero</th>
                </tr>
              </thead>
              <tbody>
                {searchResults?.map(order => (
                  <tr key={order.order_id}
                    onClick={() => { setCurrentBoard(order.board); setSearchResults(null); setSearchQuery(order.order_number || ''); toast.success(`${order.order_number} → ${order.board}`); }}
                    className="border-b border-border/50 hover:bg-primary/10 cursor-pointer transition-colors"
                    data-testid={`search-result-${order.order_id}`}>
                    <td className="py-2.5 px-3 font-mono font-medium text-primary">{order.order_number || '-'}</td>
                    <td className="py-2.5 px-3 text-foreground">{order.store_po || '-'}</td>
                    <td className="py-2.5 px-3 text-foreground">{order.customer_po || '-'}</td>
                    <td className="py-2.5 px-3 text-foreground">{order.client || '-'}</td>
                    <td className="py-2.5 px-3"><span className="px-2 py-0.5 rounded text-xs font-bold" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666', color: '#fff' }}>{order.board}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Board Confirmation Modal */}
      <Dialog open={!!deleteBoardConfirm} onOpenChange={() => setDeleteBoardConfirm(null)}>
        <DialogContent className="max-w-md bg-card border-border" data-testid="delete-board-modal">
          {deleteBoardConfirm?.step === 1 && (
            <>
              <div className="flex flex-col items-center text-center py-4 space-y-4">
                <div className="w-16 h-16 rounded-full bg-destructive/20 flex items-center justify-center">
                  <AlertTriangle className="w-8 h-8 text-destructive" />
                </div>
                <div>
                  <h2 className="text-lg font-barlow font-bold uppercase text-destructive">Eliminar Tablero</h2>
                  <p className="text-sm text-muted-foreground mt-2">Estas a punto de eliminar el tablero <strong className="text-foreground">"{deleteBoardConfirm.name}"</strong></p>
                  <p className="text-sm text-muted-foreground mt-1">Todas las ordenes de este tablero se moveran automaticamente a <strong className="text-primary">MASTER</strong>.</p>
                </div>
                <div className="w-full p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
                  <p className="text-xs text-destructive font-bold uppercase tracking-wide">Esta accion no se puede deshacer</p>
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setDeleteBoardConfirm(null)} className="flex-1 py-2.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors text-sm" data-testid="cancel-delete-board">Cancelar</button>
                <button onClick={() => setDeleteBoardConfirm({ ...deleteBoardConfirm, step: 2 })} className="flex-1 py-2.5 rounded bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors text-sm font-bold" data-testid="confirm-delete-step1">Si, quiero eliminar</button>
              </div>
            </>
          )}
          {deleteBoardConfirm?.step === 2 && (
            <>
              <div className="flex flex-col items-center text-center py-4 space-y-4">
                <div className="w-20 h-20 rounded-full bg-destructive flex items-center justify-center animate-pulse">
                  <Trash2 className="w-10 h-10 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-barlow font-black uppercase text-destructive">Confirmacion Final</h2>
                  <p className="text-sm text-muted-foreground mt-2">Vas a eliminar <strong className="text-destructive">"{deleteBoardConfirm.name}"</strong> permanentemente.</p>
                  <p className="text-base font-bold text-foreground mt-3">Estas completamente seguro?</p>
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setDeleteBoardConfirm(null)} className="flex-1 py-2.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-bold" data-testid="cancel-delete-final">No, conservar tablero</button>
                <button onClick={async () => { const ok = await deleteBoard(deleteBoardConfirm.name); setDeleteBoardConfirm(null); if (ok) setCurrentBoard('MASTER'); }} className="flex-1 py-2.5 rounded bg-destructive text-white hover:bg-destructive/90 transition-colors text-sm font-black uppercase tracking-wide" data-testid="confirm-delete-final">Eliminar definitivamente</button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Dashboard;
