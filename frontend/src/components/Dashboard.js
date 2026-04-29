import React, { useState, useCallback, useEffect, useRef } from "react";
import { useAuth } from "../App";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import { useTheme } from "../contexts/ThemeContext";
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
  DropdownMenuPortal,
} from "./ui/dropdown-menu";
import { ScrollArea } from "./ui/scroll-area";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
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
import { FormFieldsManagerModal } from "./dashboard/FormFieldsManagerModal";
import OrderHistoryModal from "./OrderHistoryModal";
import { SystemGuideModal } from "./dashboard/SystemGuideModal";
import { ImportExcelModal } from "./dashboard/ImportExcelModal";
// Existing top-level components
import AnalyticsView from "./AnalyticsView";
import CalendarView from "./CalendarView";
import BlanksTrackingView from "./BlanksTrackingView";
import ProductionModal from "./ProductionModal";
import GanttView from "./GanttView";
import CapacityPlanModal from "./CapacityPlanModal";
import ProductionScreen from "./ProductionScreen";
import DynamicLandscape from "./dashboard/DynamicLandscape";
import Sidebar from "./dashboard/Sidebar";
import CommandPalette from "./dashboard/CommandPalette";

// Shared constants and hooks
import { cn } from "../lib/utils";
import { BOARDS, BOARD_COLORS, FILTER_COLUMNS, STATUS_COLORS, getBoardStyle, evaluateFormula, API } from "../lib/constants";
import { useOrders } from "../hooks/useOrders";

const Dashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { t, lang, toggleLang } = useLang();

  // Helper functions for rendering detail values safely
  const renderDetailValue = (val) => {
    if (val === null || val === undefined || val === '') return '—';
    if (typeof val === 'boolean') return val ? 'SÍ' : 'NO';
    // Let React render valid React elements (like links, spans, etc) directly
    if (React.isValidElement(val)) return val;
    if (typeof val === 'object') {
        // Handle {url, desc} objects as clickable links
        if (val.url && val.desc) {
          return (
            <a href={val.url} target="_blank" rel="noopener noreferrer"
               style={{ color: '#60a5fa', textDecoration: 'underline', fontWeight: 700 }}>
              {val.desc}
            </a>
          );
        }
        if (val.url) return <a href={val.url} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'underline' }}>{val.url}</a>;
        if (val.desc || val.text || val.value || val.name) return String(val.desc || val.text || val.value || val.name);
        try { return JSON.stringify(val); } catch { return '[Object]'; }
    }
    return val;
  };


  // Board & filter state
  const [currentBoard, setCurrentBoard] = useState("SCHEDULING");
  const [boardFilters, setBoardFilters] = useState({});
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [openFilter, setOpenFilter] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Theme from shared context (synced with CEODashboard and WMS)
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  // Column visibility & ordering
  const [hiddenColumns, setHiddenColumns] = useState({});
  const [boardColumnOrders, setBoardColumnOrders] = useState({});
  const [showColumnManager, setShowColumnManager] = useState(false);
  const [draggedCol, setDraggedCol] = useState(null);

  // Modal visibility
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [commentsOrder, setCommentsOrder] = useState(null);
  const [historyOrder, setHistoryOrder] = useState(null);
  const [highlightedOrderId, setHighlightedOrderId] = useState(null);
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
  const [showFormFields, setShowFormFields] = useState(false);
  const [showImportExcel, setShowImportExcel] = useState(false);
  const [showBoardVisibility, setShowBoardVisibility] = useState(false);
  const [savedViews, setSavedViews] = useState({});
  const [activeViewName, setActiveViewName] = useState(null);
  const activeViewIdRef = useRef(null);
  const viewApplyingRef = useRef(false);
  const [trashOrders, setTrashOrders] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [groupByDate, setGroupByDate] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState(null);
  const [searchResults, setSearchResults] = useState(null);
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [deleteBoardConfirm, setDeleteBoardConfirm] = useState(null); // null | { step: 1|2, name: string }
  const [showMachinesVisibility, setShowMachinesVisibility] = useState(false);
  const [highlightedCommentId, setHighlightedCommentId] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [trashCount, setTrashCount] = useState(0);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [detailsOrder, setDetailsOrder] = useState(null);
  const [isEditingOrderNo, setIsEditingOrderNo] = useState(false);
  const [tempOrderNo, setTempOrderNo] = useState('');
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  useEffect(() => {
    if (!highlightedOrderId) return;
    const attemptScroll = (attempts = 0) => {
      const row = document.querySelector(`[data-order-id="${highlightedOrderId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (attempts < 8) {
        setTimeout(() => attemptScroll(attempts + 1), 200);
      }
    };
    attemptScroll();
    const timer = setTimeout(() => setHighlightedOrderId(null), 3000);
    return () => clearTimeout(timer);
  }, [highlightedOrderId]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        console.log('Command Palette triggered');
        setShowCommandPalette(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const timeOfDay = (() => {
    const hour = currentTime.getHours();
    if (hour >= 6 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 19) return 'afternoon';
    return 'night';
  })();

  // Core data hook
  const {
    orders, setOrders, allOrders, unfilteredOrders, loading, operationLoading, setOperationLoading,
    options, productionSummary, notifications, unreadCount, markNotificationsRead, markNotificationRead,
    automationRunning, automationMessage, columns, columnWidths, setColumnWidths,
    fetchOrders, fetchAllOrders, fetchOptions, fetchProductionSummary,
    handleCellUpdate, handleBulkMove, handleQuickUndo, handleGlobalSearch,
    handleAddColumn, handleDeleteColumn, saveCustomColumns,
    dynamicBoards, hiddenBoards, createBoard, deleteBoard, fetchBoards, toggleBoardVisibility,
    groupConfig, fetchGroups
  } = useOrders(currentBoard, boardFilters);

  const activeBoards = (dynamicBoards.length > 0 ? dynamicBoards : BOARDS).filter(b => !hiddenBoards.includes(b));
  const allBoardsIncludingHidden = dynamicBoards.length > 0 ? dynamicBoards : BOARDS;

  const isAdmin = user?.role === 'admin';

  const handleBulkMoveWithLockCheck = async (orderIds, targetBoard, onComplete) => {
    const lockedOrders = orders.filter(o => orderIds.includes(o.order_id) && o.locked_by_qc);
    if (lockedOrders.length > 0) {
      if (!isAdmin) {
        toast.error(`🔒 ${lockedOrders.length} orden(es) bloqueada(s) por QC: ${lockedOrders.map(o => o.order_number).join(', ')}`);
        return;
      }
      const nums = lockedOrders.map(o => o.order_number).join(', ');
      const ok = window.confirm(`⚠️ ADMIN: ${lockedOrders.length} orden(es) bloqueada(s) por QC (${nums}).\n\n¿Confirmas moverlas de todas formas?`);
      if (!ok) return;
    }
    await handleBulkMove(orderIds, targetBoard);
    if (onComplete) onComplete();
  };

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
  
  // Specific notification metrics
  const unreadMentions = notifications.filter(n => n.type === 'mention' && !n.read).length;

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

  // Close notifications on outside click
  useEffect(() => {
    if (!showNotifications) return;
    const handler = (e) => { 
      if (!e.target.closest('[data-testid="notifications-dropdown"]') && !e.target.closest('[data-testid="notifications-btn"]')) {
        setShowNotifications(false); 
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNotifications]);

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

  // Reset collapsed groups when board or grouping changes
  useEffect(() => { setCollapsedGroups({}); }, [currentBoard, groupByDate]);

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
  }, [currentBoard]); // eslint-disable-line react-hooks/exhaustive-deps

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
    try { const res = await fetch(`${API}/config/saved-views`, { credentials: 'include' }); if (res.ok) { const data = await res.json(); const grouped = {}; data.forEach(v => { if (!grouped[v.board]) grouped[v.board] = []; grouped[v.board].push(v); }); setSavedViews(grouped); } } catch { /* silent */ }
  }, []);
  useState(() => { fetchSavedViews(); });

  const handleSaveView = async () => {
    if (!newViewName.trim()) return;
    try {
      const res = await fetch(`${API}/config/saved-views`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: newViewName.trim(), board: currentBoard, filters, pinned: false, hidden_columns: hiddenColumns[currentBoard] || [], column_order: boardColumnOrders[currentBoard] || [], group_by_date: groupByDate }) });
      if (res.ok) {
        const newView = await res.json();
        toast.success(`${t('save_view')}: "${newViewName}"`);
        setNewViewName('');
        setShowSaveView(false);
        fetchSavedViews();
        handleApplyView(newView);
      } else {
        toast.error(`${t('save_view_err')} (Error ${res.status})`);
        setNewViewName('');
        setShowSaveView(false);
      }
    } catch { 
      toast.error(t('save_view_err')); 
      setShowSaveView(false);
    }
  };
  const handleApplyView = (view) => {
    viewApplyingRef.current = true;
    if (view === null) {
      setFilters({});
      setActiveViewName(null);
      activeViewIdRef.current = null;
    } else {
      setFilters(view.filters || {});
      setActiveViewName(view.name);
      activeViewIdRef.current = view.view_id;
      if (view.hidden_columns !== undefined)
        setHiddenColumns(prev => ({ ...prev, [currentBoard]: view.hidden_columns || [] }));
      if (view.column_order?.length)
        setBoardColumnOrders(prev => ({ ...prev, [currentBoard]: view.column_order }));
      if (view.group_by_date !== undefined)
        setGroupByDate(view.group_by_date || null);
    }
  };
  const handleTogglePinView = async (viewId, pinned) => { try { await fetch(`${API}/config/saved-views/${viewId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ pinned: !pinned }) }); fetchSavedViews(); } catch { /* silent */ } };
  const handleDeleteView = async (viewId) => { try { await fetch(`${API}/config/saved-views/${viewId}`, { method: 'DELETE', credentials: 'include' }); fetchSavedViews(); toast.success(t('view_deleted')); } catch { /* silent */ } };

  // Auto-update saved view when user manually modifies filters while a view is active
  const viewAutoSaveRef = useRef(null);
  useEffect(() => {
    if (viewApplyingRef.current) { viewApplyingRef.current = false; return; }
    const viewId = activeViewIdRef.current;
    if (!viewId || !activeViewName) return;
    if (viewAutoSaveRef.current) clearTimeout(viewAutoSaveRef.current);
    viewAutoSaveRef.current = setTimeout(() => {
      fetch(`${API}/config/saved-views/${viewId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          filters,
          hidden_columns: hiddenColumns[currentBoard] || [],
          column_order: boardColumnOrders[currentBoard] || [],
          group_by_date: groupByDate,
        })
      }).then(() => fetchSavedViews()).catch(() => { });
    }, 1200);
    return () => { if (viewAutoSaveRef.current) clearTimeout(viewAutoSaveRef.current); };
  }, [filters, hiddenColumns, boardColumnOrders, groupByDate, activeViewName, fetchSavedViews]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset active view when board changes to prevent overwriting
  useEffect(() => {
    viewApplyingRef.current = true;
    setActiveViewName(null);
    activeViewIdRef.current = null;
  }, [currentBoard]);

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

  const handleToggleColumnVisibility = async (colKey) => {
    setHiddenColumns(prev => {
      const current = prev[currentBoard] || [];
      const next = current.includes(colKey) ? current.filter(x => x !== colKey) : [...current, colKey];
      const newHidden = { ...prev, [currentBoard]: next };
      
      // Auto-save layout
      fetch(`${API}/config/board-layout/${currentBoard}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ hidden_columns: next, column_order: boardColumnOrders[currentBoard] || [] })
      }).catch(err => console.error('Error saving layout:', err));
      
      return newHidden;
    });
  };

  const handleUpdateColumnOrder = (newOrder) => {
    setBoardColumnOrders(prev => {
      const updated = { ...prev, [currentBoard]: newOrder };
      
      // Auto-save layout
      fetch(`${API}/config/board-layout/${currentBoard}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ hidden_columns: hiddenColumns[currentBoard] || [], column_order: newOrder })
      }).catch(err => console.error('Error saving layout:', err));
      
      return updated;
    });
  };

  const handleCreateBoard = async () => {
    if (!newBoardName.trim()) return;
    const ok = await createBoard(newBoardName.trim().toUpperCase());
    if (ok) {
      setShowNewBoard(false);
      setNewBoardName('');
      fetchBoards();
    }
  };

  // Trash
  const fetchTrashOrders = async () => {
    setTrashLoading(true);
    try { 
      const res = await fetch(`${API}/orders?board=PAPELERA DE RECICLAJE`, { credentials: 'include' }); 
      if (res.ok) {
        const data = await res.json();
        setTrashOrders(data);
        setTrashCount(data.length);
      }
    } catch { toast.error(t('trash_load_err')); } finally { setTrashLoading(false); }
  };

  const fetchTrashCount = useCallback(async () => {
    try {
      const res = await fetch(`${API}/orders/board-counts`, { credentials: 'include' });
      if (res.ok) {
        const counts = await res.json();
        setTrashCount(counts["PAPELERA DE RECICLAJE"] || 0);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchTrashCount();
  }, [fetchTrashCount, orders]); // Refresh trash count when orders change (e.g. after deletion)
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

  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const bulkDeleteTimerRef = useRef(null);
  const handleBulkDelete = async () => {
    if (selectedOrders.length === 0) return;
    if (!bulkDeleteConfirm) {
      setBulkDeleteConfirm(true);
      bulkDeleteTimerRef.current = setTimeout(() => setBulkDeleteConfirm(false), 3000);
      return;
    }
    clearTimeout(bulkDeleteTimerRef.current);
    setBulkDeleteConfirm(false);
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

  const renderTableRows = () => {
    const renderOrderRow = (order) => {
      const sq = searchQuery.toLowerCase();
      const getVal = (v) => {
        if (!v) return "";
        if (typeof v === 'object') return `${v.url || ""} ${v.desc || ""}`.toLowerCase();
        return String(v).trim().toLowerCase();
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
        <tr key={order.order_id} data-order-id={order.order_id} data-testid={`order-row-${order.order_id}`} className={`border-b group relative z-10 transition-all duration-300 ${isDark ? 'bg-background border-border/20 hover:bg-secondary/40' : 'bg-white border-gray-100 hover:bg-primary/5'} ${selectedOrders.includes(order.order_id) ? (isDark ? '!bg-primary/10 border-l-[4px] border-l-primary' : '!bg-primary/5 border-l-[4px] border-l-primary shadow-sm') : 'border-l-[4px] border-l-transparent'} ${isSearchMatch ? '!bg-primary/10 ring-1 ring-inset ring-primary/40' : ''} ${highlightedOrderId === order.order_id ? 'order-row-flash' : ''}`}>
          <td className={`py-4 px-2 sticky left-0 z-10 transition-colors border-r border-border/5 ${isSearchMatch ? (isDark ? 'bg-[hsl(220,70%,22%)]' : 'bg-blue-50') : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-[hsl(220,70%,18%)]' : 'bg-blue-50') : (isDark ? 'bg-[hsl(220,30%,9%)] group-hover:bg-[hsl(220,30%,12%)]' : 'bg-white group-hover:bg-gray-50')}`} style={{ width: 48, minWidth: 48, maxWidth: 48 }}>
            <input type="checkbox" checked={selectedOrders.includes(order.order_id)} onChange={() => toggleOrderSelection(order.order_id)} className="w-4 h-4 rounded border-border transition-all" />
          </td>
          <td className={`py-4 px-1 sticky left-[48px] z-20 transition-colors border-r border-border/5 ${isSearchMatch ? (isDark ? 'bg-[hsl(220,70%,22%)]' : 'bg-blue-50') : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-[hsl(220,70%,18%)]' : 'bg-blue-50') : (isDark ? 'bg-[hsl(220,30%,9%)] group-hover:bg-[hsl(220,30%,12%)]' : 'bg-white group-hover:bg-gray-50')}`} style={{ width: 48, minWidth: 48, maxWidth: 48 }}>
            <div className="flex flex-col gap-1 items-center">
              <button onClick={() => setCommentsOrder(order)} className="p-1 rounded-lg transition-all hover:bg-secondary hover:scale-110 active:scale-95 text-muted-foreground hover:text-primary" title={t('comments')}><MessageSquare className="w-3 h-3" /></button>
              {isAdmin && (
                <button onClick={() => setHistoryOrder(order)} className="p-1 rounded-lg transition-all hover:bg-secondary hover:scale-110 active:scale-95 text-muted-foreground hover:text-primary" title="Historial Extendido"><ClipboardList className="w-3 h-3" /></button>
              )}
            </div>
          </td>
          
          {/* Fixed Column 3 Data */}
          {(() => {
            const isMaster = currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS';
            return (
              <td className={`py-4 px-3 sticky left-[96px] z-20 transition-colors border-r border-border/10 cursor-pointer ${isSearchMatch ? (isDark ? 'bg-[hsl(220,70%,22%)]' : 'bg-blue-50') : selectedOrders.includes(order.order_id) ? (isDark ? 'bg-[hsl(220,70%,18%)]' : 'bg-blue-50') : (isDark ? 'bg-[hsl(220,30%,9%)] group-hover:bg-[hsl(220,30%,12%)]' : 'bg-white group-hover:bg-gray-50')}`} 
                  style={{ width: 160, minWidth: 160, maxWidth: 160 }}
                  onClick={() => setDetailsOrder(order)}
              >
                {isMaster ? (
                  <span className="px-2.5 py-1 rounded-sm text-[10px] font-bold uppercase tracking-tighter" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666', color: '#fff' }}>{order.board}</span>
                ) : (
                  <span className="font-black text-xl tracking-tight group-hover:text-royal transition-colors whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-1">
                    {order.locked_by_qc && <span title="Bloqueado por QC" className="text-red-500 flex-shrink-0">🔒</span>}
                    {order.order_number}
                  </span>
                )}
              </td>
            );
          })()}

          {/* Draggable Column Data */}
          {visibleColumns.filter(c => (currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? true : c.key !== 'order_number').map((col, idx) => {
            const isOrderNum = col.key === 'order_number';
            const width = isOrderNum ? 160 : (columnWidths[col.key] || col.width);
            return (
              <td key={col.key} className={`py-4 ${idx === 0 ? 'pl-9 pr-3' : 'px-3'} border-r border-border/5 transition-all`} style={{ width: width, minWidth: width, maxWidth: 'none' }}>
                {isOrderNum ? <span className={`font-mono font-black text-xl truncate block ${isSearchMatch ? 'text-primary' : ''}`} title={order[col.key]}>{isSearchMatch ? <mark className="bg-yellow-300/60 text-foreground px-0.5 rounded">{order[col.key]}</mark> : order[col.key]}</span> : (
                  <EditableCell value={order[col.key]} field={col.key} orderId={order.order_id} options={col.optionKey ? (options[col.optionKey] || col.statusOptions?.map(s => s.value)) : null} groupConfig={groupConfig} onUpdate={handleCellUpdate} type={col.type} isDark={isDark} allOrders={orders} columns={columns} readOnly={!canEditBoard} />
                )}
              </td>
            );
          })}
          {(() => {
            const ps = productionSummary[order.order_id]; const totalProduced = ps ? ps.total_produced : 0; const qty = order.quantity || 0; const remaining = Math.max(0, qty - totalProduced); const pct = qty > 0 ? Math.min(100, (totalProduced / qty) * 100) : 0; return (
              <td className="py-3 px-3" style={{ minWidth: 180 }} data-testid={`restante-${order.order_id}`}>{qty > 0 ? (<div className="space-y-1.5"><div className="flex justify-between text-[11px]"><span className="font-mono font-bold text-foreground/80">{remaining}</span><span className={`font-mono font-bold ${pct >= 100 ? 'text-green-500' : pct >= 50 ? 'text-zinc-500' : 'text-muted-foreground'}`}>{pct.toFixed(0)}%</span></div><div className="w-full h-1.5 bg-secondary/50 rounded-full overflow-hidden border border-border/10 shadow-inner"><div className={`h-full rounded-full transition-all duration-1000 ${pct >= 100 ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : pct >= 50 ? 'bg-zinc-500 shadow-[0_0_8px_rgba(161,161,170,0.4)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]'}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div></div>) : <span className="text-xs text-muted-foreground/50">—</span>}</td>
            );
          })()}
        </tr>
      );
    };

    if (!groupByDate) return orders.map(renderOrderRow);
    const groups = {};
    const isDateField = groupByDate === 'cancel_date' || columns.find(c => c.key === groupByDate)?.type === 'date';
    const groupLabelMap = {
      cancel_date: 'Cancel Date',
      client: lang === 'es' ? 'Cliente' : 'Client',
      priority: lang === 'es' ? 'Prioridad' : 'Priority',
    };
    const noValueLabel = isDateField ? (lang === 'es' ? 'Sin fecha' : 'No date') : (lang === 'es' ? 'Sin asignar' : 'None');
    orders.forEach(o => {
      const raw = o[groupByDate];
      const groupKey = isDateField
        ? (raw ? new Date(raw).toLocaleDateString() : noValueLabel)
        : (raw || noValueLabel);
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(o);
    });
    const colSpan = 3 + visibleColumns.length + ((currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? 1 : 0);
    const sortedEntries = Object.entries(groups).sort(([a], [b]) => {
      if (a === noValueLabel) return 1;
      if (b === noValueLabel) return -1;
      if (isDateField) { const da = new Date(a), db = new Date(b); return da - db; }
      return a.localeCompare(b);
    });
    
    return sortedEntries.map(([dateKey, groupOrders]) => {
      const isCollapsed = !!collapsedGroups[dateKey];
      return (
        <React.Fragment key={dateKey}>
          <tr data-testid={`date-group-${dateKey}`}>
            <td colSpan={colSpan} className={`py-0 px-0 ${isDark ? 'bg-primary/10 border-b border-primary/30' : 'bg-blue-50 border-b border-blue-200'}`}>
              <button
                onClick={() => setCollapsedGroups(prev => ({ ...prev, [dateKey]: !prev[dateKey] }))}
                className={`w-full flex items-center gap-2 py-2 px-4 text-left font-roboto font-bold text-sm uppercase tracking-wide transition-colors ${isDark ? 'text-primary hover:bg-primary/20' : 'text-blue-700 hover:bg-blue-100'}`}
              >
                <ChevronDown className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`} />
                <CalendarDays className="w-4 h-4 flex-shrink-0 -mt-0.5" />
                {groupLabelMap[groupByDate] || groupByDate}: <span className="font-mono ml-1">{dateKey}</span>
                <span className="font-normal text-xs text-muted-foreground ml-1">({groupOrders.length})</span>
              </button>
            </td>
          </tr>
          {!isCollapsed && groupOrders.map(renderOrderRow)}
        </React.Fragment>
      );
    });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* ENTERPRISE SIDEBAR */}
      <Sidebar 
        isCollapsed={isSidebarCollapsed}
        setIsCollapsed={setIsSidebarCollapsed}
        currentBoard={currentBoard}
        setCurrentBoard={setCurrentBoard}
        boards={activeBoards}
        trashCount={trashCount}
        onShowTrash={() => { setShowTrash(true); fetchTrashOrders(); }}
        onShowAutomations={() => setShowAutomations(true)}
        onShowAnalytics={() => { setShowAnalytics(true); fetchAllOrders(); }}
        isAdmin={isAdmin}
        navigate={navigate}
        isDark={isDark}
      />

      {/* MAIN CONTENT AREA */}
      <div className={`relative flex-1 flex flex-col overflow-hidden transition-colors duration-300`}>
        <Toaster position="bottom-right" theme={isDark ? "dark" : "light"} />
        <LoadingOverlay isLoading={operationLoading} message={t('processing')} />

      {automationRunning && (
        <div className="fixed bottom-6 right-6 z-[200] flex items-center gap-3 bg-primary text-primary-foreground px-5 py-3 rounded-lg shadow-2xl animate-pulse" data-testid="automation-running-indicator">
          <Loader2 className="w-5 h-5 animate-spin" />
          <div><div className="text-sm font-bold">Ejecutando automatizacion...</div><div className="text-xs opacity-80">{automationMessage}</div></div>
        </div>
      )}


      {/* Header - Cleaned up version */}
      <header className={`h-16 px-4 flex items-center justify-between z-40 border-b ${isDark ? 'bg-navy-dark border-white/5 shadow-lg' : 'bg-white border-gray-200 shadow-sm'}`}>
        <div className="flex items-center gap-4 flex-1">
          <div className="flex items-center gap-3 max-w-md w-full px-4 py-1.5 rounded-full border border-border/60 bg-muted/20 hover:bg-muted/40 focus-within:bg-card focus-within:border-royal/60 focus-within:shadow-sm transition-all group">
            <Search className="w-4 h-4 text-muted-foreground group-focus-within:text-royal transition-colors" />
            <input 
              type="text" 
              value={searchQuery} 
              onChange={(e) => setSearchQuery(e.target.value)} 
              onKeyDown={async (e) => { 
                if (e.key === 'Enter') { 
                  const results = await handleGlobalSearch(searchQuery, setCurrentBoard); 
                  if (results === '__GUIDE__') { setShowGuide(true); setSearchQuery(''); } 
                  else if (results) setSearchResults(results); 
                } 
              }} 
              placeholder={t('search_placeholder')} 
              className="w-full bg-transparent border-none text-sm outline-none focus:outline-none focus:ring-0 placeholder:text-muted-foreground/50 transition-all font-medium py-1"
            />
          </div>
        </div>

        {unreadMentions > 0 && (() => {
          const BALLOON_COLORS = ['bg-royal', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-purple-500', 'bg-cyan-500'];
          const mentionNotifs = notifications.filter(n => n.type === 'mention' && !n.read).slice(0, 6);
          return (
            <div className="self-stretch flex items-start mx-2">
              <div className="flex items-start gap-1.5 px-2 h-full">
                {mentionNotifs.map((n, i) => (
                  <div
                    key={n.notification_id || i}
                    className="flex flex-col items-center group cursor-pointer"
                    title={n.message}
                    onClick={(e) => {
                      e.stopPropagation();
                      markNotificationRead(n.notification_id || n.id);
                      const targetOrder = allOrders.find(o => o.order_id === n.order_id);
                      if (targetOrder) {
                        setHighlightedCommentId(n.comment_id || null);
                        setCommentsOrder(targetOrder);
                      }
                    }}
                  >
                    <div className={`w-7 h-7 rounded-full ${BALLOON_COLORS[i % BALLOON_COLORS.length]} shadow-md group-hover:scale-110 transition-transform flex items-center justify-center text-white font-black text-sm select-none`}>
                      @
                    </div>
                    <div className="w-px h-4 bg-foreground/30" />
                    <div className="w-2 h-1 rounded-b-full bg-foreground/20" />
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="flex items-center gap-4">
          {/* Quick Actions */}
          <div className="flex items-center gap-1">
            <button onClick={toggleTheme} className="p-2 rounded hover:bg-muted/50 transition-all" title={isDark ? t('light_mode') : t('dark_mode')}>
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button onClick={() => window.location.href = '/wms'} title="WMS" className="p-2 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-all"><Warehouse className="w-4 h-4" /></button>
            <button onClick={toggleLang} className="p-2 rounded hover:bg-muted/50 text-[10px] font-bold flex items-center gap-1">
              <Languages className="w-4 h-4" /> {lang === 'es' ? 'EN' : 'ES'}
            </button>
            <div className="relative">
              <button
                data-testid="notifications-btn"
                onClick={() => { setShowNotifications(!showNotifications); if (!showNotifications && unreadCount > 0) markNotificationsRead(); }}
                className={cn("p-2 rounded hover:bg-muted/50 relative transition-colors", showNotifications && "bg-muted")}
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-royal rounded-full border-2 border-background" />}
              </button>
              {showNotifications && (
                <div data-testid="notifications-dropdown" className={cn("absolute top-12 right-0 w-80 md:w-96 border rounded-sm shadow-2xl z-[500] animate-in slide-in-from-top-2 overflow-hidden", isDark ? "bg-card border-white/10" : "bg-white border-border")}>
                  <div className="px-4 py-3 border-b flex items-center justify-between bg-muted/20">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-foreground">Menciones</span>
                    {unreadCount > 0 && <span className="text-[9px] bg-royal text-white px-2 py-0.5 rounded font-bold">{unreadCount} Nuevas</span>}
                  </div>
                  <ScrollArea className="max-h-[350px]">
                    {(!notifications || notifications.length === 0) ? (
                      <div className="p-8 flex flex-col items-center justify-center gap-2">
                        <Bell className="w-8 h-8 text-muted-foreground/20" />
                        <span className="text-xs text-muted-foreground font-bold uppercase tracking-tight">Sin notificaciones</span>
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        {notifications.map((n, i) => (
                          <button
                            key={n.notification_id || i}
                            onClick={() => { if (!n.read && markNotificationRead) markNotificationRead(n.notification_id || n.id); }}
                            className={cn(
                              "text-left p-4 border-b border-border/40 hover:bg-muted/50 transition-colors select-text cursor-default",
                              !n.read ? "bg-royal/5 border-l-[3px] border-l-royal" : "opacity-75"
                            )}
                          >
                            <div className="flex justify-between items-start mb-1.5">
                              <span className={cn("text-xs font-bold uppercase tracking-tight flex-1", !n.read ? "text-foreground" : "text-muted-foreground")}>{n.title || "Aviso del Sistema"}</span>
                              <span className="text-[9px] text-muted-foreground ml-2 font-medium">{n.created_at ? new Date(n.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Ahora'}</span>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">{n.message}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              )}
            </div>
          </div>

          <div className="h-6 w-px bg-border mx-2" />

          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-xs font-bold leading-none">{user?.name}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">{user?.role || 'User'}</p>
            </div>
            {user?.picture ? (
              <img src={user.picture} alt="" className="w-8 h-8 rounded-full border border-white/10" />
            ) : (
                <div className="w-8 h-8 rounded-full bg-royal/20 flex items-center justify-center text-royal font-bold text-xs uppercase">
                  {user?.name?.[0]}
                </div>
            )}
            <button onClick={logout} className="p-2 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive">
               <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Enterprise Suite Command Bar (Unified) */}
      <div className={cn(
        "px-6 py-4 flex flex-col gap-4 border-b z-30 transition-all",
        isDark ? "bg-navy border-white/5 shadow-2xl" : "bg-card border-gray-200 shadow-sm"
      )}>
        {/* TOP ROW: Views, Metrics and Board Identifier */}
        <div className="flex items-end justify-between w-full">
          <div className="flex items-center gap-6 relative z-10">
            {/* Saved Views Selector */}
            <div className="flex flex-col items-center">
              <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1.5 text-center">Vistas Guardadas</label>
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center justify-between gap-3 px-4 py-2 bg-muted/20 border border-border/20 rounded-lg hover:border-royal/50 hover:bg-muted/40 transition-all group outline-none min-w-[160px] w-[180px]">
                  <span className={cn("text-xs font-bold uppercase tracking-tight flex-1 text-center", activeViewName ? "text-royal" : "text-muted-foreground")}>
                    {activeViewName || "Vista Estándar"}
                  </span>
                  <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-royal transition-colors" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="z-[100] min-w-[240px] bg-card/95 backdrop-blur-xl border-border rounded-lg shadow-2xl p-1 animate-in slide-in-from-top-2">
                   {currentBoardViews.length === 0 && <div className="p-4 text-center text-xs text-muted-foreground italic">No hay vistas guardadas</div>}
                   
                   {pinnedViews.length > 0 && (
                     <div className="p-2 border-b border-border/50">
                       <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-royal mb-1 px-2">Fijadas</div>
                       {pinnedViews.map(view => (
                         <div key={view.view_id} className="flex items-center gap-1 group">
                           <DropdownMenuItem onClick={() => handleApplyView(view)} className="flex-1 py-2 px-3 text-xs font-bold uppercase tracking-wider rounded-lg cursor-pointer hover:bg-muted">
                             {view.name}
                           </DropdownMenuItem>
                           <button onClick={() => handleTogglePinView(view.view_id, view.pinned)} className="p-2 opacity-50 hover:opacity-100"><Pin className="w-3.5 h-3.5 text-royal fill-royal" /></button>
                         </div>
                       ))}
                     </div>
                   )}

                   {unpinnedViews.length > 0 && (
                     <div className="p-2">
                       <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-1 px-2">Todas</div>
                       {unpinnedViews.map(view => (
                         <div key={view.view_id} className="flex items-center gap-1 group">
                           <DropdownMenuItem onClick={() => handleApplyView(view)} className="flex-1 py-2 px-3 text-xs font-bold uppercase tracking-wider rounded-lg cursor-pointer hover:bg-muted">
                             {view.name}
                           </DropdownMenuItem>
                           <button onClick={() => handleTogglePinView(view.view_id, view.pinned)} className="p-2 opacity-0 group-hover:opacity-100 transition-opacity"><Pin className="w-3.5 h-3.5" /></button>
                           <button onClick={() => handleDeleteView(view.view_id)} className="p-2 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-500"><X className="w-3.5 h-3.5" /></button>
                         </div>
                       ))}
                     </div>
                   )}

                   <DropdownMenuSeparator className="bg-border/50" />
                   <DropdownMenuItem onClick={() => handleApplyView(null)} className="py-2.5 px-4 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-secondary flex items-center justify-between">
                     Restablecer Vista <RefreshCw className="w-3 h-3" />
                   </DropdownMenuItem>
                </DropdownMenuContent>
             </DropdownMenu>
          </div>

          <div className="h-10 w-px bg-border/40" />

          {/* Quick Metrics */}
          <div className="flex items-center gap-8">
            <div className="flex flex-col">
               <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest leading-none mb-1.5">Órdenes</span>
               <span className="text-xl font-bold tracking-tighter">{orders.length}</span>
            </div>
            <div className="flex flex-col">
               <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest leading-none mb-1.5">Total Qty</span>
               <span className="text-xl font-bold tracking-tighter text-royal">
                 {orders.reduce((sum, o) => sum + (Number(o.quantity) || 0), 0).toLocaleString()}
               </span>
            </div>
          </div>

          <div className="h-10 w-px bg-border/40 ml-2" />

          {/* Board Title Identifier */}
          <div className="text-[2.5rem] mt-[-4px] font-black font-barlow-semi tracking-tighter uppercase text-muted-foreground/30 pointer-events-none select-none whitespace-nowrap leading-none ml-2">
            {currentBoard}
          </div>

          </div>

          {/* Top-right action buttons */}
          <div className="flex items-center gap-2 self-center">
            <button onClick={() => setShowNewOrder(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-royal text-white rounded-lg font-bold text-[10px] uppercase tracking-[0.15em] shadow-md shadow-royal/20 hover:bg-royal/90 hover:scale-[1.02] active:scale-[0.98] transition-all whitespace-nowrap">
              <Plus className="w-3.5 h-3.5" />
              Nueva Orden
            </button>
            <div className="flex items-center rounded-lg overflow-hidden border border-emerald-600/40 shadow-sm shadow-emerald-600/10">
              <button onClick={() => { setShowProduction(true); fetchAllOrders(); }} title="Producción" className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white font-bold text-[10px] uppercase tracking-[0.15em] hover:bg-emerald-500 transition-all border-r border-emerald-500/40">
                <Factory className="w-3.5 h-3.5" />
                Production
              </button>
              <button onClick={() => setShowProductionScreen(true)} title="Pantalla de Producción (TV)" className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white font-bold text-[10px] uppercase tracking-[0.15em] hover:bg-emerald-500 transition-all">
                <Monitor className="w-3.5 h-3.5" />
                TV
              </button>
            </div>
            <button onClick={() => setShowCapacityPlan(true)} title="Planificación" className="flex items-center gap-2 px-4 py-1.5 bg-card border border-border text-foreground hover:bg-muted hover:text-royal rounded-lg font-bold text-[10px] uppercase tracking-widest shadow-sm hover:shadow-md transition-all whitespace-nowrap">
              <TrendingUp className="w-3.5 h-3.5" />
              PLAN
            </button>
          </div>
        </div>
        </div>

        {/* BOTTOM ROW: Controls and Actions */}
        <div className="flex items-center justify-between w-full pt-2">
          {/* Left Controls */}
          <div className="flex items-center gap-2">
            {/* View Toggle */}
            <div className="flex items-center border border-border rounded-lg overflow-hidden mr-4 bg-muted/10">
            <button 
              onClick={() => { setCalendarMode(false); setReadyCalendarMode(false); setBlanksTrackingMode(false); }} 
              className={cn("px-3 py-2 transition-all border-r border-border", !calendarMode && !readyCalendarMode && !blanksTrackingMode ? "bg-royal text-white" : "bg-transparent text-muted-foreground hover:bg-muted")}
              title="Vista de Tabla"
            >
              <Table2 size={16} />
            </button>
            {(currentBoard === 'SCHEDULING' || currentBoard === 'EJEMPLOS') && (
              <button
                onClick={() => { setCalendarMode(true); setReadyCalendarMode(false); setBlanksTrackingMode(false); }}
                className={cn("px-3 py-2 transition-all border-r border-border", calendarMode ? "bg-royal text-white" : "bg-transparent text-muted-foreground hover:bg-muted")}
                title="Calendario"
              >
                <CalendarDays size={16} />
              </button>
            )}
            {currentBoard === 'SCHEDULING' && (
              <>
                <button 
                  onClick={() => { setCalendarMode(false); setReadyCalendarMode(true); setBlanksTrackingMode(false); }} 
                  className={cn("px-3 py-2 transition-all border-r border-border", readyCalendarMode ? "bg-royal text-white" : "bg-transparent text-muted-foreground hover:bg-muted")}
                  title="Ready to Scheduled"
                >
                  <CalendarCheck size={16} />
                </button>
                <button 
                  onClick={() => { setCalendarMode(false); setReadyCalendarMode(false); setBlanksTrackingMode(true); }} 
                  className={cn("px-3 py-2 transition-all", blanksTrackingMode ? "bg-royal text-white" : "bg-transparent text-muted-foreground hover:bg-muted")}
                  title="Seguimiento de Blanks"
                >
                  <ClipboardList size={16} />
                </button>
              </>
            )}
          </div>

          {/* Grouping Selector */}
          {!calendarMode && !readyCalendarMode && !blanksTrackingMode && (
            <div className="mr-4">
              <Select value={groupByDate || 'none'} onValueChange={val => setGroupByDate(val === 'none' ? null : val)}>
                <SelectTrigger className="w-[180px] h-9 bg-muted/40 border-border/40 text-xs font-bold uppercase tracking-tight rounded-lg outline-none">
                  <SelectValue placeholder="No grouping" />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border z-[100]">
                  <SelectItem value="none" className="text-xs font-bold uppercase">No grouping</SelectItem>
                  <SelectItem value="cancel_date" className="text-xs font-bold uppercase">Cancel Date</SelectItem>
                  <SelectItem value="client" className="text-xs font-bold uppercase">By Client</SelectItem>
                  <SelectItem value="priority" className="text-xs font-bold uppercase">By Priority</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-2">
            {/* Mechanic Actions */}
            <div className="flex items-center gap-1.5 p-1">
             <button
                onClick={() => setShowGantt(true)}
                title="Gantt"
                className="p-2.5 rounded-lg hover:bg-royal/10 text-royal transition-all"
              >
                <GanttChart size={18} />
                <span className="sr-only">Gantt</span>
              </button>
          </div>

          <div className="h-8 w-px bg-border/40 mx-2" />

          {/* Admin Tools */}
          {isAdmin && (
             <div className="flex items-center gap-1.5 p-1 bg-muted/20 rounded-lg border border-border/20">
                <button onClick={() => setShowNewBoard(true)} title="Nuevo Tablero" className="p-2.5 rounded-lg hover:bg-royal/10 text-royal transition-all"><Plus size={18} /></button>
                <button onClick={() => setShowAddColumn(true)} title="Agregar Columna" className="p-2.5 rounded-lg hover:bg-royal/10 text-royal transition-all"><PlusCircle size={18} /></button>
                
                <Popover open={showBoardVisibility} onOpenChange={setShowBoardVisibility}>
                  <PopoverTrigger asChild>
                    <button className="p-2.5 rounded-lg hover:bg-muted text-muted-foreground transition-all" title="Visibilidad de Tableros">
                      <Eye size={18} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 max-h-80 overflow-y-auto rounded-lg shadow-2xl border z-[400] bg-card border-border p-0" align="end">
                    <div className="p-3 border-b border-border font-roboto font-bold text-xs uppercase tracking-widest text-foreground">Visibilidad de Tableros</div>
                    <ScrollArea className="h-60">
                      {allBoardsIncludingHidden.filter(b => b !== 'MASTER' && !b.startsWith('MAQUINA')).map(b => {
                        const isHidden = hiddenBoards.includes(b);
                        const isDeletable = b !== 'MASTER' && b !== 'COMPLETOS' && b !== 'PAPELERA DE RECICLAJE';
                        return (
                          <div key={b} className="flex items-center group/item hover:bg-secondary/50 transition-all">
                            <button onClick={() => toggleBoardVisibility(b)} className={`flex-1 flex items-center gap-2 px-3 py-2 text-left text-sm ${isHidden ? 'opacity-50' : ''}`}>
                              {isHidden ? <EyeOff className="w-3.5 h-3.5 text-muted-foreground" /> : <Eye className="w-3.5 h-3.5 text-green-500" />}
                              <span className={`flex-1 ${isHidden ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{b}</span>
                            </button>
                            {isDeletable && (
                              <button 
                                onClick={() => { setShowBoardVisibility(false); setDeleteBoardConfirm({ step: 1, name: b }); }}
                                className="p-2 text-muted-foreground hover:text-red-500 opacity-0 group-hover/item:opacity-100 transition-all"
                                title={`Eliminar ${b}`}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </ScrollArea>
                  </PopoverContent>
                </Popover>

                <button onClick={() => setShowImportExcel(true)} title="Importar Excel" className="p-2.5 rounded-lg hover:bg-emerald-600/10 text-emerald-600 transition-all"><FileDown size={18} /></button>
                <button onClick={() => setShowColumnManager(!showColumnManager)} title="Columnas" className="p-2.5 rounded-lg hover:bg-muted text-muted-foreground transition-all"><Settings size={18} /></button>
             </div>
          )}


        </div>
      </div>

      {/* Column Manager Panel */}
      {showColumnManager && (
        <div className={`border-b px-6 py-4 transition-all animate-in slide-in-from-top-2 duration-300 ${isDark ? 'bg-navy/40 border-white/5' : 'bg-muted/30 border-gray-100'}`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-royal" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Gestión de Columnas: {currentBoard}</span>
            </div>
            <button onClick={() => setShowColumnManager(false)} className="p-1 hover:bg-muted rounded-full transition-colors"><X size={16} /></button>
          </div>
          <div className="flex flex-wrap gap-2">
            {columns.map(col => {
              const isHidden = (hiddenColumns[currentBoard] || []).includes(col.key);
              return (
                <button
                  key={col.key}
                  onClick={() => handleToggleColumnVisibility(col.key)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-sm border transition-all text-xs font-bold",
                    isHidden 
                      ? "bg-transparent border-dashed border-border text-muted-foreground opacity-60" 
                      : "bg-background border-border text-foreground hover:border-royal/50"
                  )}
                >
                  {isHidden ? <EyeOff size={12} /> : <Eye size={12} className="text-royal" />}
                  {col.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
                  <DropdownMenuTrigger className={`min-w-[120px] md:w-48 h-9 md:h-10 flex items-center justify-between px-3 md:px-4 text-xs md:text-sm font-bold rounded-lg md:rounded-xl border bg-secondary/50 border-border text-foreground hover:bg-secondary`} data-testid="bulk-move-select">
                    <span className="truncate mr-1 md:mr-2">{t('move_to')}</span>
                    <ChevronDown className="w-4 h-4 md:w-5 md:h-5 opacity-70" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className={`z-[200] min-w-[220px] shadow-2xl bg-popover border-border`}>
                    {allBoardsIncludingHidden.filter(b => b !== currentBoard && b !== 'PAPELERA DE RECICLAJE' && !b.startsWith('MAQUINA')).map(board => (
                      <DropdownMenuItem key={board} onClick={() => handleBulkMoveWithLockCheck(selectedOrders, board, () => setSelectedOrders([]))} className="font-bold py-3.5 px-5 text-sm md:text-base tracking-tight">
                        {board}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator className="opacity-50" />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="flex items-center justify-between py-3.5 px-5 font-bold text-primary cursor-pointer text-sm md:text-base">
                        <div className="flex items-center gap-2.5">
                          <Monitor className="w-5 h-5" /> 
                          <span>MAQUINAS</span>
                        </div>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="z-[301] min-w-[200px] shadow-2xl">
                        {allBoardsIncludingHidden.filter(b => b !== currentBoard && b !== 'PAPELERA DE RECICLAJE' && b.startsWith('MAQUINA')).map(board => (
                          <DropdownMenuItem key={board} onClick={() => handleBulkMoveWithLockCheck(selectedOrders, board, () => setSelectedOrders([]))} className="font-bold py-3.5 px-5 text-sm md:text-base tracking-tight">
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

              <button onClick={handleBulkDelete} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all ${bulkDeleteConfirm ? 'bg-red-500 text-white animate-pulse' : isDark ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'bg-red-50 text-red-600 hover:bg-red-100'}`} title={t('trash')} data-testid="bulk-delete-btn">
                <Trash2 className="w-3.5 h-3.5" />
                <span>{bulkDeleteConfirm ? '¿Confirmar?' : t('trash')}</span>
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
      <main className="flex-1 overflow-auto relative isolation-isolate">
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
                            <th className={`py-4 px-3 sticky left-[96px] z-30 text-left text-[10px] font-bold tracking-[0.2em] uppercase border-r border-border/10 ${isDark ? 'bg-[hsl(220,30%,9%)] text-zinc-500/80 border-b border-border/60' : 'bg-gray-50 text-gray-400 border-b border-gray-200'}`} style={{ width: 160, minWidth: 160, maxWidth: 160 }}>
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
                                          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Board</span>
                                          {filters['_board'] && <button onClick={() => setFilters(prev => { const n={...prev}; delete n['_board']; return n; })} className="text-[10px] font-bold text-destructive hover:underline uppercase">Limpiar</button>}
                                        </div>
                                        <div className="max-h-60 overflow-y-auto mt-1 space-y-1">
                                          {BOARDS.filter(b => b !== 'MASTER' && b !== 'PAPELERA DE RECICLAJE' && !b.startsWith('MAQUINA')).sort().map(b => {
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
                                          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Orden</span>
                                          {filters['order_number'] && <button onClick={() => setFilters(prev => { const n={...prev}; delete n['order_number']; return n; })} className="text-[10px] font-bold text-destructive hover:underline uppercase">Limpiar</button>}
                                        </div>
                                        <input type="text" value={filters['order_number'] || ''} onChange={(e) => setFilters(prev => ({ ...prev, order_number: e.target.value || undefined }))} placeholder="Buscar orden..." className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary outline-none" autoFocus />
                                      </>
                                    )}
                                    <div className="pt-3 mt-3 border-t border-border flex items-center justify-between">
                                      <button onClick={() => setShowSaveView(true)} className="text-[10px] font-bold uppercase tracking-widest text-royal hover:underline">
                                        {t('save_view')}
                                      </button>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              </div>
                            </th>
                          );
                        })()}

                        {/* Columns 4+: Draggable Scrollable Content (with buffer on first) */}
                        {visibleColumns.filter(c => (currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? true : c.key !== 'order_number').map((col, idx) => {
                          const isOrderNum = col.key === 'order_number';
                          const width = isOrderNum ? 160 : (columnWidths[col.key] || col.width);
                          const filterVal = filters[col.key];
                          const isSelect = col.type === 'select' || col.type === 'status' || (col.optionKey && options[col.optionKey]);
                          const isDate = col.type === 'date';

                          return (
                            <th key={col.key} className={`py-4 ${idx === 0 ? 'pl-6 pr-3' : 'px-3'} text-left text-[10px] font-bold tracking-[0.2em] uppercase border-r border-border/5 shadow-sm ${isDark ? 'text-zinc-500/80' : 'text-gray-400'} ${draggedCol === col.key ? 'opacity-50' : ''}`} style={{ width: width, minWidth: width, maxWidth: 'none' }} data-testid={`column-header-${col.key}`} draggable onDragStart={() => handleColumnDragStart(col.key)} onDragOver={(e) => handleColumnDragOver(e, col.key)} onDragEnd={handleColumnDragEnd}>
                              <div className="flex items-center justify-between gap-1">
                                <div className="flex items-center gap-1.5 cursor-grab active:cursor-grabbing select-none overflow-hidden">
                                  {(currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') && <svg className="w-3.5 h-3.5 flex-shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0-6v6m18-6v6" /></svg>}
                                  <span className="truncate">{col.label}</span>
                                  {/* Filter Trigger Icon */}
                                  <Popover open={openFilter === col.key} onOpenChange={(val) => setOpenFilter(val ? col.key : null)}>
                                    <PopoverTrigger className={`p-0.5 rounded transition-colors flex-shrink-0 ${filterVal ? 'bg-primary/20 text-primary animate-pulse' : 'hover:bg-secondary text-muted-foreground'}`} onClick={(e) => e.stopPropagation()}>
                                      <ListFilter className="w-3.5 h-3.5" />
                                    </PopoverTrigger>
                                    <PopoverContent className="z-[600] min-w-[240px] bg-card border-border p-4 shadow-2xl overflow-y-auto max-h-[400px]">
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{col.label}</span>
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
                                      <div className="pt-3 mt-3 border-t border-border flex items-center justify-between">
                                        <button onClick={() => setShowSaveView(true)} className="text-[10px] font-bold uppercase tracking-widest text-royal hover:underline">
                                          {t('save_view')}
                                        </button>
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                </div>
                                <div className="cursor-col-resize px-1 opacity-40 hover:opacity-100" onMouseDown={(e) => { e.stopPropagation(); const startX = e.clientX; const startWidth = columnWidths[col.key] || col.width; const onMouseMove = (ev) => { setColumnWidths(prev => ({ ...prev, [col.key]: Math.max(80, startWidth + (ev.clientX - startX)) })); }; const onMouseUp = () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp); }}><GripVertical className="w-4 h-4" /></div>
                              </div>
                            </th>
                          );
                        })}
                        <th className={`py-4 px-3 text-left text-[10px] font-bold tracking-[0.2em] uppercase ${isDark ? 'text-zinc-500/80' : 'text-gray-400'}`} style={{ minWidth: 180 }} data-testid="column-header-restante">{t('restante')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {renderTableRows()}
                    </tbody>
                  </table>
                  {orders.length === 0 && <div className="text-center py-12 text-muted-foreground">{t('no_orders')}</div>}
                </>
              )}
      </main>

      {/* Modals */}
      <NewOrderModal isOpen={showNewOrder} onClose={() => setShowNewOrder(false)} onCreate={(order) => { setOrders(prev => [order, ...prev]); }} options={options} groupConfig={groupConfig} columns={columns} />
      <CommentsModal order={commentsOrder} isOpen={!!commentsOrder} onClose={() => { setCommentsOrder(null); setHighlightedCommentId(null); }} currentUser={user} highlightedCommentId={highlightedCommentId} />
      <AutomationsModal isOpen={showAutomations} onClose={() => setShowAutomations(false)} options={options} columns={columns} dynamicBoards={activeBoards} />
      {isAdmin && <FormFieldsManagerModal isOpen={showFormFields} onClose={() => setShowFormFields(false)} columns={columns} />}
      <AddColumnModal isOpen={showAddColumn} onClose={() => setShowAddColumn(false)} onAdd={handleAddColumn} existingColumns={columns} options={options} />
      <AnalyticsView isOpen={showAnalytics} onClose={() => setShowAnalytics(false)} allOrders={allOrders} options={options} />
      <ProductionModal isOpen={showProduction} onClose={() => setShowProduction(false)} orders={allOrders} onProductionUpdate={() => { fetchProductionSummary(); fetchOrders(); }} isAdmin={isAdmin} />
      <GanttView isOpen={showGantt} onClose={() => setShowGantt(false)} isDark={isDark} />
      <CapacityPlanModal isOpen={showCapacityPlan} onClose={() => setShowCapacityPlan(false)} />
      {showProductionScreen && <ProductionScreen onClose={() => setShowProductionScreen(false)} isDark={isDark} />}
      <OrderHistoryModal order={historyOrder} isOpen={!!historyOrder} onClose={() => setHistoryOrder(null)} />

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
            <DialogTitle className="font-roboto text-2xl font-bold uppercase tracking-tight flex items-center gap-3 text-glow-primary">
              <Search className="w-6 h-6 text-primary" /> Resultados de busqueda <span className="text-sm font-mono font-normal text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/50 ml-2">({searchResults?.length || 0})</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto px-6 pb-6">
            <div className="rounded-xl border border-border/50 overflow-x-auto bg-background/50 shadow-inner">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-secondary z-20 [transform:translateZ(0)]">
                  <tr className="border-b border-border/50">
                    <th className="text-left py-3 px-4 font-bold uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 min-w-[120px] sticky left-0 bg-secondary z-30 shadow-[4px_0_10px_rgba(0,0,0,0.1)] [transform:translateZ(0)]">{t('order')}</th>
                    <th className="text-left py-3 px-4 font-bold uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 min-w-[140px] border-l border-border/10">Tablero</th>
                    {columns.filter(c => c.key !== 'order_number').map(col => (
                      <th key={col.key} className="text-left py-3 px-4 font-bold uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 border-l border-border/10" style={{ minWidth: col.width || 150 }}>{col.label}</th>
                    ))}
                    <th className="text-center py-3 px-4 font-bold uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 border-l border-border/10 min-w-[80px] sticky right-0 bg-secondary z-30 shadow-[-4px_0_10px_rgba(0,0,0,0.1)] [transform:translateZ(0)]">Accion</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults?.map(order => (
                    <tr key={order.order_id}
                      className="border-b border-border/20 hover:bg-primary/5 transition-all duration-200 group"
                      data-testid={`search-result-${order.order_id}`}>
                      <td className="py-3 px-4 sticky left-0 bg-card z-10 group-hover:bg-primary/10 shadow-[4px_0_10px_rgba(0,0,0,0.05)] transition-colors [transform:translateZ(0)]">
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
                          className="font-mono font-bold text-primary text-base"
                        />
                      </td>
                      <td className="py-3 px-4 border-l border-border/5">
                        <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm border border-white/10" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666', color: '#fff' }}>{order.board}</span>
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
                      <td className="py-3 px-4 text-center sticky right-0 bg-card z-10 group-hover:bg-primary/10 shadow-[-4px_0_10px_rgba(0,0,0,0.05)] transition-colors [transform:translateZ(0)]">
                        <div className="flex items-center gap-1.5 justify-center">
                          <button
                            onClick={() => { setCommentsOrder(order); setSearchResults(null); }}
                            className="p-2 rounded-xl bg-secondary/60 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-all shadow-sm"
                            title="Ver comentarios"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => { setCurrentBoard(order.board); setSearchResults(null); setSearchQuery(''); setHighlightedOrderId(order.order_id); toast.success(`${order.order_number} → ${order.board}`); }}
                            className="p-2 rounded-xl bg-primary/10 text-primary hover:bg-primary hover:text-white transition-all shadow-sm glow-primary-hover"
                            title="Ir al tablero"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </button>
                        </div>
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
                  <h2 className="text-xl font-barlow font-bold uppercase text-destructive">Confirmacion Final</h2>
                  <p className="text-sm text-muted-foreground mt-2">Vas a eliminar <strong className="text-destructive">"{deleteBoardConfirm.name}"</strong> permanentemente.</p>
                  <p className="text-base font-bold text-foreground mt-3">Estas completamente seguro?</p>
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setDeleteBoardConfirm(null)} className="flex-1 py-2.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-bold" data-testid="cancel-delete-final">No, conservar tablero</button>
                <button onClick={async () => { const ok = await deleteBoard(deleteBoardConfirm.name); setDeleteBoardConfirm(null); if (ok) setCurrentBoard('MASTER'); }} className="flex-1 py-2.5 rounded bg-destructive text-white hover:bg-destructive/90 transition-colors text-sm font-bold uppercase tracking-wide" data-testid="confirm-delete-final">Eliminar definitivamente</button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      {/* System Guide Modal — triggered by secret code 201492 */}
      <ProductionModal isOpen={showProduction} onClose={() => setShowProduction(false)} orders={allOrders} onProductionUpdate={() => { fetchProductionSummary(); fetchOrders(); }} isAdmin={isAdmin} />
      <GanttView isOpen={showGantt} onClose={() => setShowGantt(false)} isDark={isDark} />
      <CapacityPlanModal isOpen={showCapacityPlan} onClose={() => setShowCapacityPlan(false)} />
      {showProductionScreen && <ProductionScreen onClose={() => setShowProductionScreen(false)} isDark={isDark} />}
      <OrderHistoryModal order={historyOrder} isOpen={!!historyOrder} onClose={() => setHistoryOrder(null)} />

      {/* Save View Modal */}
      <Dialog open={showSaveView} onOpenChange={setShowSaveView}>
        <DialogContent className="max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="font-roboto text-xl uppercase tracking-widest text-glow-primary flex items-center gap-2">
              <Save className="w-5 h-5 text-royal" /> {t('save_view')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest ml-1">Nombre de la Vista</label>
              <input 
                value={newViewName} 
                onChange={(e) => setNewViewName(e.target.value)} 
                placeholder="Ej: Solo Prioridad Alta" 
                className="w-full bg-secondary border border-border rounded-sm px-4 py-2.5 text-sm outline-none focus:border-royal transition-all" 
                autoFocus
              />
            </div>
            <p className="text-[10px] text-muted-foreground uppercase leading-relaxed font-bold opacity-60">
              * SE GUARDARAN LOS FILTROS ACTUALES DEL TABLERO {currentBoard}.
            </p>
          </div>
          <DialogFooter>
            <button onClick={() => setShowSaveView(false)} className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:bg-muted transition-all">{t('cancel')}</button>
            <button onClick={handleSaveView} disabled={!newViewName.trim()} className="px-6 py-2 bg-royal text-white rounded-sm font-bold text-xs uppercase tracking-widest shadow-lg shadow-royal/20 hover:bg-royal/90 transition-all disabled:opacity-50">{t('save')}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Board Modal */}
      <Dialog open={showNewBoard} onOpenChange={setShowNewBoard}>
        <DialogContent className="max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="font-roboto text-xl uppercase tracking-widest text-glow-primary">
              Nuevo Tablero
            </DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest ml-1">Nombre del Tablero</label>
              <input 
                value={newBoardName} 
                onChange={(e) => setNewBoardName(e.target.value)} 
                placeholder="Ej: CALIDAD, EMBALAJE..." 
                className="w-full bg-secondary border border-border rounded-sm px-4 py-2.5 text-sm outline-none focus:border-royal transition-all uppercase" 
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleCreateBoard()}
              />
            </div>
          </div>
          <DialogFooter>
            <button onClick={() => setShowNewBoard(false)} className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:bg-muted transition-all">Cancelar</button>
            <button 
              onClick={handleCreateBoard} 
              disabled={!newBoardName.trim()} 
              className="px-6 py-2 bg-royal text-white rounded-sm font-bold text-xs uppercase tracking-widest shadow-lg shadow-royal/20 hover:bg-royal/90 transition-all disabled:opacity-50"
            >
              Crear Tablero
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SystemGuideModal isOpen={showGuide} onClose={() => setShowGuide(false)} />

      {/* Import Excel Modal */}
      <ImportExcelModal isOpen={showImportExcel} onClose={() => setShowImportExcel(false)} onImportSuccess={() => fetchOrders()} />
      {/* Enterprise Side-Drawer Detail View */}
      {detailsOrder && (
        <div className="enterprise-drawer" style={{
          position: 'fixed', inset: '0 0 0 auto', width: '780px',
          borderLeft: '1px solid rgba(255,255,255,0.06)',
          boxShadow: '-10px 0 60px rgba(0,0,0,0.6)',
          display: 'flex', flexDirection: 'column', height: '100vh',
          zIndex: 100, fontFamily: 'inherit',
          animation: 'slideInFromRight 0.3s ease-out'
        }}>
          {/* Header */}
          <div style={{
            padding: '24px 28px', borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            backgroundColor: 'rgba(255,255,255,0.01)', flexShrink: 0
          }}>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: '10px', fontWeight: 900, color: '#4169e1', textTransform: 'uppercase', letterSpacing: '0.25em', marginBottom: '6px', opacity: 0.9 }}>
                Detalles de Orden
              </p>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px' }}>
                {isAdmin && isEditingOrderNo ? (
                  <input
                    type="text"
                    value={tempOrderNo}
                    onChange={(e) => setTempOrderNo(e.target.value)}
                    onBlur={() => {
                      if (tempOrderNo !== detailsOrder.order_number) {
                        handleCellUpdate(detailsOrder.order_id, 'order_number', tempOrderNo);
                        setDetailsOrder({ ...detailsOrder, order_number: tempOrderNo });
                      }
                      setIsEditingOrderNo(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (tempOrderNo !== detailsOrder.order_number) {
                          handleCellUpdate(detailsOrder.order_id, 'order_number', tempOrderNo);
                          setDetailsOrder({ ...detailsOrder, order_number: tempOrderNo });
                        }
                        setIsEditingOrderNo(false);
                      }
                      if (e.key === 'Escape') setIsEditingOrderNo(false);
                    }}
                    autoFocus
                    style={{
                      fontSize: '28px', fontWeight: 900, textTransform: 'uppercase',
                      backgroundColor: 'rgba(255,255,255,0.05)', color: '#ffffff',
                      border: '1px solid #4169e1', borderRadius: '4px',
                      padding: '2px 8px', outline: 'none', width: '200px',
                      marginLeft: '-8px'
                    }}
                  />
                ) : (
                  <h3 
                    onClick={() => {
                      if (isAdmin) {
                        setTempOrderNo(detailsOrder.order_number);
                        setIsEditingOrderNo(true);
                      }
                    }}
                    style={{ 
                      fontSize: '28px', fontWeight: 900, letterSpacing: '-0.04em', 
                      textTransform: 'uppercase', lineHeight: 1, color: '#ffffff', 
                      margin: 0, cursor: isAdmin ? 'pointer' : 'default' 
                    }}
                    title={isAdmin ? "Click para editar número de orden" : ""}
                  >
                    {detailsOrder.order_number}
                  </h3>
                )}

                {(() => {
                  const ps = productionSummary[detailsOrder.order_id];
                  const totalProduced = ps ? ps.total_produced : 0;
                  const qty = detailsOrder.quantity || 0;
                  const remaining = Math.max(0, qty - totalProduced);
                  const pct = qty > 0 ? Math.min(100, (totalProduced / qty) * 100) : 0;
                  if (qty <= 0) return null;
                  const barColor = pct >= 100 ? '#22c55e' : pct >= 50 ? '#94a3b8' : '#ef4444';
                  const pctColor = pct >= 100 ? '#4ade80' : pct >= 50 ? '#cbd5e1' : '#f87171';
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '9px', fontWeight: 900, color: '#4169e1', textTransform: 'uppercase', letterSpacing: '0.15em' }}>Progreso</span>
                        <span style={{ fontSize: '9px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>Faltan: {remaining}</span>
                        <span style={{ fontSize: '11px', fontWeight: 900, color: pctColor }}>{pct.toFixed(0)}%</span>
                      </div>
                      <div style={{ width: '128px', height: '5px', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: '999px', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: barColor, transition: 'width 1s ease', borderRadius: '999px' }} />
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
            <button
              onClick={() => setDetailsOrder(null)}
              style={{ padding: '8px', borderRadius: '50%', background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b', marginLeft: '16px' }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
            >
              <X style={{ width: '22px', height: '22px' }} />
            </button>
          </div>

          {/* Body - Scrollable */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '32px 28px', display: 'flex', flexDirection: 'column', gap: '28px' }}>
            
            {/* Cliente */}
            <div>
              <p style={{ fontSize: '9px', fontWeight: 900, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '6px' }}>Cliente</p>
              <p style={{ fontSize: '20px', fontWeight: 900, textTransform: 'uppercase', color: '#f1f5f9', margin: 0 }}>
                {renderDetailValue(detailsOrder.client)}
              </p>
            </div>

            {/* Separator */}
            <div style={{ height: '1px', background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.06), transparent)' }} />

            {/* Job Instructions */}
            <div>
              <p style={{ fontSize: '9px', fontWeight: 900, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '10px' }}>Instrucciones del Job</p>
              <div style={{ padding: '16px 18px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <p style={{ fontSize: '14px', fontWeight: 600, lineHeight: 1.6, color: '#cbd5e1', margin: 0 }}>
                  {renderDetailValue(detailsOrder.job_title_a)}
                </p>
              </div>
            </div>

            {/* Estados */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
                <div style={{ width: '3px', height: '14px', backgroundColor: '#4169e1', borderRadius: '2px', boxShadow: '0 0 8px rgba(65,105,225,0.5)' }} />
                <p style={{ fontSize: '10px', fontWeight: 900, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.25em', margin: 0 }}>Estados de la Orden</p>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '24px 20px' }}>
                {columns
                  .filter(col => ['production_status', 'blank_status', 'trim_status', 'artwork_status', 'sample', 'shipping', 'priority', 'screens', 'betty_column'].includes(col.key))
                  .map(col => (
                    <div key={col.key}>
                      <p style={{ fontSize: '8px', fontWeight: 900, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: '5px' }}>{col.label}</p>
                      <p style={{ fontSize: '12px', fontWeight: 800, color: '#e2e8f0', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {renderDetailValue(detailsOrder[col.key])}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{
            padding: '20px 28px', borderTop: '1px solid rgba(255,255,255,0.06)',
            backgroundColor: 'rgba(255,255,255,0.01)', display: 'flex', gap: '12px', flexShrink: 0
          }}>
            <button
              onClick={() => setCommentsOrder(detailsOrder)}
              style={{
                flex: 1, padding: '14px', backgroundColor: '#4169e1', color: '#fff',
                border: 'none', borderRadius: '10px', fontWeight: 900, fontSize: '11px',
                textTransform: 'uppercase', letterSpacing: '0.15em', cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(65,105,225,0.35)', transition: 'all 0.2s'
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#3557c9'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#4169e1'; e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              Abrir Mensajería
            </button>
            <button
              onClick={() => setDetailsOrder(null)}
              style={{
                padding: '14px 32px', backgroundColor: 'transparent', color: '#64748b',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px',
                fontWeight: 900, fontSize: '11px', textTransform: 'uppercase',
                letterSpacing: '0.15em', cursor: 'pointer', transition: 'all 0.2s'
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Command Palette */}
      <CommandPalette 
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        onNewOrder={() => setShowNewOrder(true)}
        onShowAutomations={() => setShowAutomations(true)}
        onShowAnalytics={() => setShowAnalytics(true)}
        onNavigateBoard={(b) => setCurrentBoard(b)}
        t={t}
      />
    </div>
  </div>
);
};

export default Dashboard;
