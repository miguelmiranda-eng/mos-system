import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useAuth } from "../App";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import { useTheme } from "../contexts/ThemeContext";
import {
  Search, Plus, LogOut, X, RefreshCw, Trash2, ListFilter,
  Download, Sun, Moon, GripVertical, PlusCircle,
  BarChart3, UserPlus, Bell, Eye, EyeOff, CalendarDays, CalendarCheck, Pin, Save, Table2, Undo2,
  Factory, GanttChart, TrendingUp, Languages, Monitor, MessageSquare, Loader2, History, Zap, AtSign, AlertTriangle, Users, ClipboardList, DatabaseBackup, Warehouse, ImageDown, ImageUp, FileJson, ArrowRightLeft, Wrench, Scissors,
  ChevronDown, ChevronUp, Check, FileDown, Home, ExternalLink, Menu, ArrowLeft, Link2, Truck, Clock
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
import SearchBox from "./dashboard/SearchBox";
import { CommentsModal } from "./dashboard/CommentsModal";
import { NewOrderModal } from "./dashboard/NewOrderModal";
import { AddColumnModal } from "./dashboard/AddColumnModal";
import { AutomationsModal } from "./dashboard/AutomationsModal";
import { FormFieldsManagerModal } from "./dashboard/FormFieldsManagerModal";
import OrderHistoryModal from "./OrderHistoryModal";
import { SystemGuideModal } from "./dashboard/SystemGuideModal";
import { ImportExcelModal } from "./dashboard/ImportExcelModal";
import { SeedPackingLinkModal } from "./dashboard/SeedPackingLinkModal";
// Existing top-level components
import AnalyticsView from "./AnalyticsView";
import CalendarView from "./CalendarView";
import BlanksTrackingView from "./BlanksTrackingView";
import ProductionModal from "./ProductionModal";
import NeckCaptureModal from "./NeckCaptureModal";
import GanttView from "./GanttView";
import CapacityPlanModal from "./CapacityPlanModal";
import PrintedReportModal from "./PrintedReportModal";
import ProductionScreen from "./ProductionScreen";
import Sidebar from "./dashboard/Sidebar";
import CommandPalette from "./dashboard/CommandPalette";

// Shared constants and hooks
import { cn } from "../lib/utils";
import { BOARDS, BOARD_COLORS, FILTER_COLUMNS, STATUS_COLORS, getBoardStyle, evaluateFormulaValue, API, normalizePublicUrl } from "../lib/constants";
import { useOrders, apiFetch } from "../hooks/useOrders";

// ── Global order search ────────────────────────────────────────────────────
// Flatten every value of an order (including dynamic/custom columns and nested
// art {url,desc} objects) so the search box matches ANYTHING the user types,
// not just a fixed field list. Internal id/timestamp keys are skipped so typing
// digits like "2026" doesn't accidentally match every order's created_at.
const _SEARCH_SKIP_KEY = /(_id$|^id$|_at$|^created|^updated|timestamp|^images$|^attachments$|^files$)/i;
function _flattenOrderValue(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(_flattenOrderValue).join(" ");
  if (typeof v === "object") return Object.values(v).map(_flattenOrderValue).join(" ");
  return String(v).toLowerCase();
}
function orderMatchesQuery(order, sq) {
  if (!sq) return true;
  for (const k of Object.keys(order)) {
    if (_SEARCH_SKIP_KEY.test(k)) continue;
    if (_flattenOrderValue(order[k]).includes(sq)) return true;
  }
  return false;
}

const Dashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [showPrintedReport, setShowPrintedReport] = useState(false);
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
          <a href={normalizePublicUrl(val.url)} target="_blank" rel="noopener noreferrer"
            style={{ color: '#60a5fa', textDecoration: 'underline', fontWeight: 700 }}>
            {val.desc}
          </a>
        );
      }
      if (val.url) return <a href={normalizePublicUrl(val.url)} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'underline' }}>{normalizePublicUrl(val.url)}</a>;
      if (val.desc || val.text || val.value || val.name) return String(val.desc || val.text || val.value || val.name);
      try { return JSON.stringify(val); } catch { return '[Object]'; }
    }
    return val;
  };


  // Board & filter state
  const [currentBoard, setCurrentBoard] = useState("SCHEDULING");
  const [boardFilters, setBoardFilters] = useState({});
  const [selectedOrders, setSelectedOrders] = useState([]);

  const handleSelectAll = () => setSelectedOrders(orders.map(o => o.order_id));
  const handleDeselectAll = () => setSelectedOrders([]);
  const toggleOrderSelection = (id) => setSelectedOrders(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const [openFilter, setOpenFilter] = useState(null);
  // The raw typed value now lives inside <SearchBox> (local state → instant echo
  // on iPad). The parent only keeps the debounced value used for filtering, plus
  // a token it bumps to clear the box after a global search.
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchClearToken, setSearchClearToken] = useState(0);

  // Theme from shared context (synced with CEODashboard and WMS)
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  // Column visibility & ordering.
  // boardColumnOrders / globalHidden come from "Columnas Globales" (MASTER) and
  // govern the whole system: which columns exist, their order, and which are
  // hidden for everyone.
  const [globalHidden, setGlobalHidden] = useState([]);
  const [boardColumnOrders, setBoardColumnOrders] = useState({});
  const [draggedCol, setDraggedCol] = useState(null);

  // Orden PERSONAL de columnas por tablero, sobrepuesto al global. Solo lo usa
  // el tramo alto (ver canArrangeColumns). Vive en localStorage y NO en Mongo:
  // la colección user_board_layouts se retiró en c60a516 con 1,049 documentos
  // y no vale la pena resucitarla — lo que se quiere conservar entre sesiones
  // cabe aquí, y lo que se quiere compartir se guarda como VISTA.
  const [personalOrder, setPersonalOrder] = useState({});

  // Columnas que ESTE usuario oculta, por tablero. Igual que el orden: solo
  // recorta su pantalla, nunca el set global. Las que oculta el supersu viven
  // en `globalHidden` y las ve (o no) todo el mundo.
  const [hiddenColumns, setHiddenColumns] = useState({});
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  // Modal visibility
  const [showNewOrder, setShowNewOrder] = useState(false);
  const searchInputRef = useRef(null); // focused from the mobile bottom-nav "Buscar"
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
  const [showNeckCapture, setShowNeckCapture] = useState(false);
  const [showGantt, setShowGantt] = useState(false);
  const [showCapacityPlan, setShowCapacityPlan] = useState(false);
  const [showProductionScreen, setShowProductionScreen] = useState(false);
  const [showFormFields, setShowFormFields] = useState(false);
  const [showImportExcel, setShowImportExcel] = useState(false);
  const [showSeedLink, setShowSeedLink] = useState(false);
  const [showBoardVisibility, setShowBoardVisibility] = useState(false);
  const [savedViews, setSavedViews] = useState({});
  const [activeViewName, setActiveViewName] = useState(null);
  const activeViewIdRef = useRef(null);
  const viewApplyingRef = useRef(false);
  const [trashOrders, setTrashOrders] = useState([]);
  const [trashSearch, setTrashSearch] = useState('');
  const [trashLoading, setTrashLoading] = useState(false);
  const [groupByDate, setGroupByDate] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  // Congelar (sticky) las cabeceras de grupo (ACTIVA / LUNES / etc.) para que
  // queden fijas bajo el encabezado de columnas al hacer scroll. Medimos la
  // altura real del encabezado de columnas y de la cabecera de cola para apilar
  // los niveles sin adivinar pixeles (el zoom/tema los cambia).
  const colHeadRef = useRef(null);
  const queueHeadRef = useRef(null);
  const [freezeTops, setFreezeTops] = useState({ col: 52, queue: 40 });
  // Órdenes programadas para envío (viven en scheduled_shipments, no en la orden).
  // Mapa { order_number: fecha_export } para pintar el reloj + dd/mm en la tarjeta.
  const [shipMap, setShipMap] = useState({});
  const loadShipMap = useCallback(async () => {
    try {
      const res = await fetch(`${API}/scheduled-shipments`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const m = {};
      (data.items || []).forEach(it => {
        if (it.order_number) m[it.order_number] = it.scheduled_export_date || '';
      });
      setShipMap(m);
    } catch { /* silent */ }
  }, []);
  useEffect(() => { loadShipMap(); }, [loadShipMap, currentBoard]);
  // Al volver de otra pestaña/módulo (p.ej. Envíos) refrescamos el mapa.
  useEffect(() => {
    const onFocus = () => loadShipMap();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadShipMap]);
  useEffect(() => {
    const measure = () => {
      const col = colHeadRef.current?.offsetHeight;
      const q = queueHeadRef.current?.offsetHeight;
      setFreezeTops(prev => {
        const next = { col: col || prev.col, queue: q || prev.queue };
        return next.col === prev.col && next.queue === prev.queue ? prev : next;
      });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) {
      if (colHeadRef.current) ro.observe(colHeadRef.current);
      if (queueHeadRef.current) ro.observe(queueHeadRef.current);
    }
    window.addEventListener('resize', measure);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [currentBoard, groupByDate]);
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(window.innerWidth < 1024);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [isTablet, setIsTablet] = useState(window.innerWidth < 1024 && window.innerWidth >= 768);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [detailsOrder, setDetailsOrder] = useState(null);
  const [isEditingOrderNo, setIsEditingOrderNo] = useState(false);
  const [tempOrderNo, setTempOrderNo] = useState('');
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showMachinesInFilter, setShowMachinesInFilter] = useState(false);

  useEffect(() => {
    let resizeTimer;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const width = window.innerWidth;
        const mobile = width < 768;
        const tablet = width < 1024 && width >= 768;
        setIsMobile(mobile);
        setIsTablet(tablet);
        if (width < 1024) setIsSidebarCollapsed(true);
        else setIsMobileMenuOpen(false);
      }, 150);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimer);
    };
  }, []);

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
    options, productionSummary, neckSummary, notifications, unreadCount, markNotificationsRead, markNotificationRead,
    automationRunning, automationMessage, columns, columnWidths, setColumnWidths,
    fetchOrders, fetchAllOrders, fetchOptions, fetchProductionSummary, fetchNeckSummary,
    handleCellUpdate, handleBulkMove, handleQuickUndo, handleGlobalSearch,
    handleAddColumn, saveCustomColumns,
    dynamicBoards, hiddenBoards, createBoard, deleteBoard, fetchBoards, toggleBoardVisibility,
    groupConfig, fetchGroups
  } = useOrders(currentBoard, boardFilters);

  // Search wiring for <SearchBox>. Stable callbacks so the debounce effect inside
  // SearchBox doesn't re-subscribe on every Dashboard render.
  const clearSearch = useCallback(() => {
    setDebouncedSearchQuery('');
    setSearchClearToken(t => t + 1);
  }, []);
  const handleSearchDebounced = useCallback((v) => setDebouncedSearchQuery(v), []);
  const handleSearchEnter = useCallback(async (v) => {
    const results = await handleGlobalSearch(v, setCurrentBoard);
    if (results === '__GUIDE__') { setShowGuide(true); clearSearch(); }
    else if (results) setSearchResults(results);
  }, [handleGlobalSearch, clearSearch]);

  const [displayLimit, setDisplayLimit] = useState(100);
  // Mobile renders fewer cards at once (phones choke past ~50); "Cargar más"
  // raises this. Reset on board change.
  const [mobileLimit, setMobileLimit] = useState(50);

  // Render acotado: 100 filas y botón "Cargar más" (+200), igual que el patrón
  // de móvil. El viejo "progressive rendering" (+200 cada 3s hasta el total)
  // terminaba montando TODO el tablero — en MASTER eran ~28k celdas editables
  // en el DOM y cada evento del WS reconciliaba la tabla completa.
  useEffect(() => {
    setDisplayLimit(100);
    setMobileLimit(50);
  }, [currentBoard]);

  const activeBoards = (dynamicBoards.length > 0 ? dynamicBoards : BOARDS).filter(b => !hiddenBoards.includes(b));
  const allBoardsIncludingHidden = dynamicBoards.length > 0 ? dynamicBoards : BOARDS;

  // Day-of-week scheduling: applies to machine boards + this fixed list.
  // Order matters for display (Mon..Sun).
  const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  // JS Date.getDay() maps 0=Sunday..6=Saturday; keep that order so
  // WEEKDAY_KEYS[new Date().getDay()] resolves to today's key directly.
  const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const DAY_LABEL_ES = { monday: 'Lunes', tuesday: 'Martes', wednesday: 'Miércoles', thursday: 'Jueves', friday: 'Viernes', saturday: 'Sábado', sunday: 'Domingo' };
  const DAY_LABEL_EN = { monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday' };
  const DAY_SHORT = { monday: 'Lun', tuesday: 'Mar', wednesday: 'Mié', thursday: 'Jue', friday: 'Vie', saturday: 'Sáb', sunday: 'Dom' };
  const DAY_SUPPORTED_NON_MACHINE = new Set(['READY TO SCHEDULED', 'BLANKS', 'SCREENS', 'NECK']);
  // Queue support (Activa / En Cola) is broader than just machines now —
  // BLANKS and NECK share the same workflow split.
  const QUEUE_SUPPORTED_NON_MACHINE = new Set(['BLANKS', 'NECK']);
  const isDaySupportedBoard = (b) => !!b && (b.startsWith('MAQUINA') || DAY_SUPPORTED_NON_MACHINE.has(b));
  const isQueueSupportedBoard = (b) => !!b && (b.startsWith('MAQUINA') || QUEUE_SUPPORTED_NON_MACHINE.has(b));
  const dayLabel = (key) => (lang === 'en' ? DAY_LABEL_EN : DAY_LABEL_ES)[key] || key;

  const isAdmin = ['admin', 'supersu', 'inspector_qc', 'qc'].includes(user?.role);
  // Mover columnas cambia el layout GLOBAL: privilegio exclusivo del supersu.
  const isSuperAdmin = user?.role === 'supersu';
  // Nivel de admin (1..5): supersu = 5; admin = su admin_level; cualquier otro = 0.
  // Mismo cálculo que el backend get_admin_level() y que los módulos WMS del front.
  const adminLevel = user?.role === 'supersu' ? 5 : (user?.role === 'admin' ? (parseInt(user?.admin_level, 10) || 1) : 0);
  // Reacomodar columnas arrastrando el encabezado. Volvió para el tramo alto
  // (admin_level 5 y supersu, que es el máximo). Es un orden PERSONAL: cambia
  // lo que ve quien arrastra, no el layout de los demás. El orden global se
  // sigue editando desde "Columnas Globales", que tiene su propio drag — así
  // se recupera la comodidad sin repetir lo que resolvió c60a516, que era que
  // cada quien viera un orden distinto sin saberlo.
  //   · supersu  → arrastrar reescribe el layout GLOBAL: lo que mueve, lo ven
  //                  todos. No necesita vistas para esto; él configura.
  //   · nivel 5   → arrastrar reacomoda SOLO su pantalla, y ese orden viaja en
  //                  sus vistas guardadas. Su orden personal le gana al global,
  //                  así que es el único grupo al que no le llegan los cambios
  //                  del supersu mientras tenga uno propio (para eso está el
  //                  botón de restablecer).
  //   · el resto  → no arrastran; ven el global siempre.
  const canArrangeColumns = adminLevel >= 5;
  const arrangesGlobally = isSuperAdmin;
  const hasPersonalOrder = canArrangeColumns && !isSuperAdmin;
  const colOrderKey = `mos_col_order_${user?.user_id || user?.email || 'anon'}`;
  // El guardado se salta EXACTAMENTE la pasada en que se hidrata desde
  // localStorage. Sin esto: al llegar el usuario cambia `colOrderKey`, y en ese
  // mismo commit el efecto de guardado corre con el `personalOrder` todavía
  // vacío del render anterior y pisa con {} lo que había guardado. El re-render
  // que provoca la hidratación vuelve a disparar el guardado, ya con el valor
  // bueno, así que no se pierde nada.
  const skipNextColSave = useRef(false);
  useEffect(() => {
    skipNextColSave.current = true;
    if (!hasPersonalOrder) { setPersonalOrder({}); return; }
    try {
      const raw = localStorage.getItem(colOrderKey);
      setPersonalOrder(raw ? JSON.parse(raw) : {});
    } catch { setPersonalOrder({}); }
  }, [colOrderKey, hasPersonalOrder]);
  useEffect(() => {
    if (skipNextColSave.current) { skipNextColSave.current = false; return; }
    if (!hasPersonalOrder) return;
    try { localStorage.setItem(colOrderKey, JSON.stringify(personalOrder)); } catch { /* cupo lleno: no es crítico */ }
  }, [personalOrder, colOrderKey, hasPersonalOrder]);

  // Visibilidad personal: misma mecánica y misma guardia. Va en su propia
  // llave para no mezclar dos cosas que se tocan por separado.
  const colVisKey = `mos_col_vis_${user?.user_id || user?.email || 'anon'}`;
  const skipNextVisSave = useRef(false);
  useEffect(() => {
    skipNextVisSave.current = true;
    if (!hasPersonalOrder) { setHiddenColumns({}); return; }
    try {
      const raw = localStorage.getItem(colVisKey);
      setHiddenColumns(raw ? JSON.parse(raw) : {});
    } catch { setHiddenColumns({}); }
  }, [colVisKey, hasPersonalOrder]);
  useEffect(() => {
    if (skipNextVisSave.current) { skipNextVisSave.current = false; return; }
    if (!hasPersonalOrder) return;
    try { localStorage.setItem(colVisKey, JSON.stringify(hiddenColumns)); } catch { /* cupo lleno: no es crítico */ }
  }, [hiddenColumns, colVisKey, hasPersonalOrder]);


  // Automatización "Barrido a BLANKS": solo Admin nivel 5 + supersu la ven/controlan.
  const canSweepBlanks = adminLevel >= 5;
  const [blanksSweep, setBlanksSweep] = useState(null);
  useEffect(() => {
    if (!canSweepBlanks) return undefined;
    let alive = true;
    fetch(`${API}/blanks-sweep`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d) setBlanksSweep(d); })
      .catch(() => { });
    return () => { alive = false; };
  }, [canSweepBlanks]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleBlanksSweep = async () => {
    const next = !(blanksSweep?.enabled);
    if (next && !window.confirm(
      '¿Encender el barrido automático a BLANKS?\n\n' +
      'Cada ' + (blanksSweep?.sweep_minutes || 10) + ' minutos moverá TODAS las órdenes de SCHEDULING ' +
      'que tengan fecha de cancelación al tablero BLANKS, distribuidas por su cancel date.\n' +
      'Las órdenes sin cancel date se quedan en SCHEDULING.'
    )) return;
    try {
      const res = await fetch(`${API}/blanks-sweep`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ enabled: next }),
      });
      if (res.ok) {
        setBlanksSweep(await res.json());
        toast.success(next ? 'Barrido a BLANKS ENCENDIDO' : 'Barrido a BLANKS APAGADO');
      } else {
        toast.error('No se pudo cambiar el barrido (¿permisos?)');
      }
    } catch { toast.error('Error al cambiar el barrido'); }
  };

  const handleBulkMoveWithLockCheck = async (orderIds, targetBoard, onComplete, queueStatus = null, scheduledDay = undefined) => {
    const qcBoardOrders = orders.filter(o => orderIds.includes(o.order_id) && o.board === 'CONTROL DE CALIDAD');
    const isQcAdmin = ['supersu', 'inspector_qc', 'qc'].includes(user?.role);

    if (qcBoardOrders.length > 0 && !isQcAdmin) {
      toast.error(`🔒 ${qcBoardOrders.length} orden(es) están en CONTROL DE CALIDAD. Solo SuperSU o Inspector QC pueden moverlas.`);
      return;
    }

    const lockedOrders = orders.filter(o => orderIds.includes(o.order_id) && o.locked_by_qc);
    if (lockedOrders.length > 0) {
      if (!isQcAdmin) {
        toast.error(`🔒 ${lockedOrders.length} orden(es) bloqueada(s) por QC: ${lockedOrders.map(o => o.order_number).join(', ')}`);
        return;
      }
      const nums = lockedOrders.map(o => o.order_number).join(', ');
      const ok = window.confirm(`⚠️ SUPERVISOR QC: ${lockedOrders.length} orden(es) bloqueada(s) por QC (${nums}).\n\n¿Confirmas moverlas de todas formas?`);
      if (!ok) return;
    }
    await handleBulkMove(orderIds, targetBoard, queueStatus, scheduledDay);
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
        const res = await fetch(`${API}/config/user-view-config/MASTER`, { credentials: 'include' });
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
      fetch(`${API}/config/user-view-config/MASTER`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(configPayload)
      }).catch(() => { });
    }, 1500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [currentBoard, boardFilters, groupByDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the GLOBAL column layout (MASTER) defined in "Columnas Globales" and
  // apply it to EVERY board — the CRM shows only the columns/order/visibility
  // that Columnas Globales dictates, with no per-board divergence.
  const layoutLoaded = useRef({});
  useEffect(() => {
    if (layoutLoaded.current[currentBoard]) return;
    const loadLayout = async () => {
      try {
        const res = await fetch(`${API}/config/board-layout/MASTER`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setBoardColumnOrders(prev => ({ ...prev, [currentBoard]: data.column_order || [] }));
          setGlobalHidden(data.hidden_columns || []);
          layoutLoaded.current[currentBoard] = true;
        }
      } catch { /* silent */ }
    };
    loadLayout();
  }, [currentBoard]);

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
      if (actionParam === 'showTrash' && isSuperAdmin) setShowTrash(true);
      if (actionParam === 'showGantt') setShowGantt(true);
      if (actionParam === 'showCapacityPlan') setShowCapacityPlan(true);
      if (actionParam === 'showProductionScreen') setShowProductionScreen(true);
      // Clean up URL without reload
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [dynamicBoards]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch BLANKS + READY TO SCHEDULE orders for views in SCHEDULING
  const fetchExtra = useCallback(async () => {
    try {
      const [bRes, rRes] = await Promise.all([
        apiFetch(`${API}/orders?board=BLANKS`, { credentials: 'include' }),
        apiFetch(`${API}/orders?board=READY TO SCHEDULED`, { credentials: 'include' })
      ]);
      if (bRes.ok) setBlanksOrders(await bRes.json());
      if (rRes.ok) setReadyOrders(await rRes.json());
    } catch { }
  }, [apiFetch, API]); // eslint-disable-line react-hooks/exhaustive-deps

  // Visible columns = configuración global (qué columnas existen, cuáles están
  // ocultas para todos) con el orden PERSONAL sobrepuesto si quien mira tiene
  // permiso y ya movió algo. Sin orden personal, se ve el global tal cual.
  const visibleColumns = useMemo(() => {
    const hidden = hasPersonalOrder
      ? [...globalHidden, ...(hiddenColumns[currentBoard] || [])]
      : globalHidden;
    const order = (hasPersonalOrder && personalOrder[currentBoard]?.length)
      ? personalOrder[currentBoard]
      : boardColumnOrders[currentBoard];
    let cols = columns.filter(c => !hidden.includes(c.key));
    if (order) { cols = order.map(key => cols.find(c => c.key === key)).filter(Boolean); const ordered = new Set(order); cols = [...cols, ...columns.filter(c => !ordered.has(c.key) && !hidden.includes(c.key))]; }
    return cols;
  }, [globalHidden, hiddenColumns, currentBoard, boardColumnOrders, personalOrder, hasPersonalOrder, columns]);

  // Saved views
  const fetchSavedViews = useCallback(async () => {
    try { const res = await fetch(`${API}/config/saved-views`, { credentials: 'include' }); if (res.ok) { const data = await res.json(); const grouped = {}; data.forEach(v => { if (!grouped[v.board]) grouped[v.board] = []; grouped[v.board].push(v); }); setSavedViews(grouped); } } catch { /* silent */ }
  }, []);
  useEffect(() => {
    fetchSavedViews();
  }, [fetchSavedViews]);

  const handleSaveView = async () => {
    if (!newViewName.trim()) return;
    try {
      // La vista vuelve a llevar el orden de columnas, pero SOLO el personal:
      // si quien guarda no movió nada, no se congela el global — así la vista
      // sigue reflejando los cambios que el supersu haga después.
      const res = await fetch(`${API}/config/saved-views`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: newViewName.trim(), board: currentBoard, filters, pinned: false, group_by_date: groupByDate, column_order: hasPersonalOrder ? (personalOrder[currentBoard] || []) : [], hidden_columns: hasPersonalOrder ? (hiddenColumns[currentBoard] || []) : [] }) });
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
      // El orden guardado se aplica solo a quien puede reacomodar; para el
      // resto la vista sigue siendo filtros + agrupación sobre el layout
      // global, que es como la ven hoy.
      if (hasPersonalOrder && view.column_order?.length)
        setPersonalOrder(prev => ({ ...prev, [currentBoard]: view.column_order }));
      if (hasPersonalOrder && view.hidden_columns !== undefined)
        setHiddenColumns(prev => ({ ...prev, [currentBoard]: view.hidden_columns || [] }));
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
          group_by_date: groupByDate,
          column_order: hasPersonalOrder ? (personalOrder[currentBoard] || []) : [],
          hidden_columns: hasPersonalOrder ? (hiddenColumns[currentBoard] || []) : [],
        })
      }).then(() => fetchSavedViews()).catch(() => { });
    }, 1200);
    return () => { if (viewAutoSaveRef.current) clearTimeout(viewAutoSaveRef.current); };
  }, [filters, groupByDate, personalOrder, hiddenColumns, currentBoard, activeViewName, fetchSavedViews]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset active view when board changes to prevent overwriting
  useEffect(() => {
    viewApplyingRef.current = true;
    setActiveViewName(null);
    activeViewIdRef.current = null;
  }, [currentBoard]);

  const currentBoardViews = savedViews[currentBoard] || [];
  const pinnedViews = currentBoardViews.filter(v => v.pinned);
  const unpinnedViews = currentBoardViews.filter(v => !v.pinned);

  // Escribe el layout GLOBAL. Solo lo alcanza el supersu; el backend además lo
  // exige con require_supersu en PUT /config/board-layout.
  const publicarLayoutGlobal = (orden, ocultas) => {
    fetch(`${API}/config/board-layout/MASTER`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ hidden_columns: ocultas, column_order: orden })
    }).catch(err => console.error('Error saving layout:', err));
  };
  const handleUpdateColumnOrder = (newOrder) => publicarLayoutGlobal(newOrder, globalHidden);

  // Mostrar/ocultar una columna. Quién la toca decide a quién le desaparece:
  //   · supersu → sale del layout global; deja de verla todo el mundo.
  //   · nivel 5 → solo se recorta su pantalla.
  // order_number y style se quedan siempre: son las llaves con las que se
  // navega a la orden, y sin ellas la tabla no lleva a ningún lado.
  const COLUMNAS_FIJAS = ['order_number', 'style'];
  const handleToggleColumn = (colKey) => {
    if (COLUMNAS_FIJAS.includes(colKey)) {
      toast.error('Esta columna es obligatoria para la navegación.');
      return;
    }
    if (arrangesGlobally) {
      const next = globalHidden.includes(colKey)
        ? globalHidden.filter(k => k !== colKey)
        : [...globalHidden, colKey];
      setGlobalHidden(next);
      publicarLayoutGlobal(boardColumnOrders[currentBoard] || [], next);
      return;
    }
    setHiddenColumns(prev => {
      const cur = prev[currentBoard] || [];
      const next = cur.includes(colKey) ? cur.filter(k => k !== colKey) : [...cur, colKey];
      return { ...prev, [currentBoard]: next };
    });
  };

  // Arrastre de columnas. Quién arrastra decide a quién le cambia:
  //   · supersu → reescribe el layout global y lo publica al soltar.
  //   · nivel 5 → solo su pantalla; el orden queda en localStorage y en sus
  //     vistas guardadas, sin tocar a nadie más.
  const handleColumnDragStart = (colKey) => { if (canArrangeColumns) setDraggedCol(colKey); };
  const handleColumnDragOver = (e, targetKey) => {
    e.preventDefault();
    if (!draggedCol || draggedCol === targetKey) return;
    const allKeys = visibleColumns.map(c => c.key);
    // Se parte del orden que se está viendo (personal si ya movió, global si no)
    // y se completa con las columnas que ese orden no menciona.
    const base = (hasPersonalOrder && personalOrder[currentBoard]?.length)
      ? personalOrder[currentBoard]
      : boardColumnOrders[currentBoard];
    let currentOrder = base ? [...base.filter(k => allKeys.includes(k)), ...allKeys.filter(k => !new Set(base).has(k))] : allKeys;
    const dragIdx = currentOrder.indexOf(draggedCol);
    const targetIdx = currentOrder.indexOf(targetKey);
    if (dragIdx === -1 || targetIdx === -1) return;
    const newOrder = [...currentOrder]; newOrder.splice(dragIdx, 1); newOrder.splice(targetIdx, 0, draggedCol);
    if (arrangesGlobally) setBoardColumnOrders(prev => ({ ...prev, [currentBoard]: newOrder }));
    else setPersonalOrder(prev => ({ ...prev, [currentBoard]: newOrder }));
  };
  const handleColumnDragEnd = () => {
    setDraggedCol(null);
    // El supersu publica al soltar: su orden es el de todos. El nivel 5 no pega
    // al backend — su orden vive en localStorage y en sus vistas.
    if (arrangesGlobally) handleUpdateColumnOrder(boardColumnOrders[currentBoard] || []);
  };


  // Vuelve al orden global de este tablero. Es la salida de emergencia: sin
  // ella, quien movió una columna se queda con su orden para siempre y deja de
  // ver los cambios que el supersu haga al layout de todos.
  const handleResetColumnOrder = () => {
    setPersonalOrder(prev => {
      const next = { ...prev };
      delete next[currentBoard];
      return next;
    });
    toast.success('Columnas de vuelta al orden global');
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
  const fetchTrashOrders = useCallback(async () => {
    setTrashLoading(true);
    try {
      const res = await apiFetch(`${API}/orders?board=PAPELERA DE RECICLAJE`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTrashOrders(data);
        setTrashCount(data.length);
      }
    } catch { toast.error(t('trash_load_err')); } finally { setTrashLoading(false); }
  }, [t]);

  // El contador solo le sirve al supersu, que es el único que ve la papelera:
  // en las demás cuentas ni se pide.
  const fetchTrashCount = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const res = await apiFetch(`${API}/orders/board-counts`, { credentials: 'include' });
      if (res.ok) {
        const counts = await res.json();
        setTrashCount(counts["PAPELERA DE RECICLAJE"] || 0);
      }
    } catch { /* silent */ }
  }, [isSuperAdmin]);

  useEffect(() => {
    fetchTrashCount();
  }, [fetchTrashCount, orders]); // Refresh trash count when orders change (e.g. after deletion)

  // La papelera se carga al ABRIRLA. El contador del sidebar salía de
  // /orders/board-counts, pero la LISTA solo se pedía después de restaurar o
  // vaciar: al abrir el modal por primera vez siempre se veía vacío aunque el
  // tablero PAPELERA DE RECICLAJE tuviera órdenes.
  useEffect(() => {
    if (showTrash && isSuperAdmin) { setTrashSearch(''); fetchTrashOrders(); }
  }, [showTrash, isSuperAdmin, fetchTrashOrders]);

  // Vista filtrada de la papelera. TODO lo que se muestra y TODO lo que hacen
  // los botones del pie opera sobre esta lista, no sobre la completa: con el
  // buscador activo, "restaurar/vaciar" debe tocar exactamente lo que el
  // usuario está viendo.
  const visibleTrashOrders = useMemo(() => {
    const q = trashSearch.trim().toLowerCase();
    if (!q) return trashOrders;
    return trashOrders.filter(o =>
      String(o.order_number || '').toLowerCase().includes(q) ||
      String(o.client || '').toLowerCase().includes(q)
    );
  }, [trashOrders, trashSearch]);
  const handleRestoreFromTrash = async (orderIds, targetBoard = 'SCHEDULING') => {
    setOperationLoading(true);
    // apiFetch y NO fetch crudo: apiFetch es quien invalida el caché de GETs de
    // /orders al mutar (http.js) y quien maneja el 401. Con fetch crudo, el
    // refetch de abajo caía en el caché de 5s y devolvía la foto ANTERIOR: la
    // orden seguía apareciendo en la papelera y el botón parecía no servir.
    // Y sin revisar res.ok, un 401/403 pintaba igual el toast verde de éxito.
    try {
      const res = await apiFetch(`${API}/orders/bulk-move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ order_ids: orderIds, board: targetBoard }) });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `El servidor respondió ${res.status}`);
      }
      toast.success(`${orderIds.length} ${t('orders')} → ${targetBoard}`);
      fetchTrashOrders();
      fetchOrders();
    } catch (err) { toast.error(`${t('restore_err')}: ${err.message}`); } finally { setOperationLoading(false); }
  };
  const handlePermanentDelete = async (orderIds) => {
    if (!window.confirm(`${t('permanent_delete')} ${orderIds.length} ${t('orders')}?`)) return;
    setOperationLoading(true);
    try {
      for (const oid of orderIds) {
        const res = await apiFetch(`${API}/orders/${oid}/permanent`, {
          method: 'DELETE',
          credentials: 'include'
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || 'Error en el servidor');
        }
      }
      toast.success(`${orderIds.length} ${t('orders')} eliminadas permanentemente`);
      fetchTrashOrders();
      fetchTrashCount();
    } catch (err) {
      toast.error(`${t('perm_del_err')}: ${err.message}`);
    } finally {
      setOperationLoading(false);
    }
  };

  // Export
  const handleExportExcel = () => {
    try {
      const selectedIds = selectedOrders.map(String);
      const ordersToExport = orders.filter(o => selectedIds.includes(String(o.order_id)));

      if (ordersToExport.length === 0) {
        toast.error(t('select_export'));
        return;
      }

      const exportData = ordersToExport.map(o => {
        const row = {};
        visibleColumns.forEach(col => {
          // Una columna de fórmula no tiene valor guardado en la orden: se
          // calcula al pintar. Sin esto salía SIEMPRE en blanco en el Excel.
          // evaluateFormulaValue conserva el tipo (número como número), para
          // que Excel pueda sumar la columna en vez de recibir texto.
          row[col.label] = col.type === 'formula'
            ? evaluateFormulaValue(col.key, o, columns)
            : (o[col.key] || '');
        });
        row[t('board')] = o.board;

        // Avance / Restante — mismas cifras que la columna "RESTANTE" del board.
        // productionSummary va por order_number; quantity es lo planeado.
        const prodData = productionSummary?.[o.order_number] || { total_produced: 0 };
        const total = Number(o.quantity) || 0;
        const produced = Number(prodData.total_produced) || 0;
        const remaining = Math.max(0, total - produced);
        const progressPct = total > 0 ? Math.min(100, Math.round((produced / total) * 100)) : 0;
        row['Produced'] = produced;
        row['Remaining'] = remaining;
        row['Progress %'] = progressPct;
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




  // Top-level hooks for data fetching




  // Initial data loading
  useEffect(() => { fetchBoards(); }, [fetchBoards]);
  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  useEffect(() => { if (currentBoard === 'SCHEDULING') fetchExtra(); }, [currentBoard, fetchExtra]);
  // Active-search match test — used to render ONLY matching rows while searching
  // (instead of rendering the whole board and just highlighting matches), which
  // keeps search snappy on iPad Safari.
  const matchesSearch = useCallback((order) => {
    if (!debouncedSearchQuery) return true;
    // Global search across every field of the order (incl. customer, style,
    // color, manufacturer, status and any dynamic column), not just a fixed set.
    return orderMatchesQuery(order, debouncedSearchQuery.toLowerCase());
  }, [debouncedSearchQuery]);

  // Hoisted: este filter corría POR FILA en cada render (100+ filas × render);
  // el resultado es idéntico para todas.
  const dataColumns = useMemo(
    () => visibleColumns.filter(c => c.key !== 'order_number'),
    [visibleColumns]
  );

  const renderOrderRow = useCallback((order) => {
    const sq = debouncedSearchQuery.toLowerCase();
    const getVal = (v) => {
      if (!v) return "";
      if (typeof v === 'object') return `${v.url || ""} ${v.desc || ""}`.toLowerCase();
      return String(v).trim().toLowerCase();
    };

    const isSearchMatch = debouncedSearchQuery && orderMatchesQuery(order, sq);

    const isSelected = selectedOrders.includes(order.order_id);
    const rowBgClass = isSearchMatch
      ? (isDark ? 'bg-[hsl(220,70%,22%)]' : 'bg-blue-50')
      : isSelected
        ? (isDark ? 'bg-[hsl(220,70%,18%)]' : 'bg-blue-50')
        : (isDark ? 'bg-[hsl(220,30%,9%)] group-hover:bg-[hsl(220,30%,12%)]' : 'bg-white group-hover:bg-gray-50');

    const isHighlighted = highlightedOrderId === order.order_id;
    const canEditBoard = isAdmin || (currentBoard !== 'MASTER' && currentBoard !== 'EJEMPLOS');

    return (
      <React.Fragment key={order.order_id}>
        {/* Selection Checkbox */}
        <div
          data-order-id={order.order_id}
          className={`py-2 px-2 sticky left-0 z-[30] border-r border-b border-border/5 flex items-center justify-center ${isSelected ? 'border-l-[4px] border-l-primary' : isHighlighted ? 'border-l-[4px] border-l-yellow-400' : 'border-l-[4px] border-l-transparent'} ${isHighlighted ? (isDark ? 'bg-yellow-900/30' : 'bg-yellow-50') : rowBgClass}`}
          style={{ width: 48, minWidth: 48, maxWidth: 48 }}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e) => { e.stopPropagation(); toggleOrderSelection(order.order_id); }}
            className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
          />
        </div>

        {/* Quick Actions (Sticky Column 2) */}
        <div className={`py-2 px-1 sticky left-[48px] z-[30] border-r border-b border-border/5 flex items-center justify-center ${isHighlighted ? (isDark ? 'bg-yellow-900/30' : 'bg-yellow-50') : rowBgClass}`} style={{ width: 64, minWidth: 64, maxWidth: 64 }}>
          <div className="flex flex-row gap-2 items-center justify-center">
            <button onClick={() => setCommentsOrder(order)} className="p-1 rounded-lg transition-all hover:bg-secondary hover:scale-110 active:scale-95 text-slate-500 dark:text-slate-400 hover:text-primary relative" title={t('comments')}>
              <MessageSquare className="w-4 h-4" />
              {order._comments_count > 0 && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-royal rounded-full border border-background" />}
            </button>
            {isAdmin && (
              <button onClick={() => setHistoryOrder(order)} className="p-1 rounded-lg transition-all hover:bg-secondary hover:scale-110 active:scale-95 text-slate-500 dark:text-slate-400 hover:text-primary" title="Historial Extendido">
                <ClipboardList className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Order Number / Board (Sticky Column 3) */}
        <div
          className={`py-2 px-3 sticky left-[112px] z-[30] border-r border-b border-border/10 group/order flex flex-col justify-center items-center ${isHighlighted ? (isDark ? 'bg-yellow-900/30' : 'bg-yellow-50') : rowBgClass}`}
          style={{ width: 200, minWidth: 200, maxWidth: 200 }}
        >
          {/* Order number (centered, large, bold) */}
          <div className="flex flex-col items-center justify-center w-full min-w-0">
            <span className={`font-black text-xl tracking-tight leading-none text-slate-800 dark:text-slate-100 ${isSearchMatch ? 'text-primary' : ''}`}>
              {order.order_number}
            </span>
            {(currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') && (
              <div className="flex items-center gap-1 mt-1">
                {order.packing_link && (
                  <span title={`Packing importado${order.packing_link_label ? `: ${order.packing_link_label}` : ''}`} className="inline-flex text-emerald-500" data-testid={`order-imported-${order.order_id}`}>
                    <Truck className="w-3 h-3" />
                  </span>
                )}
                <span className="w-fit px-1.5 py-0.5 rounded-[2px] text-[9px] font-bold uppercase tracking-tighter text-white" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666' }}>
                  {order.board}
                </span>
              </div>
            )}
          </div>

          {/* TWIN / NECK / SEP / PL badges horizontal row (centered).
              Padding y gap reducidos para que los 4 quepan sin apretarse en la
              columna de 200px. */}
          <div className="flex flex-row flex-wrap items-center justify-center gap-1 mt-2 w-full shrink-0">
            {/* TWIN Badge */}
            {order.twin_order_number ? (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const res = await fetch(`${API}/orders/${encodeURIComponent(order.twin_order_number)}`, { credentials: 'include' });
                    if (!res.ok) { toast.error(`Twin ${order.twin_order_number} no encontrada`); return; }
                    const twin = await res.json();
                    if (twin.board) setCurrentBoard(twin.board);
                    setHighlightedOrderId(twin.order_id);
                    toast.success(`Twin: ${twin.order_number} → ${twin.board}`);
                  } catch { toast.error('Error buscando la orden gemela'); }
                }}
                className="px-2 py-0.5 rounded-full text-[9px] font-extrabold tracking-wide leading-none bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-950/40 dark:text-fuchsia-400 border border-fuchsia-200/20 hover:bg-fuchsia-500 hover:text-white transition-all cursor-pointer"
                title={`Twin: ${order.twin_order_number} — click para ir`}
              >
                TWIN
              </button>
            ) : (
              <span className="px-2 py-0.5 rounded-full text-[9px] font-extrabold tracking-wide leading-none bg-slate-100/50 text-slate-300 dark:bg-slate-800/40 dark:text-slate-600 border border-transparent" title="No Twin Order linked">
                TWIN
              </span>
            )}

            {/* NECK Badge */}
            <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold tracking-wide leading-none border transition-all ${order.art_neck_status
              ? 'bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400 border-blue-200/20'
              : 'bg-slate-100/50 text-slate-300 dark:bg-slate-800/40 dark:text-slate-600 border-transparent'
              }`} title={order.art_neck_status ? "Neck Label Listo" : "Neck Label Pendiente"}>
              NECK
            </span>

            {/* SEP Badge */}
            <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold tracking-wide leading-none border transition-all ${order.art_sep_status
              ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400 border-emerald-200/20'
              : 'bg-slate-100/50 text-slate-300 dark:bg-slate-800/40 dark:text-slate-600 border-transparent'
              }`} title={order.art_sep_status ? "Separaciones Listas" : "Separaciones Pendientes"}>
              SEP
            </span>

            {/* PL / Packing importado — se enciende cuando la orden tiene el enlace
                del packing sembrado (icono de camion). */}
            <span className={`px-1.5 py-0.5 rounded-full leading-none border transition-all inline-flex items-center ${order.packing_link
              ? 'bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400 border-amber-200/20'
              : 'bg-slate-100/50 text-slate-300 dark:bg-slate-800/40 dark:text-slate-600 border-transparent'
              }`} title={order.packing_link ? `Packing importado${order.packing_link_label ? `: ${order.packing_link_label}` : ''}` : 'Sin packing importado'}
              data-testid={`order-pl-badge-${order.order_id}`}>
              <Truck className="w-2.5 h-2.5" />
            </span>

            {/* ENVÍO programado — reloj + fecha (dd/mm). Se enciende cuando la
                orden está programada en el módulo de Envíos (scheduled_shipments). */}
            {order.order_number && shipMap[order.order_number] !== undefined && (() => {
              const raw = String(shipMap[order.order_number] || '').slice(0, 10);
              const p = raw.split('-');           // [YYYY, MM, DD] sin corrimiento de zona
              const dm = p.length === 3 ? `${p[2]}/${p[1]}` : '';
              return (
                <span
                  className="px-1.5 py-0.5 rounded-full text-[9px] font-extrabold tracking-wide leading-none border inline-flex items-center gap-0.5 bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400 border-sky-200/20"
                  title={raw ? `Programada para envío: ${raw}` : 'Programada para envío'}
                  data-testid={`order-ship-badge-${order.order_id}`}
                >
                  <Clock className="w-2.5 h-2.5" />
                  {dm && <span>{dm}</span>}
                </span>
              );
            })()}
          </div>
        </div>

        {dataColumns.map((col) => {
          const val = order[col.key];
          const width = col.key === 'order_number' ? 220 : (columnWidths[col.key] || col.width);

          // SPECIAL CASE: Progress Bar for Remaining/Progress columns
          const isProgressCol = ['remaining', 'restante', 'progress', 'progreso'].includes(col.key.toLowerCase());

          return (
            <div
              key={col.key}
              className={`py-4 px-3 border-r border-b border-border/5 transition-colors flex items-center ${col.type === 'checkbox' ? 'justify-center' : ''} ${isHighlighted ? (isDark ? 'bg-yellow-900/10' : 'bg-yellow-50/50') : ''} ${rowBgClass}`}
              style={{ width: width, minWidth: width, maxWidth: 'none' }}
            >
              {isProgressCol && typeof val === 'number' ? (
                <div className="w-full flex flex-col gap-1">
                  <div className="flex justify-between items-center mb-0.5">
                    <span className="text-[9px] font-black font-mono text-muted-foreground/70 uppercase">{val} pz</span>
                    <span className="text-[9px] font-black font-mono text-royal">{Math.min(100, Math.round(((order.quantity - val) / order.quantity) * 100 || 0))}%</span>
                  </div>
                  <div className="w-full h-2 bg-muted/30 rounded-full overflow-hidden border border-border/5">
                    <div
                      className="h-full bg-royal transition-[width] duration-500"
                      style={{ width: `${Math.min(100, Math.round(((order.quantity - val) / order.quantity) * 100 || 0))}%` }}
                    />
                  </div>
                </div>
              ) : (
                <EditableCell
                  orderId={order.order_id}
                  field={col.key}
                  value={val}
                  type={col.type}
                  options={col.optionKey ? options[col.optionKey] : []}
                  onUpdate={handleCellUpdate}
                  readOnly={!canEditBoard}
                  isDark={isDark}
                  allOrders={orders}
                  // La orden de ESTA fila. Las celdas de tallas y de posiciones
                  // necesitan otros campos de la misma orden (quantity, la marca
                  // de deducido) y sin esto tendrían que buscarla dentro de
                  // `allOrders`: una pasada por celda sobre las ~1000 órdenes,
                  // en cada render del tablero.
                  order={order}
                  productionSummary={productionSummary}
                  columns={visibleColumns}
                />
              )}
            </div>
          );
        })}

        {/* Action Buttons & Progress Bar */}
        <div className={`py-4 px-4 border-b border-border/5 flex flex-col justify-center gap-2 ${rowBgClass}`} style={{ minWidth: 180 }}>
          {(() => {
            const prodData = productionSummary[order.order_number] || { total_produced: 0 };
            const total = order.quantity || 0;
            const produced = prodData.total_produced || 0;
            const progress = total > 0 ? Math.min(100, (produced / total) * 100) : 0;
            const remainingPieces = Math.max(0, total - produced);

            return (
              <>
                <div className="flex justify-between items-center mb-0.5">
                  <span className={`text-[10px] font-black font-mono ${remainingPieces === 0 ? 'text-green-500' : 'text-muted-foreground'}`}>
                    {remainingPieces} {t('pieces_unit')} {t('remaining_short')}
                  </span>
                  <span className={`text-[10px] font-black font-mono ${progress >= 100 ? 'text-green-500' : 'text-primary'}`}>
                    {Math.round(progress)}%
                  </span>
                </div>

                <div className="w-full h-2 bg-secondary rounded-full overflow-hidden border border-border/5 relative group/progress">
                  <div
                    className={`h-full transition-[width] duration-700 ease-out ${progress >= 100 ? 'bg-green-500' :
                      progress >= 50 ? 'bg-amber-500' :
                        'bg-red-500'
                      }`}
                    style={{ width: `${progress}%` }}
                  />
                  {/* Tooltip on hover */}
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/progress:opacity-100 transition-opacity bg-black/20 text-[8px] text-white font-bold uppercase tracking-tighter">
                    {produced} / {total}
                  </div>
                </div>
              </>
            );
          })()}
        </div>

        {/* Avance Neck — solo porcentaje (compacto) */}
        <div className={`py-4 px-3 border-b border-border/5 flex flex-col items-center justify-center ${rowBgClass}`} style={{ minWidth: 110 }} data-testid={`row-restante-neck-${order.order_id}`}>
          {(() => {
            const neckData = neckSummary?.[order.order_number] || { total_neck_cut: 0 };
            const total = order.quantity || 0;
            const neckCut = neckData.total_neck_cut || 0;
            const neckPct = total > 0 ? Math.min(100, Math.round((neckCut / total) * 100)) : 0;
            const color = neckPct >= 100 ? 'text-green-500' : neckPct >= 50 ? 'text-amber-500' : 'text-pink-500';
            return (
              <span className={`text-sm font-black font-mono ${color}`} title={`Neck: ${neckCut} / ${total} pz`}>
                {neckPct}%
              </span>
            );
          })()}
        </div>
      </React.Fragment>
    );
  }, [debouncedSearchQuery, selectedOrders, isDark, currentBoard, highlightedOrderId, handleCellUpdate, options, isAdmin, t, visibleColumns, dataColumns, columnWidths, handleBulkMove, productionSummary, neckSummary]);


  const renderMobileOrderCard = (order) => {
    const isSelected = selectedOrders.includes(order.order_id);
    const prodData = productionSummary[order.order_number] || { total_produced: 0 };
    const total = order.quantity || 0;
    const produced = prodData.total_produced || 0;
    const progress = total > 0 ? Math.min(100, (produced / total) * 100) : 0;
    const remainingPieces = Math.max(0, total - produced);
    const done = total > 0 && remainingPieces === 0;
    // Accent + progress color reflect the production state at a glance.
    const accent = done ? 'bg-green-500' : progress > 0 ? 'bg-amber-500' : 'bg-royal';
    const factCols = visibleColumns
      .filter(c => !['order_number', 'art_sep_status', 'art_neck_status', 'selection', 'client'].includes(c.key))
      .slice(0, 5);

    return (
      <div
        key={order.order_id}
        onClick={() => setDetailsOrder(order)}
        className={`relative mx-3 mb-2.5 rounded-2xl border overflow-hidden active:scale-[0.99] transition-transform ${isSelected ? 'border-royal/60 ring-1 ring-royal/40' : isDark ? 'border-white/5' : 'border-gray-100'} ${isDark ? 'bg-navy-light/40' : 'bg-white shadow-sm'}`}
      >
        {/* Status accent bar */}
        <div className={`absolute left-0 top-0 bottom-0 w-1 ${accent}`} />

        <div className="p-4 pl-5">
          {/* Header: order # + client, comment + select */}
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <div className="text-[22px] font-black tracking-tighter leading-none">#{order.order_number}</div>
              <div className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-widest mt-1 truncate">{order.client || '—'}</div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); setCommentsOrder(order); }}
                className="relative p-2.5 rounded-xl bg-muted/20 text-muted-foreground active:bg-muted/40 transition-colors"
                aria-label="Comentarios"
              >
                <MessageSquare className="w-4 h-4" />
                {order._comments_count > 0 && <span className="absolute top-1 right-1 w-2 h-2 bg-royal rounded-full" />}
              </button>
              <input
                type="checkbox"
                checked={isSelected}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { e.stopPropagation(); toggleOrderSelection(order.order_id); }}
                className="w-5 h-5 rounded border-border accent-primary"
              />
            </div>
          </div>

          {/* Chips: art + scheduled day + board */}
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <span className={`px-2 py-0.5 rounded-md text-[9px] font-black border tracking-wider ${order.art_sep_status ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-secondary/40 text-muted-foreground/40 border-transparent'}`}>SEP</span>
            <span className={`px-2 py-0.5 rounded-md text-[9px] font-black border tracking-wider ${order.art_neck_status ? 'bg-blue-500/10 text-blue-500 border-blue-500/20' : 'bg-secondary/40 text-muted-foreground/40 border-transparent'}`}>NECK</span>
            {order.scheduled_day && (
              <span className="px-2 py-0.5 rounded-md text-[9px] font-bold bg-sky-500/10 text-sky-500 border border-sky-500/20 uppercase tracking-wider">{order.scheduled_day}</span>
            )}
            <span className="ml-auto flex items-center gap-1 text-[9px] font-bold text-muted-foreground/40 uppercase tracking-widest max-w-[45%]">
              {order.packing_link && <Truck className="w-3 h-3 text-emerald-500 flex-shrink-0" title="Packing importado" />}
              <span className="truncate">{order.board}</span>
            </span>
          </div>

          {/* Quick facts — read-only for speed (tap the card to edit in detail).
              Inline EditableCell here meant ~5 heavy components per card × many
              cards, which made the mobile list laggy. */}
          <div className={`rounded-xl overflow-hidden divide-y ${isDark ? 'bg-black/15 divide-white/5' : 'bg-gray-50/70 divide-gray-100'}`}>
            {factCols.map(col => (
              <div key={col.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="text-[10px] font-bold text-muted-foreground/50 uppercase tracking-widest whitespace-nowrap">{col.label}</span>
                <div className="text-sm font-bold truncate text-right max-w-[60%]">
                  {renderDetailValue(order[col.key])}
                </div>
              </div>
            ))}
          </div>

          {/* Production progress */}
          <div className="mt-3">
            <div className="flex justify-between items-center mb-1.5">
              <span className={`text-[10px] font-black uppercase tracking-wide ${done ? 'text-green-500' : 'text-muted-foreground/60'}`}>
                {done ? t('completed') || 'Completado' : `${remainingPieces.toLocaleString()} ${t('pieces_unit')} ${t('remaining_short')}`}
              </span>
              <span className={`text-[11px] font-black ${done ? 'text-green-500' : 'text-primary'}`}>{Math.round(progress)}%</span>
            </div>
            <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-700 ${done ? 'bg-green-500' : 'bg-primary'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  };


  const renderTableBody = () => {
    const _allOrders = (orders && Array.isArray(orders) ? orders : []);
    // Estilo para congelar una cabecera de grupo bajo el encabezado de columnas.
    // z por ENCIMA de las celdas sticky de las filas (z-30) y por DEBAJO de las
    // del encabezado de columnas (z-50); fondo opaco para tapar lo que scrollea.
    const freezeBg = isDark ? 'hsl(220, 30%, 9%)' : '#ffffff';
    const freezeSticky = (topPx, z) => ({ position: 'sticky', top: `${topPx}px`, zIndex: z, background: freezeBg });
    // While searching, render only the matches (small set) instead of all
    // displayLimit rows — this is what made search laggy on iPad.
    // Los tableros con grupos por día se renderizan COMPLETOS (son los
    // operativos, chicos): recortarlos haría mentir los conteos "(N)" de cada
    // día. El recorte con "Cargar más" aplica a los planos grandes (MASTER).
    const visibleOrders = debouncedSearchQuery
      ? _allOrders.filter(matchesSearch).slice(0, 500)
      : (isDaySupportedBoard(currentBoard) && !groupByDate)
        ? _allOrders
        : _allOrders.slice(0, displayLimit);

    if (isMobile) {
      return (
        <div className="flex flex-col pb-24">
          {/* Encabezado de tablero — siempre visible, indica dónde estás y deja cambiar */}
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="sticky top-0 z-20 flex items-center justify-between gap-2 px-4 py-2.5 bg-background border-b border-border/60"
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className="w-1.5 h-5 rounded-full bg-royal flex-shrink-0" />
              <span className="text-base font-black uppercase tracking-tight truncate">{currentBoard}</span>
            </span>
            <span className="flex items-center gap-1 text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex-shrink-0">
              {visibleOrders.length} órd · cambiar <ChevronDown className="w-4 h-4" />
            </span>
          </button>
          <div className="pt-2">
            {visibleOrders.slice(0, mobileLimit).map(renderMobileOrderCard)}
          </div>
          {visibleOrders.length > mobileLimit && (
            <button
              onClick={() => setMobileLimit(n => n + 50)}
              className="mx-3 mt-2 mb-1 py-3 rounded-2xl border border-border bg-card/60 text-sm font-bold text-primary active:scale-[0.99] transition-transform"
            >
              Cargar más ({visibleOrders.length - mobileLimit} restantes)
            </button>
          )}
        </div>
      );
    }

    // ── Day-supported boards: group rows by day, with queue nesting on queue-supported boards ──
    // queue_status defaults to "active" for orders that don't carry the field
    // yet (legacy + freshly-moved before the schema change). Same for
    // scheduled_day: orders with no value defensively show up under today.
    if (isDaySupportedBoard(currentBoard) && !groupByDate) {
      const showQueueSplit = isQueueSupportedBoard(currentBoard);

      // Render a generic collapsible section. Always rendered — even when
      // empty — so the day tabs are visible at all times on day-supported
      // boards, giving the user obvious drop targets. Empty groups still
      // show their count (0) and a muted style.
      const renderSection = (key, label, list, icon, tone, level = 0) => {
        const isCollapsed = !!collapsedGroups[key];
        const isEmpty = list.length === 0;
        const totalQty = list.reduce((sum, o) => sum + (Number(o.quantity) || 0), 0);
        const pad = level === 0 ? 'px-4' : 'pl-10 pr-4';
        return (
          <React.Fragment key={key}>
            <div
              style={{ gridColumn: '1 / -1', ...freezeSticky(level >= 1 ? freezeTops.col + freezeTops.queue : freezeTops.col, 40) }}
              className={`py-0 px-0 border-b ${tone.bar} ${isEmpty ? 'opacity-60' : ''}`}
              data-testid={`group-${key}`}
            >
              <button
                onClick={() => setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }))}
                disabled={isEmpty}
                className={`w-full flex items-center py-0 text-left font-roboto font-bold ${level === 0 ? 'text-sm uppercase tracking-wide' : 'text-xs uppercase tracking-widest'} transition-colors ${tone.text} ${isEmpty ? 'cursor-default' : ''}`}
              >
                {/* La etiqueta se fija a la IZQUIERDA (sticky left-0) para seguir
                    visible al scrollear en horizontal. */}
                <span className={`sticky left-0 inline-flex items-center gap-2 py-2 ${pad}`} style={{ background: freezeBg }}>
                  <ChevronDown className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${isCollapsed || isEmpty ? '-rotate-90' : ''} ${isEmpty ? 'opacity-30' : ''}`} />
                  {icon && <span className="text-base">{icon}</span>}
                  <span>{label}</span>
                  <span className="font-normal text-[10px] text-muted-foreground ml-1">({list.length})</span>
                  {totalQty > 0 && (
                    <span className={`font-mono text-[10px] ml-2 px-2 py-0.5 rounded ${tone.badge}`}>
                      {totalQty.toLocaleString()} pcs
                    </span>
                  )}
                </span>
              </button>
            </div>
            {!isCollapsed && !isEmpty && list.map(renderOrderRow)}
          </React.Fragment>
        );
      };

      // Bucket orders by scheduled_day → returns ordered [{key, label, list}].
      // ALL weekday buckets are returned (Mon..Sun) so the headers are
      // permanently visible on the board even when a day has zero orders.
      // "Sin día" was removed: every order on a day-supported board now
      // carries a scheduled_day (migration + backend default-to-today).
      const bucketByDay = (orders) => {
        const buckets = {};
        DAY_KEYS.forEach(d => { buckets[d] = []; });
        const todayKey = WEEKDAY_KEYS[new Date().getDay()];
        orders.forEach(o => {
          const d = o.scheduled_day;
          if (d && DAY_KEYS.includes(d)) buckets[d].push(o);
          else buckets[todayKey].push(o); // Defensive: fall back to today
        });
        return DAY_KEYS.map(d => ({ key: d, label: dayLabel(d), list: buckets[d] }));
      };

      // Minimalista: fondo neutro y color SOLO en el texto — la semántica
      // (azul=día, verde=activa, ámbar=cola) se conserva sin pintar bandas
      // completas. El hover sigue dando feedback en gris neutro.
      const dayTone = isDark
        ? { bar: 'bg-transparent border-border/40', text: 'text-sky-300/90 hover:bg-muted/20', badge: 'text-sky-300/70' }
        : { bar: 'bg-transparent border-border/60', text: 'text-sky-700 hover:bg-muted/40', badge: 'text-sky-600/70' };
      const noDayTone = isDark
        ? { bar: 'bg-transparent border-border/40', text: 'text-muted-foreground hover:bg-muted/20', badge: 'text-muted-foreground/70' }
        : { bar: 'bg-transparent border-border/60', text: 'text-gray-600 hover:bg-muted/40', badge: 'text-gray-500' };

      if (showQueueSplit) {
        // Outer: queue_status (Activa / En Cola). Inner: day-of-week.
        const activeOrders = visibleOrders.filter(o => (o.queue_status || 'active') === 'active');
        const queuedOrders = visibleOrders.filter(o => o.queue_status === 'queued');
        const queueTones = {
          active: isDark
            ? { bar: 'bg-transparent border-border/40', text: 'text-emerald-300 hover:bg-muted/20', badge: 'text-emerald-300/70' }
            : { bar: 'bg-transparent border-border/60', text: 'text-emerald-700 hover:bg-muted/40', badge: 'text-emerald-600/70' },
          queued: isDark
            ? { bar: 'bg-transparent border-border/40', text: 'text-amber-300 hover:bg-muted/20', badge: 'text-amber-300/70' }
            : { bar: 'bg-transparent border-border/60', text: 'text-amber-700 hover:bg-muted/40', badge: 'text-amber-600/70' },
        };
        const renderQueueGroup = (queueKey, queueLabel, queueList, queueIcon, queueTone) => {
          // Keep the legacy "__machine_*" prefix so already-collapsed state
          // by users on machines stays remembered. BLANKS / NECK share it.
          const queueGroupKey = `__machine_${queueKey}`;
          const isQueueCollapsed = !!collapsedGroups[queueGroupKey];
          const queueTotalQty = queueList.reduce((s, o) => s + (Number(o.quantity) || 0), 0);
          const isQueueEmpty = queueList.length === 0;
          return (
            <React.Fragment key={queueGroupKey}>
              <div
                ref={queueKey === 'active' ? queueHeadRef : undefined}
                style={{ gridColumn: '1 / -1', ...freezeSticky(freezeTops.col, 42) }}
                className={`py-0 px-0 border-b ${queueTone.bar} ${isQueueEmpty ? 'opacity-70' : ''}`}
                data-testid={`queue-group-${queueKey}`}
              >
                <button
                  onClick={() => setCollapsedGroups(prev => ({ ...prev, [queueGroupKey]: !prev[queueGroupKey] }))}
                  className={`w-full flex items-center py-0 text-left font-roboto font-bold text-sm uppercase tracking-wide transition-colors ${queueTone.text}`}
                >
                  <span className="sticky left-0 inline-flex items-center gap-2 py-2 px-4" style={{ background: freezeBg }}>
                    <ChevronDown className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${isQueueCollapsed ? '-rotate-90' : ''}`} />
                    <span className="text-base">{queueIcon}</span>
                    <span>{queueLabel}</span>
                    <span className="font-normal text-xs text-muted-foreground ml-1">({queueList.length})</span>
                    {queueTotalQty > 0 && (
                      <span className={`font-mono text-xs ml-2 px-2 py-0.5 rounded ${queueTone.badge}`}>
                        {queueTotalQty.toLocaleString()} pcs
                      </span>
                    )}
                  </span>
                </button>
              </div>
              {/* "En Cola" is intentionally flat — the queue is a single
                  waiting list, no need to split by day. "Activa" still gets
                  the per-day breakdown so the floor can plan the week. */}
              {!isQueueCollapsed && queueKey === 'active' && bucketByDay(queueList).map(bucket =>
                renderSection(`__${queueKey}_${bucket.key}`, bucket.label, bucket.list, null, bucket.key === 'none' ? noDayTone : dayTone, 1)
              )}
              {!isQueueCollapsed && queueKey !== 'active' && queueList.map(renderOrderRow)}
            </React.Fragment>
          );
        };
        return (
          <>
            {renderQueueGroup('active', 'Activa', activeOrders, '▶', queueTones.active)}
            {renderQueueGroup('queued', 'En Cola', queuedOrders, '⏸', queueTones.queued)}
          </>
        );
      }

      // Non-machine day-supported boards: just bucket by day.
      return bucketByDay(visibleOrders).map(bucket =>
        renderSection(`__day_${bucket.key}`, bucket.label, bucket.list, null, bucket.key === 'none' ? noDayTone : dayTone, 0)
      );
    }

    if (!groupByDate) return visibleOrders.map(renderOrderRow);
    const groups = {};
    const isDateField = groupByDate === 'cancel_date' || columns.find(c => c.key === groupByDate)?.type === 'date';
    const groupLabelMap = {
      cancel_date: 'Cancel Date',
      client: lang === 'es' ? 'Cliente' : 'Client',
      priority: lang === 'es' ? 'Prioridad' : 'Priority',
    };
    const noValueLabel = isDateField ? (lang === 'es' ? 'Sin fecha' : 'No date') : (lang === 'es' ? 'Sin asignar' : 'None');
    visibleOrders.forEach(o => {
      const raw = o[groupByDate];
      const groupKey = isDateField ? (raw ? new Date(raw).toLocaleDateString() : noValueLabel) : (raw || noValueLabel);
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
      const totalQty = groupOrders.reduce((sum, o) => sum + (Number(o.quantity) || 0), 0);
      return (
        <React.Fragment key={dateKey}>
          <div style={{ gridColumn: '1 / -1', ...freezeSticky(freezeTops.col, 42) }} className={`py-0 px-0 border-b ${isDark ? 'border-border/40' : 'border-border/60'}`} data-testid={`date-group-${dateKey}`}>
            <button onClick={() => setCollapsedGroups(prev => ({ ...prev, [dateKey]: !prev[dateKey] }))} className={`w-full flex items-center py-0 text-left font-roboto font-bold text-sm uppercase tracking-wide transition-colors ${isDark ? 'text-primary hover:bg-muted/20' : 'text-blue-700 hover:bg-muted/40'}`}>
              <span className="sticky left-0 inline-flex items-center gap-2 py-2 px-4" style={{ background: freezeBg }}>
                <ChevronDown className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`} />
                <CalendarDays className="w-4 h-4 flex-shrink-0 -mt-0.5" />
                {groupLabelMap[groupByDate] || groupByDate}: <span className="font-mono ml-1">{dateKey}</span>
                <span className="font-normal text-xs text-muted-foreground ml-1">({groupOrders.length})</span>
                <span className={`font-mono text-xs ml-2 ${isDark ? 'text-primary/70' : 'text-blue-600/70'}`}>
                  {totalQty.toLocaleString()} pcs
                </span>
              </span>
            </button>
          </div>
          {!isCollapsed && groupOrders.map(renderOrderRow)}
        </React.Fragment>
      );
    });
  };

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden border-none bg-background">
      <Sidebar
        isCollapsed={isSidebarCollapsed}
        setIsCollapsed={setIsSidebarCollapsed}
        currentBoard={currentBoard}
        setCurrentBoard={setCurrentBoard}
        boards={activeBoards}
        trashCount={trashCount}
        onShowTrash={() => setShowTrash(true)}
        onShowAnalytics={() => setShowAnalytics(true)}
        isAdmin={isAdmin}
        userRole={user?.role}
        navigate={navigate}
        isDark={isDark}
        isMobile={isMobile || isTablet}
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        showTrash={showTrash}
        showAnalytics={showAnalytics}
      />

      <div className={`relative flex-1 flex flex-col overflow-hidden transition-colors duration-300`}>
        <Toaster position="bottom-right" theme={isDark ? "dark" : "light"} />
        <LoadingOverlay isLoading={operationLoading} message={t('processing')} />

        {/* Header - Cleaned up version */}
      <header className="h-16 px-4 flex items-center justify-between z-40 bg-card text-card-foreground border-b border-border shadow-sm">
        {(isMobile || isTablet) && (
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="p-2 mr-2 hover:bg-muted/40 rounded-lg transition-all"
          >
            <Menu className="w-6 h-6 text-muted-foreground" />
          </button>
        )}
        <div className="flex items-center gap-4 flex-1">
          <SearchBox
            ref={searchInputRef}
            onDebouncedChange={handleSearchDebounced}
            onEnter={handleSearchEnter}
            clearToken={searchClearToken}
            placeholder={isMobile ? 'Buscar...' : t('search_placeholder')}
            isMobile={isMobile}
          />
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

        <div className="flex items-center gap-4 text-card-foreground">
          {/* Quick Actions */}
          <div className="flex items-center gap-1">
            <button onClick={toggleTheme} className="p-2 rounded hover:bg-muted/50 transition-all text-muted-foreground hover:text-foreground" title={isDark ? t('light_mode') : t('dark_mode')}>
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            {!isMobile && <button onClick={() => window.location.href = '/wms'} title="WMS" className="p-2 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-all"><Warehouse className="w-4 h-4" /></button>}
            {!isMobile && <button onClick={toggleLang} className="p-2 rounded hover:bg-muted/50 text-[10px] font-bold flex items-center gap-1 text-muted-foreground hover:text-foreground">
              <Languages className="w-4 h-4" /> {lang === 'es' ? 'EN' : 'ES'}
            </button>}
            <div className="relative">
              <button
                data-testid="notifications-btn"
                onClick={() => { setShowNotifications(!showNotifications); if (!showNotifications && unreadCount > 0) markNotificationsRead(); }}
                className={cn("p-2 rounded hover:bg-muted/50 relative transition-colors text-muted-foreground hover:text-foreground", showNotifications && "bg-muted text-foreground")}
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
                              <span className="text-[9px] text-muted-foreground ml-2 font-medium">{n.created_at ? new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Ahora'}</span>
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
      <div className="px-6 py-4 flex flex-col gap-4 z-30 transition-all bg-card border-b border-border shadow-sm">
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
            <div className="text-[2.5rem] mt-[-4px] font-black font-barlow-semi tracking-tighter uppercase text-muted-foreground/15 pointer-events-none select-none whitespace-nowrap leading-none ml-2">
              {currentBoard}
            </div>

          </div>

          {/* Top-right action buttons */}
          <div className="flex items-center gap-2 self-center">
            {currentBoard === 'SCHEDULING' && canSweepBlanks && (
              <button
                onClick={toggleBlanksSweep}
                title={blanksSweep?.enabled
                  ? `Barrido automático a BLANKS: ENCENDIDO (cada ${blanksSweep?.sweep_minutes || 10} min). Click para apagar.`
                  : 'Barrido automático a BLANKS: APAGADO. Click para encender.'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold text-[10px] uppercase tracking-[0.15em] shadow-md transition-all whitespace-nowrap ${blanksSweep?.enabled ? 'bg-amber-500 text-white shadow-amber-500/20 hover:bg-amber-400' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}
                data-testid="blanks-sweep-toggle"
              >
                <span className={`inline-block w-2 h-2 rounded-full ${blanksSweep?.enabled ? 'bg-white animate-pulse' : 'bg-muted-foreground/50'}`} />
                Auto→Blanks {blanksSweep?.enabled ? 'ON' : 'OFF'}
              </button>
            )}
            {currentBoard === 'SCHEDULING' && (
              <button onClick={() => setShowNewOrder(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-royal text-white rounded-lg font-bold text-[10px] uppercase tracking-[0.15em] shadow-md shadow-royal/20 hover:bg-royal/90 hover:scale-[1.02] active:scale-[0.98] transition-all whitespace-nowrap">
                <Plus className="w-3.5 h-3.5" />
                Nueva Orden
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title="Captura"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-bold text-[10px] uppercase tracking-[0.15em] shadow-sm shadow-emerald-600/10 hover:bg-emerald-500 transition-all whitespace-nowrap"
                  data-testid="captura-trigger"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  Captura
                  <ChevronDown className="w-3 h-3 opacity-80" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem
                  onClick={() => { setShowProduction(true); fetchAllOrders(); }}
                  className="text-[11px] font-bold uppercase tracking-[0.15em] cursor-pointer"
                  data-testid="captura-prd"
                >
                  <Factory className="w-3.5 h-3.5 mr-2 text-emerald-500" />
                  Captura PRD
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => { setShowNeckCapture(true); fetchAllOrders(); }}
                  className="text-[11px] font-bold uppercase tracking-[0.15em] cursor-pointer"
                  data-testid="captura-neck"
                >
                  <Scissors className="w-3.5 h-3.5 mr-2 text-pink-500" />
                  Captura Neck
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setShowProductionScreen(true)}
                  className="text-[11px] font-bold uppercase tracking-[0.15em] cursor-pointer"
                  data-testid="herramientas-tv"
                >
                  <Monitor className="w-3.5 h-3.5 mr-2 text-emerald-500" />
                  TV
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setShowCapacityPlan(true)}
                  className="text-[11px] font-bold uppercase tracking-[0.15em] cursor-pointer"
                  data-testid="herramientas-plan"
                >
                  <TrendingUp className="w-3.5 h-3.5 mr-2 text-royal" />
                  Plan
                </DropdownMenuItem>
                {/* Reporte de lo pintado en un rango. Sale de production_logs
                    y agrupa por número de orden, así que una orden con varias
                    capturas es UN renglón. Abre modal porque necesita las dos
                    fechas antes de generar. */}
                <DropdownMenuItem
                  onClick={() => setShowPrintedReport(true)}
                  className="text-[11px] font-bold uppercase tracking-[0.15em] cursor-pointer"
                  data-testid="herramientas-pintadas"
                >
                  <FileDown className="w-3.5 h-3.5 mr-2 text-amber-500" />
                  Órdenes pintadas
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Selector de columnas. El rótulo cambia según a quién afecta lo que
          hagas aquí, porque no es lo mismo recortar tu pantalla que quitarle
          una columna a todo el mundo. */}
      {showColumnPicker && canArrangeColumns && (
        <div className={`border-b px-6 py-4 transition-all animate-in slide-in-from-top-2 duration-300 ${isDark ? 'bg-navy/40 border-white/5' : 'bg-muted/30 border-gray-100'}`} data-testid="column-picker">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-royal" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {arrangesGlobally ? 'Columnas del sistema' : 'Mis columnas visibles'}
              </span>
              <span className="text-[10px] text-muted-foreground/60 italic normal-case tracking-normal">
                {arrangesGlobally
                  ? '— lo que ocultes aquí deja de verlo todo el mundo'
                  : '— solo afecta tu vista, no cambia la configuración global'}
              </span>
            </div>
            <button onClick={() => setShowColumnPicker(false)} className="p-1 hover:bg-muted rounded-full transition-colors"><X size={16} /></button>
          </div>
          <div className="flex flex-wrap gap-2">
            {columns
              .filter(c => arrangesGlobally || !globalHidden.includes(c.key))
              .map(col => {
                const isHidden = arrangesGlobally
                  ? globalHidden.includes(col.key)
                  : (hiddenColumns[currentBoard] || []).includes(col.key);
                const fija = COLUMNAS_FIJAS.includes(col.key);
                return (
                  <button
                    key={col.key}
                    onClick={() => handleToggleColumn(col.key)}
                    data-testid={`col-toggle-${col.key}`}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-sm border transition-all text-xs font-bold",
                      fija && "opacity-50 cursor-not-allowed",
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
              {/* Agregar columna toca el set GLOBAL: solo supersu (el backend lo exige). */}
              {isSuperAdmin && <button onClick={() => setShowAddColumn(true)} title="Agregar Columna" className="p-2.5 rounded-lg hover:bg-royal/10 text-royal transition-all"><PlusCircle size={18} /></button>}
              {canArrangeColumns && (
                <button
                  onClick={() => setShowColumnPicker(v => !v)}
                  title={arrangesGlobally ? 'Mostrar u ocultar columnas (para todos)' : 'Mostrar u ocultar columnas (solo tu vista)'}
                  className="p-2.5 rounded-lg hover:bg-royal/10 text-muted-foreground hover:text-royal transition-all"
                  data-testid="toggle-column-picker"
                >
                  <Table2 size={18} />
                  <span className="sr-only">Columnas visibles</span>
                </button>
              )}

              {/* Solo aparece cuando este usuario YA movió columnas en este
                  tablero: es la forma de volver al orden que ven los demás. */}
              {hasPersonalOrder && personalOrder[currentBoard]?.length > 0 && (
                <button onClick={handleResetColumnOrder} title="Restablecer columnas al orden global" className="p-2.5 rounded-lg hover:bg-royal/10 text-royal transition-all" data-testid="reset-column-order">
                  <Undo2 size={18} />
                </button>
              )}

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
              <button onClick={() => setShowSeedLink(true)} title="Sembrar enlace de packing en órdenes" className="p-2.5 rounded-lg hover:bg-indigo-600/10 text-indigo-500 transition-all" data-testid="open-seed-link"><Link2 size={18} /></button>
            </div>
          )}


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
              {/* Quick queue toggles — on every queue-supported board (machines +
                  BLANKS + NECK). One click moves the selected orders to "Activa" or
                  "A Cola" on the SAME board without touching the multi-level
                  Move-to menu. */}
              {isQueueSupportedBoard(currentBoard) && (
                <div className="flex items-center gap-1.5 border-r border-border pr-2 md:pr-3">
                  <button
                    onClick={() => handleBulkMoveWithLockCheck(selectedOrders, currentBoard, () => setSelectedOrders([]), 'active')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30"
                    title={`Mover a Activa en ${currentBoard}`}
                    data-testid="quick-to-active"
                  >
                    <span className="text-sm leading-none">▶</span>
                    <span className="hidden sm:inline">A Activa</span>
                    <span className="sm:hidden">Activa</span>
                  </button>
                  <button
                    onClick={() => handleBulkMoveWithLockCheck(selectedOrders, currentBoard, () => setSelectedOrders([]), 'queued')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 border border-amber-500/30"
                    title={`Mover a En Cola en ${currentBoard}`}
                    data-testid="quick-to-queued"
                  >
                    <span className="text-sm leading-none">⏸</span>
                    <span className="hidden sm:inline">A Cola</span>
                    <span className="sm:hidden">Cola</span>
                  </button>
                </div>
              )}

              {/* Day-of-week chips — visible on every day-supported board (machines
                  + R.T.S. / BLANKS / SCREENS / NECK). One click sets scheduled_day
                  on the selected orders without touching their board or queue. */}
              {isDaySupportedBoard(currentBoard) && (
                <div className="flex items-center gap-1 border-r border-border pr-2 md:pr-3 flex-wrap" data-testid="day-chips">
                  {DAY_KEYS.map(d => (
                    <button
                      key={d}
                      onClick={() => handleBulkMoveWithLockCheck(selectedOrders, currentBoard, () => setSelectedOrders([]), null, d)}
                      className="px-2.5 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wide transition-all bg-sky-500/15 text-sky-600 dark:text-sky-400 hover:bg-sky-500/25 border border-sky-500/30"
                      title={dayLabel(d)}
                    >
                      {DAY_SHORT[d]}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase font-bold opacity-50 hidden sm:inline">{t('move_to')}:</span>
                <DropdownMenu>
                  <DropdownMenuTrigger className={`min-w-[120px] md:w-48 h-9 md:h-10 flex items-center justify-between px-3 md:px-4 text-xs md:text-sm font-bold rounded-lg md:rounded-xl border bg-secondary/50 border-border text-foreground hover:bg-secondary`} data-testid="bulk-move-select">
                    <span className="truncate mr-1 md:mr-2">{t('move_to')}</span>
                    <ChevronDown className="w-4 h-4 md:w-5 md:h-5 opacity-70" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className={`z-[200] min-w-[220px] shadow-2xl bg-popover border-border`}>
                    {allBoardsIncludingHidden.filter(b => b !== currentBoard && b !== 'PAPELERA DE RECICLAJE' && !b.startsWith('MAQUINA')).map(board => {
                      // Queue-supported non-machine boards (BLANKS, NECK) follow
                      // the machine UX: pick Activa (then a day) or A Cola here.
                      // A Cola is intentionally flat — no day breakdown there.
                      if (QUEUE_SUPPORTED_NON_MACHINE.has(board)) {
                        return (
                          <DropdownMenuSub key={board}>
                            <DropdownMenuSubTrigger className="flex items-center justify-between py-3.5 px-5 font-bold cursor-pointer text-sm md:text-base tracking-tight">
                              <span>{board}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="z-[302] min-w-[160px] shadow-2xl">
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger className="flex items-center justify-between py-3 px-5 font-bold cursor-pointer text-sm tracking-tight text-emerald-600 dark:text-emerald-400">
                                  <span>▶ Activa</span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="z-[303] min-w-[140px] shadow-2xl">
                                  {DAY_KEYS.map(d => (
                                    <DropdownMenuItem
                                      key={d}
                                      onClick={() => handleBulkMoveWithLockCheck(selectedOrders, board, () => setSelectedOrders([]), 'active', d)}
                                      className="font-bold py-2.5 px-4 text-sm tracking-tight"
                                    >
                                      {dayLabel(d)}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                              <DropdownMenuItem
                                onClick={() => handleBulkMoveWithLockCheck(selectedOrders, board, () => setSelectedOrders([]), 'queued')}
                                className="font-bold py-3 px-5 text-sm tracking-tight text-amber-600 dark:text-amber-400"
                              >
                                ⏸ A Cola
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        );
                      }
                      // Day-supported non-machine non-queue boards
                      // (READY TO SCHEDULED, SCREENS) expand into a sub-menu so
                      // the user can pick the weekday at the same time as the move.
                      if (DAY_SUPPORTED_NON_MACHINE.has(board)) {
                        return (
                          <DropdownMenuSub key={board}>
                            <DropdownMenuSubTrigger className="flex items-center justify-between py-3.5 px-5 font-bold cursor-pointer text-sm md:text-base tracking-tight">
                              <span>{board}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="z-[301] min-w-[180px] shadow-2xl">
                              {DAY_KEYS.map(d => (
                                <DropdownMenuItem
                                  key={d}
                                  onClick={() => handleBulkMoveWithLockCheck(selectedOrders, board, () => setSelectedOrders([]), null, d)}
                                  className="font-bold py-3 px-5 text-sm tracking-tight"
                                >
                                  {dayLabel(d)}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        );
                      }
                      return (
                        <DropdownMenuItem key={board} onClick={() => handleBulkMoveWithLockCheck(selectedOrders, board, () => setSelectedOrders([]))} className="font-bold py-3.5 px-5 text-sm md:text-base tracking-tight">
                          {board}
                        </DropdownMenuItem>
                      );
                    })}
                    <DropdownMenuSeparator className="opacity-50" />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="flex items-center justify-between py-3.5 px-5 font-bold text-primary cursor-pointer text-sm md:text-base">
                        <div className="flex items-center gap-2.5">
                          <Monitor className="w-5 h-5" />
                          <span>MAQUINAS</span>
                        </div>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="z-[301] min-w-[200px] shadow-2xl">
                        {/* Show every machine — including the current one — so users can
                            flip queue_status (Activa ↔ A Cola) without having to leave the
                            board and come back. */}
                        {allBoardsIncludingHidden.filter(b => b !== 'PAPELERA DE RECICLAJE' && b.startsWith('MAQUINA')).map(board => (
                          <DropdownMenuSub key={board}>
                            <DropdownMenuSubTrigger className={`flex items-center justify-between py-3.5 px-5 font-bold cursor-pointer text-sm md:text-base tracking-tight ${board === currentBoard ? 'text-primary' : ''}`}>
                              <span>{board}{board === currentBoard ? ' (actual)' : ''}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="z-[302] min-w-[160px] shadow-2xl">
                              {/* Activa expands into a weekday picker — same as BLANKS/NECK. */}
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger className="flex items-center justify-between py-3 px-5 font-bold cursor-pointer text-sm tracking-tight text-emerald-600 dark:text-emerald-400">
                                  <span>▶ Activa</span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="z-[303] min-w-[140px] shadow-2xl">
                                  {DAY_KEYS.map(d => (
                                    <DropdownMenuItem
                                      key={d}
                                      onClick={() => handleBulkMoveWithLockCheck(selectedOrders, board, () => setSelectedOrders([]), 'active', d)}
                                      className="font-bold py-2.5 px-4 text-sm tracking-tight"
                                    >
                                      {dayLabel(d)}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                              <DropdownMenuItem
                                onClick={() => handleBulkMoveWithLockCheck(selectedOrders, board, () => setSelectedOrders([]), 'queued')}
                                className="font-bold py-3 px-5 text-sm tracking-tight text-amber-600 dark:text-amber-400"
                              >
                                ⏸ A Cola
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
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
      <main className={cn(
        "flex-1 overflow-auto relative isolation-isolate",
        (isMobile || isTablet) && detailsOrder && "hidden"
      )}>
        {loading && !orders.length && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {loading && orders.length > 0 && (
          <div className="absolute inset-0 z-[100] flex items-center justify-center bg-background/20 backdrop-blur-[1px] pointer-events-none">
            <div className="bg-card p-3 rounded-full shadow-2xl border border-border animate-bounce">
              <RefreshCw className="w-6 h-6 animate-spin text-primary" />
            </div>
          </div>
        )}

        {(calendarMode && (currentBoard === 'SCHEDULING' || currentBoard === 'EJEMPLOS')) ? <CalendarView orders={orders} allOrders={allOrders} isDark={isDark} fetchOrders={fetchOrders} handleBulkMove={handleBulkMove} columns={columns} /> :
          readyCalendarMode && currentBoard === 'SCHEDULING' ? <CalendarView orders={readyOrders} allOrders={allOrders} isDark={isDark} fetchOrders={fetchOrders} handleBulkMove={handleBulkMove} columns={columns} label="Ready To Scheduled" /> :
            blanksTrackingMode && currentBoard === 'SCHEDULING' ? <BlanksTrackingView orders={blanksOrders} isDark={isDark} options={options} readOnly /> : (
              <>
                {isMobile ? (
                  // On phones, skip the desktop grid entirely and render the
                  // card list at full width (the grid squeezed cards into the
                  // 48px first column, leaving only the accent bar visible).
                  renderTableBody()
                ) : (
                <div role="table" className="text-sm isolate" style={{
                  display: 'grid',
                  gridTemplateColumns: `48px 64px 200px ${visibleColumns.filter(c => c.key !== 'order_number').map(col => `${columnWidths[col.key] || col.width}px`).join(' ')} minmax(180px, 1fr) 110px`,
                  minWidth: '100%',
                  width: 'max-content'
                }}>

                  <div ref={colHeadRef} className={`py-4 px-2 sticky left-0 top-0 z-[50] border-r border-b border-border/10 flex items-center justify-center ${isDark ? 'bg-card' : 'bg-gray-50'}`} style={{ width: 48, minWidth: 48, maxWidth: 48 }}><input type="checkbox" checked={selectedOrders.length === orders.length && orders.length > 0} onChange={(e) => e.target.checked ? handleSelectAll() : handleDeselectAll()} className="w-4 h-4 rounded border-border bg-background transition-all" data-testid="select-all-checkbox" /></div>
                  <div className={`py-4 px-1 sticky left-[48px] top-0 z-[50] border-r border-b border-border/10 ${isDark ? 'bg-card' : 'bg-gray-50'}`} style={{ width: 64, minWidth: 64, maxWidth: 64 }}></div>

                  {/* Column 3: Permanent Identifier (Sticky) */}
                  <div className={`py-4 px-3 sticky left-[112px] top-0 z-[50] text-left text-[10px] font-bold tracking-[0.2em] uppercase border-r border-b border-border/10 ${isDark ? 'bg-card text-slate-300' : 'bg-gray-50 text-slate-700'}`} style={{ width: 200, minWidth: 200, maxWidth: 200 }}>
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate">{(currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? 'Board' : 'Order #'}</span>
                      <Popover open={openFilter === ((currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? '_board' : 'order_number')} onOpenChange={(val) => setOpenFilter(val ? ((currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? '_board' : 'order_number') : null)}>
                        <PopoverTrigger className={`p-0.5 rounded transition-colors flex-shrink-0 ${filters[(currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? '_board' : 'order_number'] ? 'bg-primary/20 text-primary animate-pulse' : 'hover:bg-secondary text-muted-foreground'}`}>
                          <ListFilter className="w-3.5 h-3.5" />
                        </PopoverTrigger>
                        <PopoverContent className="z-[300] min-w-[200px] bg-card border-border p-3 shadow-2xl">
                          {(currentBoard === 'MASTER' || currentBoard === 'EJEMPLOS') ? (
                            <>
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Board</span>
                                {filters['_board'] && <button onClick={() => setFilters(prev => { const n = { ...prev }; delete n['_board']; return n; })} className="text-[10px] font-bold text-destructive hover:underline uppercase">Limpiar</button>}
                              </div>
                              <div className="max-h-60 overflow-y-auto mt-1 space-y-1">
                                {allBoardsIncludingHidden.filter(b => b !== 'MASTER' && b !== 'PAPELERA DE RECICLAJE' && !b.startsWith('MAQUINA')).sort().map(b => {
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

                                {/* Machines Folder */}
                                <div className="mt-2 pt-2 border-t border-border">
                                  <button
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowMachinesInFilter(!showMachinesInFilter); }}
                                    className="flex items-center justify-between w-full py-1.5 px-2 rounded hover:bg-secondary cursor-pointer transition-colors text-xs font-bold text-primary"
                                  >
                                    <div className="flex items-center gap-2">
                                      <Monitor className="w-3.5 h-3.5" />
                                      <span>MAQUINAS</span>
                                    </div>
                                    <ChevronDown className={`w-3 h-3 transition-transform ${showMachinesInFilter ? 'rotate-180' : ''}`} />
                                  </button>
                                  {showMachinesInFilter && (
                                    <div className="pl-4 mt-1 space-y-1 border-l border-primary/20 ml-3">
                                      {allBoardsIncludingHidden.filter(b => b.startsWith('MAQUINA')).sort((a, b) => {
                                        const numA = parseInt(a.replace('MAQUINA', '')) || 0;
                                        const numB = parseInt(b.replace('MAQUINA', '')) || 0;
                                        return numA - numB;
                                      }).map(b => {
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
                                  )}
                                </div>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Orden</span>
                                {filters['order_number'] && <button onClick={() => setFilters(prev => { const n = { ...prev }; delete n['order_number']; return n; })} className="text-[10px] font-bold text-destructive hover:underline uppercase">Limpiar</button>}
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
                  </div>

                  {/* Columns 4+: Draggable Scrollable Content (Always filter order_number) */}
                  {visibleColumns.filter(c => c.key !== 'order_number').map((col, idx) => {
                    const isOrderNum = col.key === 'order_number';
                    const width = isOrderNum ? 220 : (columnWidths[col.key] || col.width);
                    const filterVal = filters[col.key];
                    const isSelect = col.type === 'select' || col.type === 'status' || (col.optionKey && options[col.optionKey]);
                    const isDate = col.type === 'date';

                    return (
                      <div key={col.key} className={`py-4 ${idx === 0 ? 'pl-6 pr-3' : 'px-3'} text-left text-[10px] font-bold tracking-[0.2em] uppercase border-r border-b border-border/5 sticky top-0 z-20 ${isDark ? 'bg-card text-slate-300' : 'bg-gray-50 text-slate-700'} ${draggedCol === col.key ? 'opacity-50' : ''}`} style={{ width: width, minWidth: width, maxWidth: 'none' }} data-testid={`column-header-${col.key}`} draggable={canArrangeColumns} onDragStart={() => handleColumnDragStart(col.key)} onDragOver={(e) => handleColumnDragOver(e, col.key)} onDragEnd={handleColumnDragEnd}>
                        <div className="flex items-center justify-between gap-1">
                          <div className={`flex items-center gap-1.5 select-none overflow-hidden ${canArrangeColumns ? 'cursor-grab active:cursor-grabbing' : ''}`}>
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
                                  {filterVal && <button onClick={() => setFilters(prev => { const n = { ...prev }; delete n[col.key]; return n; })} className="text-[10px] font-bold text-destructive hover:underline uppercase">Limpiar</button>}
                                </div>

                                {isSelect ? (
                                  <div className="max-h-60 overflow-y-auto mt-1 space-y-1">
                                    {col.key === 'board' ? (
                                      <>
                                        <div className="space-y-1">
                                          {getFilterOptions(col).filter(opt => opt !== 'MASTER' && opt !== 'PAPELERA DE RECICLAJE' && !opt.startsWith('MAQUINA')).sort().map(opt => {
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

                                        {/* Machines Folder */}
                                        <div className="mt-2 pt-2 border-t border-border">
                                          <button
                                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowMachinesInFilter(!showMachinesInFilter); }}
                                            className="flex items-center justify-between w-full py-1.5 px-2 rounded hover:bg-secondary cursor-pointer transition-colors text-xs font-bold text-primary"
                                          >
                                            <div className="flex items-center gap-2">
                                              <Monitor className="w-3.5 h-3.5" />
                                              <span>MAQUINAS</span>
                                            </div>
                                            <ChevronDown className={`w-3 h-3 transition-transform ${showMachinesInFilter ? 'rotate-180' : ''}`} />
                                          </button>
                                          {showMachinesInFilter && (
                                            <div className="pl-4 mt-1 space-y-1 border-l border-primary/20 ml-3">
                                              {getFilterOptions(col).filter(opt => opt.startsWith('MAQUINA')).sort((a, b) => {
                                                const numA = parseInt(a.replace('MAQUINA', '')) || 0;
                                                const numB = parseInt(b.replace('MAQUINA', '')) || 0;
                                                return numA - numB;
                                              }).map(opt => {
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
                                          )}
                                        </div>
                                      </>
                                    ) : (
                                      getFilterOptions(col).map(opt => {
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
                                      })
                                    )}
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
                      </div>
                    );
                  })}
                  <div className={`py-4 px-3 text-left text-[10px] font-bold tracking-[0.2em] uppercase border-b border-border/5 sticky top-0 z-20 ${isDark ? 'bg-[hsl(220,30%,9%)] text-slate-300' : 'bg-gray-50 text-slate-700'}`} style={{ minWidth: 180 }} data-testid="column-header-restante">Remaining</div>
                  <div className={`py-4 px-3 text-left text-[10px] font-bold tracking-[0.2em] uppercase border-b border-border/5 sticky top-0 z-20 ${isDark ? 'bg-[hsl(220,30%,9%)] text-pink-300' : 'bg-gray-50 text-pink-600'}`} style={{ minWidth: 110 }} data-testid="column-header-restante-neck">Neck %</div>
                  {renderTableBody()}
                  {!debouncedSearchQuery && !(isDaySupportedBoard(currentBoard) && !groupByDate) && orders.length > displayLimit && (
                    <button
                      onClick={() => setDisplayLimit(n => n + 200)}
                      style={{ gridColumn: '1 / -1' }}
                      className="py-3 text-sm font-bold text-primary hover:bg-primary/5 transition-colors"
                      data-testid="load-more-rows"
                    >
                      Cargar más ({(orders.length - displayLimit).toLocaleString()} restantes)
                    </button>
                  )}
                </div>
                )}
                {orders.length === 0 && <div className="text-center py-12 text-muted-foreground">{t('no_orders')}</div>}
              </>
            )}
      </main>

      {/* Modals */}
      <NewOrderModal isOpen={showNewOrder} onClose={() => setShowNewOrder(false)} onCreate={(order) => { setOrders(prev => [order, ...prev]); }} options={options} groupConfig={groupConfig} columns={columns} />
      <CommentsModal order={commentsOrder} isOpen={!!commentsOrder} onClose={() => { setCommentsOrder(null); setHighlightedCommentId(null); }} currentUser={user} highlightedCommentId={highlightedCommentId} />
      <AutomationsModal isOpen={showAutomations} onClose={() => setShowAutomations(false)} options={options} columns={columns} dynamicBoards={activeBoards} />
      {isAdmin && <FormFieldsManagerModal isOpen={showFormFields} onClose={() => setShowFormFields(false)} columns={columns} />}
      <AddColumnModal isOpen={showAddColumn} onClose={() => setShowAddColumn(false)} onAdd={handleAddColumn} existingColumns={columns} options={options} sampleRow={orders?.[0] || allOrders?.[0] || null} />
      <AnalyticsView isOpen={showAnalytics} onClose={() => setShowAnalytics(false)} allOrders={allOrders} options={options} />
      <ProductionModal isOpen={showProduction} onClose={() => setShowProduction(false)} orders={allOrders} onProductionUpdate={() => { fetchProductionSummary(); fetchOrders(); }} isAdmin={isAdmin} />
      <NeckCaptureModal isOpen={showNeckCapture} onClose={() => setShowNeckCapture(false)} orders={allOrders} onNeckUpdate={() => { fetchNeckSummary(); fetchOrders(); }} isAdmin={isAdmin} />
      <GanttView isOpen={showGantt} onClose={() => setShowGantt(false)} isDark={isDark} />
      <CapacityPlanModal isOpen={showCapacityPlan} onClose={() => setShowCapacityPlan(false)} />
      <PrintedReportModal isOpen={showPrintedReport} onClose={() => setShowPrintedReport(false)} />
      {showProductionScreen && <ProductionScreen onClose={() => setShowProductionScreen(false)} isDark={isDark} />}
      <OrderHistoryModal order={historyOrder} isOpen={!!historyOrder} onClose={() => setHistoryOrder(null)} />

      {/* Trash Modal — exclusivo del supersu (ver Sidebar). */}
      <Dialog open={showTrash && isSuperAdmin} onOpenChange={setShowTrash}>
        <DialogContent className="max-w-4xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col" data-testid="trash-modal">
          <DialogHeader><DialogTitle className="font-roboto text-xl uppercase tracking-wide flex items-center gap-3 text-glow-primary"><Trash2 className="w-5 h-5 text-destructive" /> {t('trash_title')} <span className="text-sm font-normal text-muted-foreground">({trashSearch.trim() ? `${visibleTrashOrders.length} de ${trashOrders.length}` : trashOrders.length})</span></DialogTitle></DialogHeader>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={trashSearch}
              onChange={(e) => setTrashSearch(e.target.value)}
              placeholder="Buscar por orden o cliente..."
              className="w-full pl-8 pr-2 py-1.5 bg-secondary/50 border border-border rounded text-xs focus:ring-1 focus:ring-primary outline-none"
              data-testid="trash-search"
            />
          </div>
          <div className="flex-1 overflow-y-auto py-4">
            {trashLoading ? <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div> :
              visibleTrashOrders.length > 0 ? (
                <div role="table" className="w-full text-sm">
                  <div className="sticky top-0 bg-card z-30">
                    <div role="row" className="flex items-center border-b border-border bg-card px-3 py-2">
                      <div role="cell" className="w-[120px] text-left font-roboto uppercase text-[10px] text-muted-foreground tracking-widest">{t('order')}</div>
                      <div role="cell" className="flex-1 text-left font-roboto uppercase text-[10px] text-muted-foreground tracking-widest">{t('client')}</div>
                      <div role="cell" className="w-[100px] text-left font-roboto uppercase text-[10px] text-muted-foreground tracking-widest">{t('priority')}</div>
                      <div role="cell" className="w-[100px] text-left font-roboto uppercase text-[10px] text-muted-foreground tracking-widest">Restante</div>
                      <div role="cell" className="w-[180px] text-right font-roboto uppercase text-[10px] text-muted-foreground tracking-widest">{t('actions')}</div>
                    </div>
                  </div>
                  <div>{visibleTrashOrders.map(order => (
                    <div role="row" className="flex items-center border-b border-border/50 hover:bg-secondary/30 px-3 py-2" key={order.order_id} data-testid={`trash-order-${order.order_id}`}>
                      <div role="cell" className="w-[120px] font-mono text-foreground font-bold text-xs">{order.order_number}</div>
                      <div role="cell" className="flex-1 text-foreground text-xs truncate pr-4">{order.client || '-'}</div>
                      <div role="cell" className="w-[100px]"><ColoredBadge value={order.priority} isDark={isDark} /></div>
                      <div role="cell" className="w-[100px] text-muted-foreground text-[10px] font-mono">
                        {(() => {
                          if (!order.deleted_at && !order.updated_at) return '-';
                          const delDate = new Date(order.deleted_at || order.updated_at);
                          const expiryDate = new Date(delDate.getTime() + (7 * 24 * 60 * 60 * 1000));
                          const now = new Date();
                          const diffMs = expiryDate - now;
                          const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
                          if (diffDays <= 0) return <span className="text-destructive font-bold uppercase">Expirado</span>;
                          return <span className={diffDays <= 2 ? "text-orange-500 font-bold" : ""}>{diffDays} días</span>;
                        })()}
                      </div>
                      <div role="cell" className="w-[180px] flex items-center justify-end gap-2">
                        <Select onValueChange={(board) => handleRestoreFromTrash([order.order_id], board)}>
                          <SelectTrigger className="w-32 h-8 text-[10px] bg-secondary border-border" data-testid={`restore-select-${order.order_id}`}><SelectValue placeholder={t('restore')} /></SelectTrigger>
                          <SelectContent className="bg-popover border-border z-[300]">{activeBoards.map(b => <SelectItem key={b} value={b} className="text-[10px]">{b}</SelectItem>)}</SelectContent>
                        </Select>
                        <button onClick={() => handlePermanentDelete([order.order_id])} className="p-1.5 rounded hover:bg-destructive/20 transition-colors group" title={t('permanent_delete')} data-testid={`permanent-delete-${order.order_id}`}>
                          <X className="w-4 h-4 text-muted-foreground group-hover:text-destructive" />
                        </button>
                      </div>
                    </div>
                  ))}</div>
                </div>
              ) : <p className="text-center text-muted-foreground py-8">{trashSearch.trim() ? `Sin coincidencias para "${trashSearch.trim()}"` : t('no_trash')}</p>}
          </div>
          {visibleTrashOrders.length > 0 && (
            <div className="flex justify-between items-center pt-4 border-t border-border">
              {/* Confirmación obligatoria: restaurar en bloque vacía la papelera
                  sobre SCHEDULING (hoy son cientos de órdenes) y no hay deshacer.
                  El borrado permanente ya pedía confirmación. Ambos operan sobre
                  lo FILTRADO, y el conteo del texto lo deja explícito. */}
              <button onClick={() => { if (window.confirm(`¿Restaurar ${visibleTrashOrders.length} órdenes de la papelera a SCHEDULING?`)) handleRestoreFromTrash(visibleTrashOrders.map(o => o.order_id), 'SCHEDULING'); }} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 flex items-center gap-2" data-testid="restore-all-btn"><RefreshCw className="w-4 h-4" /> {t('restore')} ({visibleTrashOrders.length}) → SCHEDULING</button>
              <button onClick={() => handlePermanentDelete(visibleTrashOrders.map(o => o.order_id))} className="px-4 py-2 bg-destructive/20 text-destructive rounded text-sm hover:bg-destructive/30 flex items-center gap-2" data-testid="empty-trash-btn"><Trash2 className="w-4 h-4" /> {t('empty_trash')} ({visibleTrashOrders.length})</button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Search Results Modal */}
      <Dialog open={!!searchResults} onOpenChange={(open) => { if (!open) { setSearchResults(null); clearSearch(); } }}>
        <DialogContent className="max-w-[96vw] w-[96vw] max-h-[92vh] h-[92vh] bg-card border-border overflow-hidden flex flex-col p-0" data-testid="search-results-modal">
          <DialogHeader className="p-6 pb-2">
            <DialogTitle className="font-roboto text-2xl font-bold uppercase tracking-tight flex items-center gap-3 text-glow-primary">
              <Search className="w-6 h-6 text-primary" /> Resultados de busqueda <span className="text-sm font-mono font-normal text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/50 ml-2">({searchResults?.length || 0})</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto px-4 sm:px-6 pb-6">
            {isMobile ? (
              <div className="flex flex-col gap-2.5">
                {searchResults?.map(order => (
                  <div
                    key={order.order_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { setDetailsOrder(order); setSearchResults(null); clearSearch(); }}
                    data-testid={`search-result-${order.order_id}`}
                    className="rounded-2xl border border-border bg-card/60 active:scale-[0.99] transition-transform p-4 cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-2xl font-mono font-black text-royal leading-none">{order.order_number}</div>
                        {order.client && <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest mt-1.5 truncate">{order.client}</div>}
                      </div>
                      <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm flex-shrink-0" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666', color: '#fff' }}>{order.board}</span>
                    </div>
                    {(order.quantity || order.blank_status) && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-muted-foreground">
                        {order.quantity ? <span><b className="text-foreground">{Number(order.quantity).toLocaleString()}</b> pz</span> : null}
                        {order.blank_status ? <span className="uppercase tracking-wide">{order.blank_status}</span> : null}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/40">
                      <button
                        onClick={(e) => { e.stopPropagation(); setCommentsOrder(order); setSearchResults(null); clearSearch(); }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/60 text-muted-foreground active:bg-primary/10 active:text-primary text-[11px] font-bold"
                      >
                        <MessageSquare className="w-4 h-4" /> Comentar
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setCurrentBoard(order.board); setSearchResults(null); clearSearch(); setHighlightedOrderId(order.order_id); toast.success(`${order.order_number} → ${order.board}`); }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary/10 text-primary active:bg-primary active:text-white text-[11px] font-bold"
                      >
                        <ExternalLink className="w-4 h-4" /> Ir al tablero
                      </button>
                      <span className="ml-auto text-[11px] font-bold text-royal">Ver detalle ›</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
            <div className="rounded-xl border border-border/50 overflow-x-auto bg-background/50 shadow-inner">
              <div role="table" className="w-full text-sm border-collapse">
                <div className="sticky top-0 bg-secondary z-20 [transform:translateZ(0)]">
                  <div role="row" className="flex border-b border-border/50">
                    <div role="cell" className="text-left py-3 px-4 font-bold uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 min-w-[120px] sticky left-0 bg-[#1e293b] z-[40] border-r border-border/40 shadow-[4px_0_10px_rgba(0,0,0,0.2)] !bg-secondary">{t('order')}</div>
                    <div role="cell" className="text-left py-3 px-4 font-bold uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 min-w-[200px] border-r border-border/40">Tablero</div>
                    {columns.filter(c => c.key !== 'order_number').map(col => (
                      <div role="cell" key={col.key} className="text-left py-3 px-4 font-bold uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 border-r border-border/40" style={{ minWidth: col.width || 150 }}>{col.label}</div>
                    ))}
                    <div role="cell" className="text-center py-3 px-4 font-bold uppercase text-[10px] tracking-[0.2em] text-muted-foreground/70 min-w-[80px] sticky right-0 bg-secondary z-30 border-l border-border/40 shadow-[-4px_0_10px_rgba(0,0,0,0.1)] [transform:translateZ(0)]">Accion</div>
                  </div>
                </div>
                <div>
                  {searchResults?.map(order => (
                    <div role="row" className="flex border-b border-border/20 hover:bg-primary/5 transition-all duration-200 group" key={order.order_id}
                      data-testid={`search-result-${order.order_id}`}>
                      <div role="cell" className="py-3 px-4 min-w-[120px] sticky left-0 bg-card z-20 group-hover:bg-primary/10 border-r border-border/30 shadow-[4px_0_10px_rgba(0,0,0,0.05)] transition-colors !bg-card cursor-pointer" onClick={() => { setDetailsOrder(order); setSearchResults(null); clearSearch(); }}>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-black text-royal text-lg hover:underline transition-all">
                            {order.order_number}
                          </span>
                        </div>
                      </div>
                      <div role="cell" className="py-3 px-4 min-w-[200px] border-r border-border/30">
                        <div className="flex items-center gap-2">
                          {order.packing_link && (
                            <span title={`Packing importado${order.packing_link_label ? `: ${order.packing_link_label}` : ''}`} className="text-emerald-500 flex-shrink-0" data-testid={`search-imported-${order.order_id}`}>
                              <Truck className="w-4 h-4" />
                            </span>
                          )}
                          <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm border border-white/10" style={{ backgroundColor: BOARD_COLORS[order.board]?.accent || '#666', color: '#fff' }}>{order.board}</span>
                        </div>
                      </div>
                      {columns.filter(c => c.key !== 'order_number').map(col => (
                        <div role="cell" key={col.key} className="py-3 px-4 border-r border-border/30" style={{ minWidth: col.width || 150 }}>
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
                        </div>
                      ))}
                      <div role="cell" className="py-3 px-4 min-w-[80px] text-center sticky right-0 bg-card z-10 group-hover:bg-primary/10 border-l border-border/30 shadow-[-4px_0_10px_rgba(0,0,0,0.05)] transition-colors [transform:translateZ(0)]">
                        <div className="flex items-center gap-1.5 justify-center">
                          <button
                            onClick={() => { setCommentsOrder(order); setSearchResults(null); clearSearch(); }}
                            className="p-2 rounded-xl bg-secondary/60 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-all shadow-sm"
                            title="Ver comentarios"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => { setCurrentBoard(order.board); setSearchResults(null); clearSearch(); setHighlightedOrderId(order.order_id); toast.success(`${order.order_number} → ${order.board}`); }}
                            className="p-2 rounded-xl bg-primary/10 text-primary hover:bg-primary hover:text-white transition-all shadow-sm glow-primary-hover"
                            title="Ir al tablero"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            )}
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
      <NeckCaptureModal isOpen={showNeckCapture} onClose={() => setShowNeckCapture(false)} orders={allOrders} onNeckUpdate={() => { fetchNeckSummary(); fetchOrders(); }} isAdmin={isAdmin} />
      <GanttView isOpen={showGantt} onClose={() => setShowGantt(false)} isDark={isDark} />
      <CapacityPlanModal isOpen={showCapacityPlan} onClose={() => setShowCapacityPlan(false)} />
      <PrintedReportModal isOpen={showPrintedReport} onClose={() => setShowPrintedReport(false)} />
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
      <SeedPackingLinkModal isOpen={showSeedLink} onClose={() => setShowSeedLink(false)} onSeeded={() => fetchOrders()} />
      {/* Enterprise Side-Drawer Detail View */}
      {/* Barra de navegación inferior — solo móvil. Cada acción usa lo que ya existe. */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 flex items-end justify-around px-1 pt-2.5 bg-card border-t border-border"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        {[
          { key: 'boards', label: 'Tableros', Icon: Table2, onClick: () => setIsMobileMenuOpen(true) },
          { key: 'search', label: 'Buscar', Icon: Search, onClick: () => { searchInputRef.current?.scrollIntoView({ block: 'start' }); searchInputRef.current?.focus(); } },
          { key: 'new', label: 'Nueva', Icon: Plus, center: true, onClick: () => setShowNewOrder(true) },
          { key: 'wms', label: 'WMS', Icon: Warehouse, onClick: () => { window.location.href = '/wms'; } },
          { key: 'alerts', label: 'Alertas', Icon: Bell, badge: unreadCount > 0, onClick: () => { setShowNotifications(true); if (unreadCount > 0) markNotificationsRead(); } },
        ].map(({ key, label, Icon, onClick, center, badge }) => (
          center ? (
            <button key={key} onClick={onClick} className="flex flex-col items-center -mt-8 active:scale-95 transition-transform min-w-[64px]" aria-label={label}>
              <span className="rounded-2xl bg-royal text-white flex items-center justify-center shadow-lg shadow-royal/30" style={{ width: 58, height: 58 }}>
                <Plus className="w-8 h-8" />
              </span>
              <span className="text-[11px] font-bold text-foreground/80 mt-1">{label}</span>
            </button>
          ) : (
            <button key={key} onClick={onClick} className="relative flex flex-col items-center gap-1.5 px-2 py-1 min-w-[64px] text-muted-foreground active:text-royal transition-colors" aria-label={label}>
              <Icon className="w-6 h-6" strokeWidth={2} />
              {badge && <span className="absolute top-0.5 right-3 w-2.5 h-2.5 bg-royal rounded-full border-2 border-card" />}
              <span className="text-[11px] font-semibold tracking-tight">{label}</span>
            </button>
          )
        ))}
      </nav>

      {detailsOrder && (
        <div className={cn(
          "enterprise-drawer",
          (isMobile || isTablet) ? "fixed inset-0 w-full" : "fixed inset-y-0 right-0 w-[780px] border-l"
        )} style={{
          backgroundColor: isDark ? '#0a0a0c' : '#ffffff',
          boxShadow: '-10px 0 60px rgba(0,0,0,0.6)',
          display: 'flex', flexDirection: 'column', height: '100vh',
          zIndex: 9999, fontFamily: 'inherit',
          // No slide-in transform animation on mobile: a full-screen transform
          // layer rendered blank/garbage on Android Chrome. Force a stable GPU
          // layer instead so the panel paints reliably.
          transform: 'translateZ(0)', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden'
        }}>
          {/* Header */}
          <div className={cn(
            "p-6 md:p-8 flex items-center justify-between flex-shrink-0 border-b",
            isDark ? "bg-white/[0.02] border-white/5" : "bg-gray-50 border-gray-100"
          )}>
            <div className="flex items-center gap-4">
              {(isMobile || isTablet) && (
                <button
                  onClick={() => setDetailsOrder(null)}
                  className={cn("p-2.5 rounded-xl transition-all", isDark ? "bg-white/5 text-white/50 hover:text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              )}
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
                      className={cn(
                        "text-3xl font-black uppercase bg-transparent outline-none border-b-2",
                        isDark ? "text-white border-royal" : "text-navy border-royal"
                      )}
                      style={{ width: '200px' }}
                    />
                  ) : (
                    <h3
                      onClick={() => {
                        if (isAdmin) {
                          setTempOrderNo(detailsOrder.order_number);
                          setIsEditingOrderNo(true);
                        }
                      }}
                      className={cn(
                        "text-3xl font-black uppercase tracking-tighter leading-none cursor-pointer",
                        isDark ? "text-white" : "text-navy"
                      )}
                      title={isAdmin ? "Click para editar número de orden" : ""}
                    >
                      {detailsOrder.order_number}
                    </h3>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {(() => {
                const ps = productionSummary[detailsOrder.order_id];
                const totalProduced = ps ? ps.total_produced : 0;
                const qty = detailsOrder.quantity || 0;
                const pct = qty > 0 ? Math.min(100, (totalProduced / qty) * 100) : 0;
                if (qty <= 0) return null;
                return (
                  <div className="hidden sm:flex flex-col items-end gap-2 pr-4 border-r border-border/50">
                    <span className="text-[10px] font-black text-royal uppercase tracking-widest">{pct.toFixed(0)}% Completado</span>
                    <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-royal" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })()}
              <button
                onClick={() => setDetailsOrder(null)}
                className={cn(
                  "p-2.5 rounded-full transition-all",
                  isDark ? "bg-white/5 text-white/30 hover:bg-white/10 hover:text-white" : "bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                )}
              >
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>

          {/* Body - Scrollable */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '32px 28px', display: 'flex', flexDirection: 'column', gap: '28px' }}>

            {/* Progreso (visible en móvil — en desktop ya aparece en el encabezado) */}
            {(() => {
              const ps = productionSummary[detailsOrder.order_id];
              const totalProduced = ps ? ps.total_produced : 0;
              const qty = detailsOrder.quantity || 0;
              if (qty <= 0) return null;
              const pct = Math.min(100, (totalProduced / qty) * 100);
              const done = totalProduced >= qty;
              return (
                <div className="sm:hidden">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-black uppercase tracking-widest" style={{ color: done ? '#22c55e' : '#4169e1' }}>
                      {pct.toFixed(0)}% {t('completed') || 'Completado'}
                    </span>
                    <span className="text-[10px] font-bold" style={{ color: '#94a3b8' }}>
                      {totalProduced.toLocaleString()} / {qty.toLocaleString()} pz
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(127,127,127,0.18)' }}>
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: done ? '#22c55e' : '#4169e1' }} />
                  </div>
                </div>
              );
            })()}

            {/* Cliente */}
            <div>
              <p style={{ fontSize: '9px', fontWeight: 900, color: isDark ? '#475569' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '6px' }}>Cliente</p>
              <p style={{ fontSize: '20px', fontWeight: 900, textTransform: 'uppercase', color: isDark ? '#f1f5f9' : '#0f172a', margin: 0 }}>
                {renderDetailValue(detailsOrder.client)}
              </p>
            </div>

            {/* Separator */}
            <div style={{ height: '1px', background: `linear-gradient(to right, transparent, ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.10)'}, transparent)` }} />

            {/* Job Instructions */}
            <div>
              <p style={{ fontSize: '9px', fontWeight: 900, color: isDark ? '#475569' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '10px' }}>Instrucciones del Job</p>
              <div style={{ padding: '16px 18px', backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(15,23,42,0.04)', borderRadius: '10px', border: `1px solid ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.08)'}` }}>
                <p style={{ fontSize: '14px', fontWeight: 600, lineHeight: 1.6, color: isDark ? '#cbd5e1' : '#334155', margin: 0 }}>
                  {renderDetailValue(detailsOrder.job_title_a)}
                </p>
              </div>
            </div>

            {/* Estados */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
                <div style={{ width: '3px', height: '14px', backgroundColor: '#4169e1', borderRadius: '2px', boxShadow: '0 0 8px rgba(65,105,225,0.5)' }} />
                <p style={{ fontSize: '10px', fontWeight: 900, color: isDark ? '#64748b' : '#475569', textTransform: 'uppercase', letterSpacing: '0.25em', margin: 0 }}>Estados de la Orden</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-6">
                {columns
                  .filter(col => ['production_status', 'blank_status', 'trim_status', 'artwork_status', 'sample', 'shipping', 'priority', 'screens', 'betty_column'].includes(col.key))
                  .map(col => (
                    <div key={col.key}>
                      <p style={{ fontSize: '8px', fontWeight: 900, color: isDark ? '#334155' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: '5px' }}>{col.label}</p>
                      <p style={{ fontSize: '12px', fontWeight: 800, color: isDark ? '#e2e8f0' : '#1e293b', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
