import React, { useState, useCallback, useEffect, useRef } from "react";
import { useAuth } from "../App";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import {
  Search, Plus, LogOut, X, RefreshCw, Trash2, ListFilter,
  Download, Sun, Moon, Settings, GripVertical, PlusCircle,
  BarChart3, UserPlus, Bell, Eye, EyeOff, CalendarDays, CalendarCheck, Pin, Save, Table2, Undo2,
  Factory, GanttChart, TrendingUp, Languages, Monitor, MessageSquare, Loader2, History, Zap, AtSign, AlertTriangle, Users, ClipboardList, DatabaseBackup, Warehouse, ImageDown, ImageUp, FileJson, ArrowRightLeft,
  ChevronDown, ChevronUp, Check, FileDown, Home, ExternalLink
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel, SelectSeparator } from "./ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
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
import { OptionsManagerModal } from "./dashboard/OptionsManagerModal";
import { OperatorsManagerModal } from "./dashboard/OperatorsManagerModal";
import { FormFieldsManagerModal } from "./dashboard/FormFieldsManagerModal";
// Existing top-level components
import AnalyticsView from "./AnalyticsView";
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
  const navigate = useNavigate();
  const { t, lang, toggleLang } = useLang();

  // Board & filter state
  const [currentBoard, setCurrentBoard] = useState("SCHEDULING");
  const [boardFilters, setBoardFilters] = useState({});
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [openFilter, setOpenFilter] = useState(null);
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
  const [showOptionsManager, setShowOptionsManager] = useState(false);
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
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
  const [showMachinesVisibility, setShowMachinesVisibility] = useState(false);
  const [highlightedCommentId, setHighlightedCommentId] = useState(null);

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

  useEffect(() => {
    setSelectedOrders([]);
  }, [currentBoard]);

  // Handle URL parameters from Home Dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const boardParam = params.get('board');
    if (boardParam && (dynamicBoards.length > 0 ? dynamicBoards : BOARDS).includes(boardParam)) {
      setCurrentBoard(boardParam);
    }
    const actionParam = params.get('action');
    if (actionParam) {
      if (actionParam === 'showAutomations') setShowAutomations(true);
      if (actionParam === 'showProduction') setShowProduction(true);
      if (actionParam === 'showAnalytics') setShowAnalytics(true);
      if (actionParam === 'showTrash') setShowTrash(true);
      if (actionParam === 'showGantt') setShowGantt(true);
      if (actionParam === 'showCapacityPlan') setShowCapacityPlan(true);
      if (actionParam === 'showProductionScreen') setShowProductionScreen(true);
      // Clean up URL without reload
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [dynamicBoards]); // eslint-disable-line react-hooks/exhaustive-deps

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
    try {
      const selectedIds = selectedOrders.map(String);
      const ordersToExport = allOrders.filter(o => selectedIds.includes(String(o.order_id)));
      
      if (ordersToExport.length === 0) {
        toast.error(t('select_export'));
        return;
      }

      const exportData = ordersToExport.map(o => {
        const row = {};
        visibleColumns.forEach(col => {
          row[col.label] = o[col.key] || '';
        });
        row[t('board')] = o.board;
        return row;
      });

      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, t('orders'));
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveAs(blob, `orders_export_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast.success(`${ordersToExport.length} ${t('orders')} exported (solo visibles)`);
    } catch (e) {
      console.error('Export error:', e);
      toast.error('Error exporting: ' + (e.message || ''));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedOrders.length === 0) return;
    const confirmMsg = `${t('delete')} ${selectedOrders.length} ${t('orders')}?`;
    if (!window.confirm(confirmMsg)) return;
    
    try {
      await handleBulkMove(selectedOrders, "PAPELERA DE RECICLAJE");
      setSelectedOrders([]);
    } catch (err) {
      console.error('Bulk delete error:', err);
      toast.error(t('move_err'));
    }
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
    <div className={`h-screen flex flex-col overflow-hidden ${!isDark ? 'light-theme' : ''} bg-background text-foreground transition-colors duration-300`}>
      <Toaster position="bottom-right" theme={isDark ? "dark" : "light"} />
      <LoadingOverlay isLoading={operationLoading} message={t('processing')} />

      {automationRunning && (
        <div className="fixed bottom-6 right-6 z-[200] flex items-center gap-3 bg-primary text-primary-foreground px-5 py-3 rounded-lg shadow-2xl animate-pulse" data-testid="automation-running-indicator">
          <Loader2 className="w-5 h-5 animate-spin" />
          <div><div className="text-sm font-bold">Ejecutando automatizacion...</div><div className="text-xs opacity-80">{automationMessage}</div></div>
        </div>
      )}

      {/* Header */}
      <header className={`border-b px-2 md:px-4 py-2 flex items-center justify-between z-50 ${isDark ? 'glass-header border-border' : 'bg-secondary/30 border-gray-200 shadow-sm'}`}>
        <div className="flex items-center gap-3 flex-shrink-0">
          <h1 onClick={() => navigate('/home')} className={`font-roboto font-black text-base md:text-lg tracking-tight uppercase cursor-pointer hover:opacity-80 transition-opacity ${isDark ? 'text-glow-primary' : 'text-gray-900'}`}>MOS <span className="text-primary font-black">S</span><span className="text-primary hidden md:inline font-black">YSTEM</span></h1>
          {/* Notifications Bell - next to logo */}
          <div>
            <button onClick={() => { setShowNotifications(!showNotifications); if (!showNotifications && unreadCount > 0) markNotificationsRead(); }} className={`p-2 rounded-lg relative flex items-center justify-center transition-all ${unreadCount > 0 ? 'text-primary' : (isDark ? 'text-muted-foreground hover:text-foreground' : 'text-gray-500 hover:text-gray-900')}`} title={t('notifications')} data-testid="notifications-btn">
              <Bell className={`w-5 h-5 md:w-6 md:h-6 ${unreadCount > 0 ? 'animate-pulse-primary' : ''}`} />
              {unreadCount > 0 && (
                <>
                  <span className="absolute -top-0.5 -right-0.5 min-w-[20px] h-[20px] bg-destructive text-white text-[10px] font-black rounded-full flex items-center justify-center px-1 shadow-lg border-2 border-background animate-bounce" data-testid="notification-badge">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                  <span className="absolute -top-0.5 -right-0.5 min-w-[20px] h-[20px] bg-destructive rounded-full animate-ping-soft opacity-75"></span>
                </>
              )}
            </button>
            {showNotifications && require('react-dom').createPortal(
              <div className={`fixed left-2 md:left-4 top-[60px] w-80 max-h-80 overflow-y-auto rounded-lg shadow-2xl border z-[99999] bg-card border-border`} data-testid="notifications-dropdown">
                <div className="p-3 border-b border-border flex items-center justify-between">
                  <span className="font-roboto font-black text-sm uppercase tracking-widest text-primary text-glow-primary">Notificaciones</span>
                  {unreadCount > 0 && <span className="text-[10px] bg-primary/20 text-primary px-2 py-0.5 rounded-full font-bold animate-pulse">NUEVAS</span>}
                </div>
                {notifications.length > 0 ? notifications.slice(0, 20).map(n => {
                  const isMention = n.type === 'mention' || n.type === 'comment';
                  return (
                    <div key={n.notification_id} className={`p-4 border-b border-border/40 text-sm cursor-pointer transition-all hover:bg-primary/5 ${!n.read ? (isMention ? 'mention-highlight' : 'bg-primary/5') : 'opacity-80'}`}
                      onClick={async () => {
                        setShowNotifications(false);
                        if (!n.order_id) return;
                        let targetOrder = allOrders.find(o => o.order_id === n.order_id);
                        if (!targetOrder) {
                          try { const res = await fetch(`${API}/orders/${n.order_id}`, { credentials: 'include' }); if (res.ok) targetOrder = await res.json(); } catch { /* silent */ }
                        }
                        if (targetOrder) {
                          setCurrentBoard(targetOrder.board);
                          if (n.type === 'comment' || n.type === 'mention') {
                            setHighlightedCommentId(n.comment_id || null);
                            setTimeout(() => setCommentsOrder(targetOrder), 300);
                          }
                        }
                      }}
                      data-testid={`notification-${n.notification_id}`}>
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 p-1.5 rounded-full ${isMention ? 'bg-primary/20 text-primary shadow-inner' : 'bg-secondary text-muted-foreground'}`}>
                          {n.type === 'mention' ? <AtSign className="w-4 h-4 animate-pulse" /> : 
                           n.type === 'move' ? <ArrowRightLeft className="w-4 h-4" /> : 
                           <MessageSquare className="w-4 h-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={`leading-relaxed ${!n.read ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>
                            {isMention && <span className="text-[10px] text-primary font-black uppercase tracking-tighter mr-1.5 inline-block px-1.5 py-0 bg-primary/10 rounded border border-primary/20">Mencion</span>}
                            {n.message}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1.5 uppercase font-medium tracking-tighter">
                            {new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            <span className="opacity-30">•</span>
                            {new Date(n.created_at).toLocaleDateString()}
                          </div>
                        </div>
                        {!n.read && <div className="w-2 h-2 rounded-full bg-primary mt-2 flex-shrink-0 shadow-[0_0_8px_hsl(var(--primary))]"></div>}
                      </div>
                    </div>
                  );
                }) : <div className="p-8 text-center"><div className="text-muted-foreground text-sm font-medium">Bandeja de entrada vacía</div><div className="text-[10px] text-muted-foreground/60 uppercase mt-1 tracking-widest">No hay nuevas alertas</div></div>}
              </div>,
              document.body
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-1 justify-center max-w-xs md:max-w-md mx-2 md:mx-4">
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter') { const results = await handleGlobalSearch(searchQuery, setCurrentBoard); if (results) setSearchResults(results); } }} placeholder={t('search_placeholder')} className={`w-full rounded px-2 md:px-3 py-1.5 text-sm bg-secondary/50 border border-border text-foreground`} data-testid="global-search-input" />
          <button onClick={async () => { const results = await handleGlobalSearch(searchQuery, setCurrentBoard); if (results) setSearchResults(results); }} className={`p-1.5 rounded flex-shrink-0 bg-secondary/80 border border-border hover:bg-secondary`} data-testid="global-search-btn"><Search className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
          {/* Grouped utilities */}
          <div className={`flex items-center gap-0.5 rounded-xl border border-border p-0.5 ${isDark ? 'bg-secondary/40' : 'bg-secondary/60'}`}>
            <button onClick={toggleTheme} className={`p-1.5 rounded-lg flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title={isDark ? t('light_mode') : t('dark_mode')} data-testid="theme-toggle-btn">{isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}</button>
            <button onClick={toggleLang} className={`p-1.5 rounded-lg flex items-center gap-0.5 text-[10px] font-bold flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} data-testid="lang-toggle-btn"><Languages className="w-3.5 h-3.5" />{lang === 'es' ? 'EN' : 'ES'}</button>
            <button onClick={() => setShowAutomations(true)} className={`p-1.5 rounded-lg flex-shrink-0 hidden md:flex text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title={t('automations')} data-testid="automations-btn"><Zap className="w-3.5 h-3.5" /></button>
            <button onClick={() => { setShowTrash(true); fetchTrashOrders(); }} className={`p-1.5 rounded-lg flex-shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all`} title={t('trash')} data-testid="trash-btn"><Trash2 className="w-3.5 h-3.5" /></button>
            <button onClick={() => { setShowAnalytics(true); fetchAllOrders(); }} className={`p-1.5 rounded-lg flex-shrink-0 hidden md:flex text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title={t('analytics')} data-testid="analytics-btn"><BarChart3 className="w-3.5 h-3.5" /></button>
          </div>
          {isAdmin && (<>
            <div className={`flex items-center gap-0.5 rounded-xl border border-border p-0.5 ml-1 ${isDark ? 'bg-secondary/40' : 'bg-secondary/60'}`}>
              <button onClick={handleQuickUndo} className={`p-1.5 rounded-lg flex-shrink-0 hidden md:flex text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title={t('undo_last')} data-testid="quick-undo-btn"><Undo2 className="w-3.5 h-3.5" /></button>
              <button onClick={() => navigate('/users')} className={`p-1.5 rounded-lg flex-shrink-0 hidden md:flex text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title={t('invite_users')} data-testid="invite-users-btn"><UserPlus className="w-3.5 h-3.5" /></button>
              <button onClick={() => navigate('/activity-log')} className={`p-1.5 rounded-lg flex-shrink-0 hidden md:flex text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title={t('activity_log')} data-testid="activity-log-btn"><History className="w-3.5 h-3.5" /></button>
              <button onClick={() => setShowOptionsManager(true)} className={`p-1.5 rounded-lg flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title={t('manage_options')} data-testid="manage-options-btn"><Settings className="w-3.5 h-3.5" /></button>
              <button onClick={() => setShowOperators(true)} className={`p-1.5 rounded-lg flex-shrink-0 hidden lg:flex text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title="Gestionar Operadores" data-testid="manage-operators-btn"><Users className="w-3.5 h-3.5" /></button>
              <button onClick={() => setShowFormFields(true)} className={`p-1.5 rounded-lg flex-shrink-0 hidden lg:flex text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all`} title="Campos del Formulario" data-testid="manage-form-fields-btn"><ClipboardList className="w-3.5 h-3.5" /></button>
            </div>
          </>)}
        </div>
        <div className="w-px h-5 bg-border mx-0.5 flex-shrink-0"></div>
        <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
          {user?.picture && <img src={user.picture} alt="" className="w-6 h-6 md:w-7 md:h-7 rounded-full" />}
          <div className="flex-col leading-tight hidden sm:flex"><span className={`text-xs font-medium text-foreground`}>{user?.name}</span>{isAdmin && <span className="text-[10px] text-primary font-bold">Admin</span>}</div>
          <button onClick={logout} className="p-1.5 text-muted-foreground hover:text-foreground flex-shrink-0" title={t('logout')}><LogOut className="w-3.5 h-3.5" /></button>
        </div>
      </header>

      {/* Board Bar */}
      <div className="px-3 md:px-5 py-2.5 flex items-center justify-between gap-3 shadow-lg bg-cover bg-center scanline" style={{ ...getBoardStyle(currentBoard), color: '#FFFFFF' }}>

        {/* LEFT: Board selector + count */}
        <div className="flex items-center gap-2.5 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger className="h-8.5 bg-white/10 border border-white/25 text-white font-roboto font-black text-sm md:text-base backdrop-blur-md rounded-2xl flex items-center justify-between px-3 md:px-5 hover:bg-white/20 transition-all outline-none focus:ring-2 focus:ring-white/30 shadow-lg glow-primary gap-2 min-w-[140px] md:min-w-[200px]" data-testid="board-selector">
              <span className="truncate font-black tracking-tight">{currentBoard}</span>
              <ChevronDown className="w-3.5 h-3.5 opacity-70 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="z-[300] min-w-[220px] border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in fade-in zoom-in-95 duration-150 rounded-3xl p-1.5">
              {visibleBoards.filter(b => !b.startsWith('MAQUINA')).map(board => (
                <DropdownMenuItem key={board} onClick={() => { setCurrentBoard(board); setSelectedOrders([]); }} className={`flex items-center justify-between py-2.5 px-5 text-sm font-black tracking-tight rounded-2xl cursor-pointer transition-colors ${currentBoard === board ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-foreground'}`}>
                  {board}
                  {currentBoard === board ? <Check className="w-4 h-4" /> : <div className="w-4" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="opacity-50 my-1.5" />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center justify-between py-2.5 px-5 text-sm font-black text-primary cursor-pointer hover:bg-primary/5 uppercase tracking-wider rounded-2xl">
                  <div className="flex items-center gap-2.5"><Monitor className="w-4.5 h-4.5" /><span>MAQUINAS</span></div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="z-[301] min-w-[200px] shadow-2xl p-1.5 rounded-2xl bg-card border border-border/50">
                  {visibleBoards.filter(b => b.startsWith('MAQUINA')).map(board => (
                    <DropdownMenuItem key={board} onClick={() => { setCurrentBoard(board); setSelectedOrders([]); }} className={`flex items-center justify-between py-2 px-4 text-xs md:text-sm font-black tracking-tight rounded-xl cursor-pointer ${currentBoard === board ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-foreground'}`}>
                      {board}{currentBoard === board && <Check className="w-4 h-4 ml-2" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="text-[11px] font-mono font-bold bg-white/15 backdrop-blur-sm px-2.5 py-1 rounded-lg flex-shrink-0 border border-white/10 shadow-inner" data-testid="order-count">
            {orders.length} <span className="text-[9px] font-normal opacity-70">ORD_QTY</span>
          </span>
        </div>

        {/* CENTER / RIGHT: Action buttons */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide flex-shrink-0">
          {/* Primary actions */}
          {currentBoard === 'SCHEDULING' && (
            <button onClick={() => setShowNewOrder(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-white/20 hover:bg-white/30 border border-white/20 backdrop-blur-sm transition-all whitespace-nowrap shadow-sm"
              data-testid="new-order-btn">
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('new_order')}</span>
            </button>
          )}

          {/* Consistent nav buttons group */}
          <div className="flex items-center gap-1 bg-white/10 backdrop-blur-sm border border-white/15 rounded-xl p-1">
            <button onClick={() => { setShowProduction(true); fetchAllOrders(); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-500/80 hover:bg-emerald-500 transition-all whitespace-nowrap"
              data-testid="production-btn">
              <Factory className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('production')}</span>
            </button>
            <button onClick={() => setShowGantt(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold hover:bg-white/20 transition-all whitespace-nowrap"
              data-testid="gantt-btn">
              <GanttChart className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('gantt')}</span>
            </button>
            <button onClick={() => setShowCapacityPlan(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-orange-500/80 hover:bg-orange-500 transition-all whitespace-nowrap"
              data-testid="capacity-plan-btn">
              <TrendingUp className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('plan')}</span>
            </button>
            <button onClick={() => setShowProductionScreen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold hover:bg-white/20 transition-all whitespace-nowrap"
              data-testid="production-screen-btn">
              <Monitor className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{t('prod_screen_title')}</span>
            </button>
            <button onClick={() => window.location.href = '/wms'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold hover:bg-white/20 transition-all whitespace-nowrap"
              data-testid="wms-btn">
              <Warehouse className="w-3.5 h-3.5" /> WMS
            </button>
          </div>

          {/* Admin tools — icon tray */}
          {isAdmin && (
            <div className="flex items-center gap-0.5 bg-white/10 backdrop-blur-sm border border-white/15 rounded-xl p-1 ml-0.5">
              {!showNewBoard ? (
                <button onClick={() => setShowNewBoard(true)} className="p-1.5 rounded-lg hover:bg-white/20 transition-all" title="Crear tablero" data-testid="create-board-btn"><Plus className="w-4 h-4" /></button>
              ) : (
                <div className="flex items-center gap-1 px-2 py-1">
                  <input type="text" value={newBoardName} onChange={e => setNewBoardName(e.target.value)}
                    onKeyDown={async e => { if (e.key === 'Enter' && newBoardName.trim()) { const ok = await createBoard(newBoardName.trim()); if (ok) { setNewBoardName(''); setShowNewBoard(false); } } if (e.key === 'Escape') setShowNewBoard(false); }}
                    placeholder="Nombre..." className="w-24 h-6 px-2 text-xs bg-white/10 border border-white/30 rounded text-white placeholder-white/50" autoFocus data-testid="new-board-input" />
                  <button onClick={async () => { if (newBoardName.trim()) { const ok = await createBoard(newBoardName.trim()); if (ok) { setNewBoardName(''); setShowNewBoard(false); } } }} className="p-0.5 hover:bg-white/10 rounded"><Plus className="w-3.5 h-3.5" /></button>
                  <button onClick={() => { setShowNewBoard(false); setNewBoardName(''); }} className="p-0.5 hover:bg-white/10 rounded"><X className="w-3.5 h-3.5" /></button>
                </div>
              )}
              {currentBoard !== 'MASTER' && currentBoard !== 'COMPLETOS' && currentBoard !== 'PAPELERA DE RECICLAJE' && (
                <button onClick={() => setDeleteBoardConfirm({ step: 1, name: currentBoard })} className="p-1.5 rounded-lg hover:bg-red-500/50 transition-all" title={`Eliminar ${currentBoard}`} data-testid="delete-board-btn"><Trash2 className="w-4 h-4" /></button>
              )}
              <button onClick={() => setShowAddColumn(true)} className="p-1.5 rounded-lg hover:bg-white/20 transition-all" title={t('add_column')} data-testid="add-column-btn"><PlusCircle className="w-4 h-4" /></button>
              <Popover open={showBoardVisibility} onOpenChange={setShowBoardVisibility}>
                <PopoverTrigger asChild>
                  <button className="p-1.5 rounded-lg hover:bg-white/20 transition-all" title="Ocultar/Mostrar Tableros" data-testid="board-visibility-btn">
                    <Eye className="w-4 h-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64 max-h-80 overflow-y-auto rounded-xl shadow-2xl border z-[400] bg-card border-border p-0" align="end">
                  <div className="p-3 border-b border-border font-roboto font-black text-xs uppercase tracking-widest text-foreground text-glow-primary">Visibilidad de Tableros</div>
                  {allBoardsIncludingHidden.filter(b => b !== 'MASTER' && !b.startsWith('MAQUINA')).map(b => {
                    const isHidden = hiddenBoards.includes(b);
                    return (
                      <button key={b} onClick={() => toggleBoardVisibility(b)} className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-all ${isHidden ? 'opacity-50' : ''}`} data-testid={`board-vis-${b}`}>
                        {isHidden ? <EyeOff className="w-3.5 h-3.5 text-muted-foreground" /> : <Eye className="w-3.5 h-3.5 text-green-500" />}
                        <span className={`flex-1 ${isHidden ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{b}</span>
                      </button>
                    );
                  })}
                  <button onClick={() => setShowMachinesVisibility(!showMachinesVisibility)} className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-black bg-secondary/30 text-primary uppercase tracking-widest mt-1 hover:bg-secondary/50 transition-all">
                    <div className="flex items-center gap-1.5"><Monitor className="w-3 h-3" /> MAQUINAS</div>
                    {showMachinesVisibility ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  {showMachinesVisibility && allBoardsIncludingHidden.filter(b => b.startsWith('MAQUINA')).map(b => {
                    const isHidden = hiddenBoards.includes(b);
                    return (
                      <button key={b} onClick={() => toggleBoardVisibility(b)} className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-all ${isHidden ? 'opacity-50' : ''}`} data-testid={`board-vis-${b}`}>
                        {isHidden ? <EyeOff className="w-3.5 h-3.5 text-muted-foreground" /> : <Eye className="w-3.5 h-3.5 text-green-500" />}
                        <span className={`flex-1 ${isHidden ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{b}</span>
                      </button>
                    );
                  })}
                  <div className="p-2 border-t border-border"><p className="text-[10px] text-muted-foreground">Los tableros ocultos no aparecen en el selector.</p></div>
                </PopoverContent>
              </Popover>
              <button onClick={() => setShowColumnManager(!showColumnManager)} className="p-1.5 rounded-lg hover:bg-white/20 transition-all" title={t('show_columns')} data-testid="column-manager-btn"><Settings className="w-4 h-4" /></button>
            </div>
          )}
        </div>
      </div>

      {/* Column Manager Panel */}
      {showColumnManager && (
        <div className={`border-b px-4 py-3 bg-secondary/30 border-border`} data-testid="column-manager-panel">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Columnas del tablero: {currentBoard}</span>
            <button onClick={() => setShowColumnManager(false)} className="p-1 hover:bg-secondary rounded"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex flex-wrap gap-2">
            {columns.map(col => {
              const isHidden = (hiddenColumns[currentBoard] || []).includes(col.key);
              return (
                <div key={col.key} className={`flex items-center gap-1 px-2 py-1 rounded text-xs border transition-all ${isHidden ? 'opacity-40 border-dashed border-border' : 'bg-secondary border-border'}`} data-testid={`col-mgr-${col.key}`}>
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
      <div className={`border-b px-3 md:px-5 relative z-50 ${isDark ? 'bg-[hsl(220,28%,10%)] border-border/50' : 'bg-white/80 border-gray-100'}`}>
        <div className="flex items-center gap-2 py-2 overflow-x-auto scrollbar-hide">

          {/* View pills */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button onClick={() => handleApplyView(null)}
              className={`px-3 py-1.5 text-[11px] font-bold rounded-full whitespace-nowrap transition-all border ${
                activeViewName === null
                  ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/30'
                  : (isDark ? 'border-border/60 text-muted-foreground hover:text-foreground hover:bg-secondary/60' : 'border-gray-200 text-gray-500 hover:text-gray-800 hover:bg-gray-50')
              }`}
              data-testid="view-general">{t('general')}</button>

            {pinnedViews.map(v => (
              <div key={v.view_id} className="relative group flex-shrink-0">
                <button onClick={() => handleApplyView(v)}
                  className={`px-3 py-1.5 text-[11px] font-bold rounded-full whitespace-nowrap flex items-center gap-1 transition-all border ${
                    activeViewName === v.name
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/30'
                      : (isDark ? 'border-border/60 text-muted-foreground hover:text-foreground hover:bg-secondary/60' : 'border-gray-200 text-gray-500 hover:text-gray-800 hover:bg-gray-50')
                  }`}
                  data-testid={`view-pinned-${v.name}`}>
                  <Pin className="w-2.5 h-2.5 opacity-70" /> {v.name}
                </button>
                <div className="absolute -top-1.5 -right-1.5 hidden group-hover:flex gap-0.5 z-10">
                  <button onClick={(e) => { e.stopPropagation(); handleTogglePinView(v.view_id, v.pinned); }} className="w-4 h-4 bg-yellow-500 rounded-full flex items-center justify-center shadow-sm"><Pin className="w-2.5 h-2.5 text-white" /></button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteView(v.view_id); }} className="w-4 h-4 bg-destructive rounded-full flex items-center justify-center shadow-sm"><X className="w-2.5 h-2.5 text-white" /></button>
                </div>
              </div>
            ))}

            {unpinnedViews.map(v => (
              <div key={v.view_id} className="relative group flex-shrink-0">
                <button onClick={() => handleApplyView(v)}
                  className={`px-3 py-1.5 text-[11px] font-bold rounded-full whitespace-nowrap transition-all border ${
                    activeViewName === v.name
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/30'
                      : (isDark ? 'border-border/60 text-muted-foreground hover:text-foreground hover:bg-secondary/60' : 'border-gray-200 text-gray-500 hover:text-gray-800 hover:bg-gray-50')
                  }`}>{v.name}</button>
                <div className="absolute -top-1.5 -right-1.5 hidden group-hover:flex gap-0.5 z-10">
                  <button onClick={(e) => { e.stopPropagation(); handleTogglePinView(v.view_id, v.pinned); }} className="w-4 h-4 bg-primary rounded-full flex items-center justify-center shadow-sm"><Pin className="w-2.5 h-2.5 text-white" /></button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteView(v.view_id); }} className="w-4 h-4 bg-destructive rounded-full flex items-center justify-center shadow-sm"><X className="w-2.5 h-2.5 text-white" /></button>
                </div>
              </div>
            ))}

            {Object.keys(filters).some(k => filters[k]) && (
              showSaveView ? (
                <div className="flex items-center gap-1">
                  <input type="text" value={newViewName} onChange={(e) => setNewViewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSaveView()} placeholder={t('view_name')} className="bg-secondary border border-border rounded-full px-3 py-1 text-[11px] w-28 text-foreground" autoFocus data-testid="save-view-input" />
                  <button onClick={handleSaveView} className="px-2 py-1 bg-primary text-primary-foreground rounded-full text-[11px]" data-testid="save-view-confirm"><Save className="w-3 h-3" /></button>
                  <button onClick={() => setShowSaveView(false)} className="p-1 text-muted-foreground hover:text-destructive"><X className="w-3 h-3" /></button>
                </div>
              ) : (
                <button onClick={() => setShowSaveView(true)} className="px-2.5 py-1.5 text-[11px] font-bold text-primary hover:bg-primary/10 rounded-full flex items-center gap-1 border border-primary/30 transition-all" data-testid="save-view-btn">
                  <Save className="w-3 h-3" /> {t('save_view')}
                </button>
              )
            )}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* RIGHT: View toggles + Group by */}
          <div className="flex items-center gap-2 flex-shrink-0">

            {/* View mode segmented control */}
            {(currentBoard === 'SCHEDULING' || currentBoard === 'EJEMPLOS') && (
              <div className={`flex items-center rounded-lg p-0.5 border ${isDark ? 'bg-secondary/50 border-border/60' : 'bg-gray-100 border-gray-200'}`}>
                <button onClick={() => { setCalendarMode(false); setBlanksTrackingMode(false); setReadyCalendarMode(false); }}
                  className={`p-1.5 rounded-md transition-all ${ !calendarMode && !blanksTrackingMode && !readyCalendarMode ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  title={t('table_view')} data-testid="toggle-table-view"><Table2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => { setCalendarMode(true); setBlanksTrackingMode(false); setReadyCalendarMode(false); }}
                  className={`p-1.5 rounded-md transition-all ${calendarMode ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  title={t('calendar_view')} data-testid="toggle-calendar-view"><CalendarDays className="w-3.5 h-3.5" /></button>
                {currentBoard === 'SCHEDULING' && (<>
                  <button onClick={() => { setReadyCalendarMode(true); setCalendarMode(false); setBlanksTrackingMode(false); }}
                    className={`p-1.5 rounded-md transition-all ${readyCalendarMode ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    title="Ready To Schedule" data-testid="toggle-ready-calendar"><CalendarCheck className="w-3.5 h-3.5" /></button>
                  <button onClick={() => { setBlanksTrackingMode(true); setCalendarMode(false); setReadyCalendarMode(false); }}
                    className={`p-1.5 rounded-md transition-all ${blanksTrackingMode ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    title="Seguimiento de Blanks" data-testid="toggle-blanks-tracking"><ClipboardList className="w-3.5 h-3.5" /></button>
                </>)}
              </div>
            )}

            {/* Group by date */}
            {(() => {
              const dateCols = columns.filter(c => c.type === 'date');
              const dateKeys = new Set(dateCols.map(c => c.key));
              if (!dateKeys.has('created_at')) dateCols.push({ key: 'created_at', label: lang === 'es' ? 'Creacion' : 'Created' });
              return (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 hidden sm:block">{lang === 'es' ? 'Agrupar' : 'Group'}:</span>
                  <Select value={groupByDate || 'none'} onValueChange={(v) => setGroupByDate(v === 'none' ? null : v)}>
                    <SelectTrigger className={`w-32 md:w-36 h-7 text-[10px] font-bold rounded-lg border transition-all ${
                      groupByDate
                        ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary/20'
                        : (isDark ? 'bg-secondary/50 border-border/60 text-muted-foreground hover:border-border' : 'bg-gray-50 border-gray-200 text-gray-500')
                    }`} data-testid="group-by-select"><SelectValue placeholder={t('all')} /></SelectTrigger>
                    <SelectContent className="z-[100] bg-popover border-border">
                      <SelectItem value="none">{lang === 'es' ? 'Sin agrupar' : 'No grouping'}</SelectItem>
                      {dateCols.map(dc => <SelectItem key={dc.key} value={dc.key}>{dc.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
      {/* Row for miscellaneous header items or future summary statistics */}
      <div className={`border-b px-2 md:px-4 py-2 relative z-40 ${isDark ? 'bg-[hsl(220,28%,10%)] border-border/60' : 'bg-white/60 border-gray-200'}`}>
        <div className="flex items-center gap-3 overflow-visible">
          {/* Quick Stats Summary */}
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full font-black ${isDark ? 'bg-blue-500/15 text-blue-300 border border-blue-500/25' : 'bg-blue-600/10 text-blue-700 border border-blue-400/30'}`}>
              <span className="opacity-70 text-[10px]">{t('total')}</span>
              <span className="font-barlow text-base">{orders.length}</span>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full font-black ${isDark ? 'bg-secondary/80 text-foreground border border-border' : 'bg-gray-100 text-gray-700 border border-gray-200'}`}>
              <span className="opacity-60 text-[10px]">{lang === 'es' ? 'QTY' : 'QTY'}</span>
              <span className="font-barlow text-base">
                {orders.reduce((sum, o) => sum + (Number(o.quantity) || 0), 0).toLocaleString()}
              </span>
            </div>
            {selectedOrders.length > 0 && (
              <div className="flex items-center gap-1.5 text-primary animate-pulse bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                <span className="font-bold">{t('selected')}:</span>
                <span className="font-barlow text-sm font-black">{selectedOrders.length}</span>
              </div>
            )}
            
            {/* Active Filters Visualization */}
            {Object.keys(filters).length > 0 && (
              <div className="flex items-center gap-2 border-l border-border pl-6 ml-2 overflow-x-auto scrollbar-hide max-w-md">
                <span className="text-muted-foreground font-bold flex-shrink-0">{lang === 'es' ? 'Filtros activos' : 'Active filters'}:</span>
                {Object.entries(filters).map(([k, v]) => {
                  if (!v) return null;
                  const col = columns.find(c => c.key === k) || { label: k };
                  return (
                    <div key={k} className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full border flex-shrink-0 text-[10px] font-bold ${isDark ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-blue-50 border-blue-200 text-blue-700'}`}>
                      <span className="opacity-70">{col.label}:</span>
                      <span>{Array.isArray(v) ? `${v.length}` : (typeof v === 'object' ? '...' : String(v))}</span>
                      <button onClick={() => setFilters(prev => { const n={...prev}; delete n[k]; return n; })} className="hover:text-destructive ml-0.5 opacity-60 hover:opacity-100 transition-all"><X className="w-2.5 h-2.5" /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          
          <div className="ml-auto flex items-center gap-4">
            {(Object.keys(filters).some(k => {
              const v = filters[k];
              if (!v) return false;
              if (Array.isArray(v)) return v.length > 0;
              if (typeof v === 'object' && (v.from || v.to)) return true;
              return true;
            }) || groupByDate) && <button onClick={() => { setFilters({}); setActiveViewName(null); setGroupByDate(null); }} className="text-[10px] font-black uppercase tracking-widest text-primary hover:text-primary/80 flex items-center gap-1 transition-all hover:scale-105 active:scale-95"><X className="w-3 h-3" /> {t('clear')}</button>}
          </div>
        </div>
      </div>

      {/* Floating Bulk Actions Bar */}
      {selectedOrders.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] w-[95%] md:w-auto animate-in fade-in slide-in-from-bottom-4 duration-300" data-testid="bulk-actions-bar">
          <div className={`flex flex-wrap items-center justify-center gap-3 md:gap-4 px-4 md:px-6 py-2.5 md:py-3 rounded-2xl md:rounded-full shadow-2xl border backdrop-blur-md ${isDark ? 'bg-secondary/90 border-primary/30 text-white' : 'bg-card/90 border-gray-200 text-gray-900 shadow-xl'}`}>
            <div className="flex items-center gap-2 border-r border-border pr-2 md:pr-4 flex-shrink-0">
              <span className="text-sm font-bold text-primary">{selectedOrders.length}</span>
              <span className="text-[10px] md:text-xs uppercase tracking-wider opacity-70 font-bold">{t('selected')}</span>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase font-bold opacity-50 hidden sm:inline">{t('move_to')}:</span>
                <DropdownMenu>
                  <DropdownMenuTrigger className={`min-w-[120px] md:w-48 h-9 md:h-10 flex items-center justify-between px-3 md:px-4 text-xs md:text-sm font-black rounded-lg md:rounded-xl border bg-secondary/50 border-border text-foreground hover:bg-secondary`} data-testid="bulk-move-select">
                    <span className="truncate mr-1 md:mr-2">{t('move_to')}</span>
                    <ChevronDown className="w-4 h-4 md:w-5 md:h-5 opacity-70" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className={`z-[200] min-w-[220px] shadow-2xl bg-popover border-border`}>
                    {allBoardsIncludingHidden.filter(b => b !== currentBoard && b !== 'PAPELERA DE RECICLAJE' && !b.startsWith('MAQUINA')).map(board => (
                      <DropdownMenuItem key={board} onClick={() => { handleBulkMove(selectedOrders, board); setSelectedOrders([]); }} className="font-black py-3.5 px-5 text-sm md:text-base tracking-tight">
                        {board}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator className="opacity-50" />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="flex items-center justify-between py-3.5 px-5 font-black text-primary cursor-pointer text-sm md:text-base">
                        <div className="flex items-center gap-2.5">
                          <Monitor className="w-5 h-5" /> 
                          <span>MAQUINAS</span>
                        </div>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="z-[301] min-w-[200px] shadow-2xl">
                        {allBoardsIncludingHidden.filter(b => b !== currentBoard && b !== 'PAPELERA DE RECICLAJE' && b.startsWith('MAQUINA')).map(board => (
                          <DropdownMenuItem key={board} onClick={() => { handleBulkMove(selectedOrders, board); setSelectedOrders([]); }} className="font-black py-3.5 px-5 text-sm md:text-base tracking-tight">
                            {board}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="h-6 w-px bg-border mx-1"></div>

              <div className="flex items-center gap-2">
                <button onClick={handleExportExcel} className="p-2 md:px-4 md:py-2 flex items-center gap-2 hover:bg-secondary transition-colors border-r border-border group" title={t('export_excel')}>
                  <FileDown className="w-5 h-5 text-green-500 group-hover:scale-110 transition-transform" />
                  <span className="hidden sm:inline text-xs font-bold">{t('export')} (visibles)</span>
                  <span className="sm:hidden text-[10px] font-bold">Visibles</span>
                </button>
              </div>

              <div className="h-6 w-px bg-border mx-1"></div>

              <button onClick={handleBulkDelete} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all ${isDark ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'bg-red-50 text-red-600 hover:bg-red-100'}`} title={t('trash')} data-testid="bulk-delete-btn">
                <Trash2 className="w-3.5 h-3.5" />
                <span>{t('trash')}</span>
              </button>
            </div>

            <div className="flex items-center gap-1 border-l border-border pl-4 ml-1">
              <button onClick={handleDeselectAll} className="p-1.5 hover:bg-secondary rounded-full text-muted-foreground hover:text-foreground transition-all" title={t('none')} data-testid="close-bulk-bar">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-auto relative">
        {loading ? <div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div> :
          (calendarMode && (currentBoard === 'SCHEDULING' || currentBoard === 'EJEMPLOS')) ? <CalendarView orders={orders} allOrders={allOrders} isDark={isDark} fetchOrders={fetchOrders} handleBulkMove={handleBulkMove} columns={columns} /> :
            readyCalendarMode && currentBoard === 'SCHEDULING' ? <CalendarView orders={readyOrders} allOrders={allOrders} isDark={isDark} fetchOrders={fetchOrders} handleBulkMove={handleBulkMove} columns={columns} label="Ready To Scheduled" /> :
              blanksTrackingMode && currentBoard === 'SCHEDULING' ? <BlanksTrackingView orders={blanksOrders} isDark={isDark} options={options} readOnly /> : (
                <>
                  <table className="text-sm border-collapse" style={{ minWidth: '100%' }}>
                    <thead className={`sticky top-0 z-30 transition-all duration-500 shadow-sm ${currentBoard === 'EJEMPLOS' ? 'ring-1 ring-zinc-500/50 shadow-[0_0_25px_-5px_rgba(161,161,170,0.3)]' : ''}`}>
                      <tr className={`${isDark ? 'bg-[hsl(220,30%,9%)]/95 border-b border-border/60' : 'bg-gray-50/95 border-b border-gray-200'} backdrop-blur-xl transition-colors duration-300 ${currentBoard === 'EJEMPLOS' ? (isDark ? 'bg-zinc-900/30 text-zinc-300' : 'bg-zinc-50 text-zinc-900') : ''}`}>
                        <th className={`py-4 px-2 sticky left-0 z-30 border-r border-border/10 ${isDark ? 'bg-[hsl(220,30%,9%)]' : 'bg-gray-50'}`} style={{ width: 48, minWidth: 48, maxWidth: 48 }}><input type="checkbox" checked={selectedOrders.length === orders.length && orders.length > 0} onChange={(e) => e.target.checked ? handleSelectAll() : handleDeselectAll()} className="w-4 h-4 rounded border-border bg-background transition-all" data-testid="select-all-checkbox" /></th>
                        <th className={`py-4 px-1 sticky left-[48px] z-30 border-r border-border/10 ${isDark ? 'bg-[hsl(220,30%,9%)]' : 'bg-gray-50'}`} style={{ width: 48, minWidth: 48, maxWidth: 48 }}></th>
                        
                        {/* Column 3: Permanent Identifier (Board for Master, Order for others) */}
                        {(() => {
                          const isReflection = currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS';
                          return (
                            <th className={`py-4 px-3 sticky left-[96px] z-30 text-left text-[10px] font-black tracking-[0.2em] uppercase border-r border-border/10 ${isDark ? 'bg-[hsl(220,30%,9%)] text-zinc-500/80 border-b border-border/60' : 'bg-gray-50 text-gray-400 border-b border-gray-200'}`} style={{ width: 160, minWidth: 160, maxWidth: 160 }}>
                              <div className="flex items-center justify-between gap-1">
                                <span className="truncate">{isReflection ? 'Board' : 'Orden'}</span>
                                <Popover open={openFilter === (isReflection ? '_board' : 'order_number')} onOpenChange={(val) => setOpenFilter(val ? (isReflection ? '_board' : 'order_number') : null)}>
                                  <PopoverTrigger className={`p-0.5 rounded transition-colors flex-shrink-0 ${filters[isReflection ? '_board' : 'order_number'] ? 'bg-primary/20 text-primary animate-pulse' : 'hover:bg-secondary text-muted-foreground'}`}>
                                    <ListFilter className="w-3.5 h-3.5" />
                                  </PopoverTrigger>
                                  <PopoverContent className="z-[300] min-w-[200px] bg-card border-border p-3 shadow-2xl">
                                    {isReflection ? (
                                      <>
                                        <div className="flex items-center justify-between mb-2">
                                          <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Board</span>
                                          {filters['_board'] && <button onClick={() => setFilters(prev => { const n={...prev}; delete n['_board']; return n; })} className="text-[10px] font-bold text-destructive hover:underline uppercase">Limpiar</button>}
                                        </div>
                                        <div className="max-h-60 overflow-y-auto mt-1 space-y-1">
                                          {[...new Set(unfilteredOrders.map(o => o.board).filter(Boolean))].sort().map(b => {
                                            const checked = (filters['_board'] || []).includes(b);
                                            return (
                                              <label key={b} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-secondary cursor-pointer transition-colors">
                                                <input
                                                  type="checkbox"
                                                  checked={checked}
                                                  onChange={() => {
                                                    setFilters(prev => {
                                                      const cur = prev['_board'] || [];
                                                      const next = cur.includes(b) ? cur.filter(x => x !== b) : [...cur, b];
                                                      return { ...prev, '_board': next.length > 0 ? next : undefined };
                                                    });
                                                  }}
                                                  className="w-4 h-4 rounded border-border accent-primary"
                                                />
                                                <span className={`text-xs ${checked ? 'font-bold text-primary' : 'text-foreground'}`}>{b}</span>
                                              </label>
                                            );
                                          })}
                                        </div>
                                      </>
                                    ) : (
                                      <>
                                        <div className="flex items-center justify-between mb-2">
                                          <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Orden</span>
                                          {filters['order_number'] && <button onClick={() => setFilters(prev => { const n={...prev}; delete n['order_number']; return n; })} className="text-[10px] font-bold text-destructive hover:underline uppercase">Limpiar</button>}
                                        </div>
                                        <input type="text" value={filters['order_number'] || ''} onChange={(e) => setFilters(prev => ({ ...prev, order_number: e.target.value || undefined }))} placeholder="Buscar orden..." className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary outline-none" autoFocus />
                                      </>
                                    )}
                                  </PopoverContent>
                                </Popover>
                              </div>
                            </th>
                          );
                        })()}

                        {/* Columns 4+: Draggable Scrollable Content (with buffer on first) */}
                        {visibleColumns.filter(c => (currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? true : c.key !== 'order_number').map((col, idx) => {
                          const isOrderNum = col.key === 'order_number';
                          const width = isOrderNum ? 120 : (columnWidths[col.key] || col.width);
                          const filterVal = filters[col.key];
                          const isSelect = col.type === 'select' || col.type === 'status' || (col.optionKey && options[col.optionKey]);
                          const isDate = col.type === 'date';

                          return (
                            <th key={col.key} className={`py-4 ${idx === 0 ? 'pl-6 pr-3' : 'px-3'} text-left text-[10px] font-black tracking-[0.2em] uppercase border-r border-border/5 shadow-sm ${isDark ? 'text-zinc-500/80' : 'text-gray-400'} ${draggedCol === col.key ? 'opacity-50' : ''}`} style={{ width: width, minWidth: width, maxWidth: 'none' }} data-testid={`column-header-${col.key}`} draggable onDragStart={() => handleColumnDragStart(col.key)} onDragOver={(e) => handleColumnDragOver(e, col.key)} onDragEnd={handleColumnDragEnd}>
                              <div className="flex items-center justify-between gap-1">
                                <div className="flex items-center gap-1.5 cursor-grab active:cursor-grabbing select-none overflow-hidden">
                                  {(currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') && <svg className="w-3.5 h-3.5 flex-shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0-6v6m18-6v6" /></svg>}
                                  <span className="truncate">{col.label}</span>
                                  {/* Filter Trigger Icon */}
                                  {/* Filter Trigger Icon */}
                                  <Popover open={openFilter === col.key} onOpenChange={(val) => setOpenFilter(val ? col.key : null)}>
                                    <PopoverTrigger className={`p-0.5 rounded transition-colors flex-shrink-0 ${filterVal ? 'bg-primary/20 text-primary animate-pulse' : 'hover:bg-secondary text-muted-foreground'}`} onClick={(e) => e.stopPropagation()}>
                                      <ListFilter className="w-3.5 h-3.5" />
                                    </PopoverTrigger>
                                    <PopoverContent className="z-[300] min-w-[200px] bg-card border-border p-3 shadow-2xl">
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{col.label}</span>
                                        {filterVal && <button onClick={() => setFilters(prev => { const n={...prev}; delete n[col.key]; return n; })} className="text-[10px] font-bold text-destructive hover:underline uppercase">Limpiar</button>}
                                      </div>
                                      
                                      {isSelect ? (
                                        <div className="max-h-60 overflow-y-auto mt-1 space-y-1">
                                          {getFilterOptions(col).map(opt => {
                                            const checked = Array.isArray(filterVal) ? filterVal.includes(opt) : filterVal === opt;
                                            return (
                                              <label key={opt} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-secondary cursor-pointer transition-colors">
                                                <input
                                                  type="checkbox"
                                                  checked={checked}
                                                  onChange={() => {
                                                    setFilters(prev => {
                                                      const cur = Array.isArray(prev[col.key]) ? [...prev[col.key]] : (prev[col.key] ? [prev[col.key]] : []);
                                                      const next = checked ? cur.filter(v => v !== opt) : [...cur, opt];
                                                      return { ...prev, [col.key]: next.length > 0 ? next : undefined };
                                                    });
                                                  }}
                                                  className="w-4 h-4 rounded border-border accent-primary"
                                                />
                                                <span className={`text-xs ${checked ? 'font-bold text-primary' : 'text-foreground'}`}>{opt}</span>
                                              </label>
                                            );
                                          })}
                                        </div>
                                      ) : isDate ? (
                                        <div className="space-y-3">
                                          <div className="space-y-1">
                                            <label className="text-[10px] uppercase font-bold opacity-60">Desde</label>
                                            <input type="date" value={filterVal?.from || ''} onChange={(e) => setFilters(prev => ({ ...prev, [col.key]: { ...(prev[col.key] || {}), from: e.target.value } }))} className="w-full h-8 px-2 text-xs bg-secondary/50 border border-border rounded" />
                                          </div>
                                          <div className="space-y-1">
                                            <label className="text-[10px] uppercase font-bold opacity-60">Hasta</label>
                                            <input type="date" value={filterVal?.to || ''} onChange={(e) => setFilters(prev => ({ ...prev, [col.key]: { ...(prev[col.key] || {}), to: e.target.value } }))} className="w-full h-8 px-2 text-xs bg-secondary/50 border border-border rounded" />
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="relative mt-1">
                                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                                          <input
                                            type="text"
                                            value={typeof filterVal === 'string' ? filterVal : ''}
                                            onChange={(e) => setFilters(prev => ({ ...prev, [col.key]: e.target.value || undefined }))}
                                            placeholder={`Buscar ${col.label.toLowerCase()}...`}
                                            className="w-full pl-8 pr-2 py-1.5 bg-secondary/50 border border-border rounded text-xs focus:ring-1 focus:ring-primary outline-none"
                                            autoFocus
                                          />
                                        </div>
                                      )}
                                    </PopoverContent>
                                  </Popover>
                                </div>
                                <div className="cursor-col-resize px-1 opacity-40 hover:opacity-100" onMouseDown={(e) => { e.stopPropagation(); const startX = e.clientX; const startWidth = columnWidths[col.key] || col.width; const onMouseMove = (ev) => { setColumnWidths(prev => ({ ...prev, [col.key]: Math.max(80, startWidth + (ev.clientX - startX)) })); }; const onMouseUp = () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp); }}><GripVertical className="w-4 h-4" /></div>
                              </div>
                            </th>
                          );
                        })}
                        <th className={`py-4 px-3 text-left text-[10px] font-black tracking-[0.2em] uppercase ${isDark ? 'text-zinc-500/80' : 'text-gray-400'}`} style={{ minWidth: 180 }} data-testid="column-header-restante">{t('restante')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const renderOrderRow = (order) => {
                          const sq = searchQuery.toLowerCase();
                          const getVal = (v) => {
                            if (!v) return "";
                            if (typeof v === 'object') return `${v.url || ""} ${v.desc || ""}`.toLowerCase();
                            return String(v).toLowerCase();
                          };
                          const isSearchMatch = searchQuery && (
                            getVal(order.order_number).includes(sq) ||
                            getVal(order.client).includes(sq) ||
                            getVal(order.store_po).includes(sq) ||
                            getVal(order.customer_po).includes(sq) ||
                            getVal(order.job_title_a).includes(sq) ||
                            getVal(order.job_title_b).includes(sq) ||
                            getVal(order.branding).includes(sq) ||
                            getVal(order.notes).includes(sq)
                          );
                          return (
                            <tr key={order.order_id} className={`border-b group relative z-10 transition-all duration-300 ${isDark ? 'bg-background border-border/20 hover:bg-secondary/40' : 'bg-white border-gray-100 hover:bg-primary/5'} ${selectedOrders.includes(order.order_id) ? (isDark ? '!bg-primary/10 border-l-[4px] border-l-primary' : '!bg-primary/5 border-l-[4px] border-l-primary shadow-sm') : 'border-l-[4px] border-l-transparent'} ${isSearchMatch ? '!bg-primary/10 ring-1 ring-inset ring-primary/40' : ''}`} data-testid={`order-row-${order.order_id}`}>
                              <td className={`py-4 px-2 sticky left-0 z-10 transition-colors border-r border-border/5 ${isSearchMatch ? 'bg-primary/10' : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-primary/5' : 'bg-primary/10') : (isDark ? 'bg-background group-hover:bg-transparent' : 'bg-background group-hover:bg-transparent')}`} style={{ width: 48, minWidth: 48, maxWidth: 48 }}><input type="checkbox" checked={selectedOrders.includes(order.order_id)} onChange={() => toggleOrderSelection(order.order_id)} className="w-4 h-4 rounded border-border transition-all" /></td>
              <td className={`py-4 px-1 sticky left-[48px] z-20 transition-colors border-r border-border/5 ${isSearchMatch ? 'bg-primary/10' : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-primary/5' : 'bg-primary/10') : (isDark ? 'bg-background group-hover:bg-transparent' : 'bg-background group-hover:bg-transparent')}`} style={{ width: 48, minWidth: 48, maxWidth: 48 }}><button onClick={() => setCommentsOrder(order)} className="p-1.5 rounded-lg transition-all hover:bg-secondary hover:scale-110 active:scale-95" title={t('comments')}><MessageSquare className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors" /></button></td>
                              
                              {/* Fixed Column 3 Data */}
                              {(() => {
                                const isMaster = currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS';
                                return (
                                  <td className={`py-4 px-3 sticky left-[96px] z-20 transition-colors border-r border-border/10 ${isSearchMatch ? 'bg-primary/10' : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-primary/5' : 'bg-primary/10') : (isDark ? 'bg-background group-hover:bg-transparent' : 'bg-background group-hover:bg-transparent')}`} style={{ width: 160, minWidth: 160, maxWidth: 160 }}>
                                    {isMaster ? (
                                      <span className="px-2.5 py-1 rounded text-xs font-bold" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666', color: '#fff' }}>{order.board}</span>
                                    ) : (
                                      <EditableCell 
                                        value={order.order_number} 
                                        field="order_number" 
                                        orderId={order.order_id} 
                                        onUpdate={handleCellUpdate} 
                                        type="text" 
                                        isDark={isDark} 
                                        className={`font-mono font-black ${isSearchMatch ? 'text-primary' : ''}`}
                                      />
                                    )}
                                  </td>
                                );
                              })()}

                              {/* Draggable Column Data */}
                              {visibleColumns.filter(c => (currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? true : c.key !== 'order_number').map((col, idx) => {
                                const isOrderNum = col.key === 'order_number';
                                const width = isOrderNum ? 120 : (columnWidths[col.key] || col.width);
                                return (
                                  <td key={col.key} className={`py-4 ${idx === 0 ? 'pl-9 pr-3' : 'px-3'} border-r border-border/5 transition-all`} style={{ width: width, minWidth: width, maxWidth: 'none' }}>
                                    {isOrderNum ? <span className={`font-mono font-medium truncate block ${isSearchMatch ? 'text-primary font-bold' : ''}`} title={order[col.key]}>{isSearchMatch ? <mark className="bg-yellow-300/60 text-foreground px-0.5 rounded">{order[col.key]}</mark> : order[col.key]}</span> : (
                                      <EditableCell value={order[col.key]} field={col.key} orderId={order.order_id} options={col.optionKey ? (options[col.optionKey] || col.statusOptions?.map(s => s.value)) : null} onUpdate={handleCellUpdate} type={col.type} isDark={isDark} allOrders={orders} columns={columns} readOnly={!canEditBoard} />
                                    )}
                                  </td>
                                );
                              })}
                              {(() => {
                                const ps = productionSummary[order.order_id]; const totalProduced = ps ? ps.total_produced : 0; const qty = order.quantity || 0; const remaining = Math.max(0, qty - totalProduced); const pct = qty > 0 ? Math.min(100, (totalProduced / qty) * 100) : 0; return (
                                  <td className="py-3 px-3" style={{ minWidth: 180 }} data-testid={`restante-${order.order_id}`}>{qty > 0 ? (<div className="space-y-1.5"><div className="flex justify-between text-[11px]"><span className="font-mono font-black text-foreground/80">{remaining}</span><span className={`font-mono font-black ${pct >= 100 ? 'text-green-500' : pct >= 50 ? 'text-zinc-500' : 'text-muted-foreground'}`}>{pct.toFixed(0)}%</span></div><div className="w-full h-1.5 bg-secondary/50 rounded-full overflow-hidden border border-border/10 shadow-inner"><div className={`h-full rounded-full transition-all duration-1000 ${pct >= 100 ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : pct >= 50 ? 'bg-zinc-500 shadow-[0_0_8px_rgba(161,161,170,0.4)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]'}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div></div>) : <span className="text-xs text-muted-foreground/50">—</span>}</td>
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
                        const colSpan = 3 + visibleColumns.length + ((currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? 1 : 0);
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
                              <td colSpan={colSpan} className={`py-2 px-4 font-roboto font-black text-sm uppercase tracking-wide ${isDark ? 'bg-primary/10 text-primary border-b border-primary/30' : 'bg-blue-50 text-blue-700 border-b border-blue-200'}`}>
                                <CalendarDays className="w-4 h-4 inline mr-2 -mt-0.5" />{dateLabelsMap[groupByDate] || groupByDate}: <span className="font-mono">{dateKey}</span> <span className="font-normal text-xs text-muted-foreground ml-2">({groupOrders.length})</span>
                              </td>
                            </tr>
                            {groupOrders.map(renderOrderRow)}
                          </React.Fragment>
                        ));
                      })()}
                    </tbody>
                  </table>
                  {orders.length === 0 && <div className="text-center py-12 text-muted-foreground">{t('no_orders')}</div>}
                </>
              )}
      </main>

      {/* Modals */}
      <NewOrderModal isOpen={showNewOrder} onClose={() => setShowNewOrder(false)} onCreate={(order) => { setOrders(prev => [order, ...prev]); }} options={options} columns={columns} />
      <CommentsModal order={commentsOrder} isOpen={!!commentsOrder} onClose={() => { setCommentsOrder(null); setHighlightedCommentId(null); }} currentUser={user} highlightedCommentId={highlightedCommentId} />
      <AutomationsModal isOpen={showAutomations} onClose={() => setShowAutomations(false)} options={options} columns={columns} dynamicBoards={activeBoards} />
      {isAdmin && <OptionsManagerModal isOpen={showOptionsManager} onClose={() => setShowOptionsManager(false)} options={options} onOptionsUpdate={fetchOptions} onColorsUpdate={(colors) => { Object.entries(colors).forEach(([k, v]) => { STATUS_COLORS[k] = v; }); fetchOrders(); }} />}
      {isAdmin && <OperatorsManagerModal isOpen={showOperators} onClose={() => setShowOperators(false)} />}
      {isAdmin && <FormFieldsManagerModal isOpen={showFormFields} onClose={() => setShowFormFields(false)} columns={columns} />}
      <AddColumnModal isOpen={showAddColumn} onClose={() => setShowAddColumn(false)} onAdd={handleAddColumn} existingColumns={columns} options={options} />
      <AnalyticsView isOpen={showAnalytics} onClose={() => setShowAnalytics(false)} allOrders={allOrders} options={options} />
      <ProductionModal isOpen={showProduction} onClose={() => setShowProduction(false)} orders={allOrders} onProductionUpdate={() => { fetchProductionSummary(); fetchOrders(); }} isAdmin={isAdmin} />
      <GanttView isOpen={showGantt} onClose={() => setShowGantt(false)} isDark={isDark} />
      <CapacityPlanModal isOpen={showCapacityPlan} onClose={() => setShowCapacityPlan(false)} />
      {showProductionScreen && <ProductionScreen onClose={() => setShowProductionScreen(false)} isDark={isDark} />}

      {/* Trash Modal */}
      <Dialog open={showTrash} onOpenChange={setShowTrash}>
        <DialogContent className="max-w-4xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col" data-testid="trash-modal">
          <DialogHeader><DialogTitle className="font-roboto text-xl uppercase tracking-wide flex items-center gap-3 text-glow-primary"><Trash2 className="w-5 h-5 text-destructive" /> {t('trash_title')} <span className="text-sm font-normal text-muted-foreground">({trashOrders.length})</span></DialogTitle></DialogHeader>
          <div className="flex-1 overflow-y-auto py-4">
            {trashLoading ? <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div> :
              trashOrders.length > 0 ? (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card"><tr className="border-b border-border"><th className="text-left py-2 px-3 font-roboto uppercase text-xs text-muted-foreground tracking-widest">{t('order')}</th><th className="text-left py-2 px-3 font-roboto uppercase text-xs text-muted-foreground tracking-widest">{t('client')}</th><th className="text-left py-2 px-3 font-roboto uppercase text-xs text-muted-foreground tracking-widest">{t('priority')}</th><th className="text-left py-2 px-3 font-roboto uppercase text-xs text-muted-foreground tracking-widest">{t('date_time')}</th><th className="text-right py-2 px-3 font-roboto uppercase text-xs text-muted-foreground tracking-widest">{t('actions')}</th></tr></thead>
                  <tbody>{trashOrders.map(order => (
                    <tr key={order.order_id} className="border-b border-border/50 hover:bg-secondary/30" data-testid={`trash-order-${order.order_id}`}>
                      <td className="py-2 px-3 font-mono text-foreground">{order.order_number}</td>
                      <td className="py-2 px-3 text-foreground">{order.client || '-'}</td>
                      <td className="py-2 px-3"><ColoredBadge value={order.priority} isDark={isDark} /></td>
                      <td className="py-2 px-3 text-muted-foreground text-xs font-mono">{order.updated_at ? new Date(order.updated_at).toLocaleString() : '-'}</td>
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
        <DialogContent className="max-w-6xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col p-0" data-testid="search-results-modal">
          <DialogHeader className="p-6 pb-2">
            <DialogTitle className="font-roboto text-2xl font-black uppercase tracking-tight flex items-center gap-3 text-glow-primary">
              <Search className="w-6 h-6 text-primary" /> Resultados de busqueda <span className="text-sm font-mono font-normal text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/50 ml-2">({searchResults?.length || 0})</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto px-6 pb-6">
            <div className="rounded-xl border border-border/50 overflow-x-auto bg-background/50 shadow-inner">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-secondary/95 backdrop-blur-md z-20">
                  <tr className="border-b border-border/50">
                    <th className="text-left py-3 px-4 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 min-w-[120px] sticky left-0 bg-secondary/95 z-30 shadow-[4px_0_10px_rgba(0,0,0,0.1)]">{t('order')}</th>
                    <th className="text-left py-3 px-4 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 min-w-[140px] border-l border-border/10">Tablero</th>
                    {columns.filter(c => c.key !== 'order_number').map(col => (
                      <th key={col.key} className="text-left py-3 px-4 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 border-l border-border/10" style={{ minWidth: col.width || 150 }}>{col.label}</th>
                    ))}
                    <th className="text-center py-3 px-4 font-black uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 border-l border-border/10 min-w-[80px] sticky right-0 bg-secondary/95 z-30 shadow-[-4px_0_10px_rgba(0,0,0,0.1)]">Accion</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults?.map(order => (
                    <tr key={order.order_id}
                      className="border-b border-border/20 hover:bg-primary/5 transition-all duration-200 group"
                      data-testid={`search-result-${order.order_id}`}>
                      <td className="py-3 px-4 sticky left-0 bg-background/95 z-10 group-hover:bg-primary/10 shadow-[4px_0_10px_rgba(0,0,0,0.05)] transition-colors">
                        <EditableCell 
                          value={order.order_number} 
                          field="order_number" 
                          orderId={order.order_id} 
                          onUpdate={(id, f, v) => { 
                            handleCellUpdate(id, f, v); 
                            setSearchResults(prev => prev.map(o => o.order_id === id ? { ...o, [f]: v } : o)); 
                          }} 
                          type="text" 
                          isDark={isDark}
                          className="font-mono font-black text-primary text-base"
                        />
                      </td>
                      <td className="py-3 px-4 border-l border-border/5">
                        <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider shadow-sm border border-white/10" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666', color: '#fff' }}>{order.board}</span>
                      </td>
                      {columns.filter(c => c.key !== 'order_number').map(col => (
                        <td key={col.key} className="py-3 px-4 border-l border-border/5">
                          <EditableCell 
                            value={order[col.key]} 
                            field={col.key} 
                            orderId={order.order_id} 
                            options={col.optionKey ? (options[col.optionKey] || col.statusOptions?.map(s => s.value)) : null} 
                            onUpdate={(id, f, v) => { 
                              handleCellUpdate(id, f, v); 
                              setSearchResults(prev => prev.map(o => o.order_id === id ? { ...o, [f]: v } : o)); 
                            }} 
                            type={col.type} 
                            isDark={isDark} 
                            allOrders={searchResults} 
                            columns={columns}
                          />
                        </td>
                      ))}
                      <td className="py-3 px-4 text-center sticky right-0 bg-background/95 z-10 group-hover:bg-primary/10 shadow-[-4px_0_10px_rgba(0,0,0,0.05)] transition-colors">
                        <button 
                          onClick={() => { setCurrentBoard(order.board); setSearchResults(null); setSearchQuery(order.order_number || ''); toast.success(`${order.order_number} → ${order.board}`); }}
                          className="p-2 rounded-xl bg-primary/10 text-primary hover:bg-primary hover:text-white transition-all shadow-sm glow-primary-hover"
                          title="Ir al tablero"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
