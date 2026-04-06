import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { useLang } from "../contexts/LanguageContext";
import { API, DEFAULT_COLUMNS, STATUS_COLORS, getActionLabels } from "../lib/constants";

const WS_URL = (() => {
  const base = process.env.REACT_APP_BACKEND_URL || '';
  return base.replace(/^http/, 'ws') + '/api/ws';
})();

// Global 401 interceptor — redirects to login when session expires
const apiFetch = async (url, options = {}) => {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (res.status === 401) {
    console.warn('[apiFetch] 401 detected — session expired, redirecting to login');
    localStorage.removeItem('mos_user');
    window.location.href = '/';
    throw new Error('SESSION_EXPIRED');
  }
  return res;
};

export const useOrders = (currentBoard, boardFilters) => {
  const { t } = useLang();
  const [orders, setOrders] = useState([]);
  const [unfilteredOrders, setUnfilteredOrders] = useState([]);
  const [allOrders, setAllOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [operationLoading, setOperationLoading] = useState(false);
  const [options, setOptions] = useState({});
  const [productionSummary, setProductionSummary] = useState({});
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [automationMessage, setAutomationMessage] = useState('');
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [dynamicBoards, setDynamicBoards] = useState([]);
  const [hiddenBoards, setHiddenBoards] = useState([]);
  const [groupConfig, setGroupConfig] = useState({ label_to_group: {}, group_colors: {} });
  const [columnWidths, setColumnWidths] = useState(() => {
    const widths = {};
    DEFAULT_COLUMNS.forEach(col => widths[col.key] = col.width);
    return widths;
  });

  const fetchOrders = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (currentBoard !== 'MASTER' && currentBoard !== 'EJEMPLOS') params.append('board', currentBoard);
      const res = await apiFetch(`${API}/orders?${params}`);
      if (res.ok) {
        let data = await res.json();
        data = data.filter(o => o.board !== 'PAPELERA DE RECICLAJE');
        setUnfilteredOrders(data);
        const EMPTY_FILTER = '\u2014Ninguno\u2014';
        const currentFilters = boardFilters[currentBoard] || {};
        Object.entries(currentFilters).forEach(([key, value]) => {
          if (key === '_board') {
            if (Array.isArray(value) && value.length > 0) {
              data = data.filter(o => value.includes(o.board));
              return;
            } else if (typeof value === 'string' && value.trim()) {
              const sv = value.toLowerCase();
              data = data.filter(o => String(o.board || '').toLowerCase().includes(sv));
              return;
            }
          }
          if (value && typeof value === 'object' && !Array.isArray(value) && (value.from || value.to)) {
            data = data.filter(o => {
              const v = o[key];
              if (!v) return false;
              const d = v.substring(0, 10);
              if (value.from && d < value.from) return false;
              if (value.to && d > value.to) return false;
              return true;
            });
          } else if (Array.isArray(value) && value.length > 0) {
            const hasEmpty = value.includes(EMPTY_FILTER);
            const realVals = value.filter(v => v !== EMPTY_FILTER);
            data = data.filter(o => {
              const v = o[key];
              const isEmpty = v === null || v === undefined || v === '';
              if (hasEmpty && isEmpty) return true;
              if (realVals.length > 0) {
                const sv = String(v);
                if (realVals.includes(v) || realVals.includes(sv)) return true;
                if (v) { try { const fd = new Date(v).toLocaleDateString(); if (realVals.includes(fd)) return true; } catch {} }
              }
              return false;
            });
          } else if (value && typeof value === 'string') {
            if (value === EMPTY_FILTER) data = data.filter(o => !o[key] || o[key] === '');
            else {
              const sv = value.toLowerCase();
              data = data.filter(o => String(o[key] || '').toLowerCase().includes(sv));
            }
          }
        });
        setOrders(data);
      }
    } catch (e) {
      if (e.message !== 'SESSION_EXPIRED' && !silent) toast.error(t('load_orders_err'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [currentBoard, boardFilters, t]);

  const fetchAllOrders = useCallback(async () => {
    try { const res = await apiFetch(`${API}/orders`); if (res.ok) { const data = await res.json(); setAllOrders(data.filter(o => o.board !== 'PAPELERA DE RECICLAJE')); } } catch { /* silent */ }
  }, []);

  const fetchOptions = useCallback(async () => {
    try { const res = await apiFetch(`${API}/config/options`); if (res.ok) setOptions(await res.json()); } catch { /* silent */ }
  }, []);

  const fetchProductionSummary = useCallback(async () => {
    try { const res = await apiFetch(`${API}/production-summary`); if (res.ok) setProductionSummary(await res.json()); } catch { /* silent */ }
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await apiFetch(`${API}/notifications`);
      if (res.ok) { const data = await res.json(); setNotifications(data.notifications || []); setUnreadCount(data.unread_count || 0); }
    } catch { /* silent */ }
  }, []);

  const fetchBoards = useCallback(async () => {
    try {
      const [boardsRes, hiddenRes] = await Promise.all([
        fetch(`${API}/config/boards`, { credentials: 'include' }),
        fetch(`${API}/config/hidden-boards`, { credentials: 'include' })
      ]);
      if (boardsRes.ok) { const data = await boardsRes.json(); setDynamicBoards(data.boards || []); }
      if (hiddenRes.ok) { const data = await hiddenRes.json(); setHiddenBoards(data || []); }
    } catch (error) { console.error("Error fetching boards:", error); }
  }, []);

  const toggleBoardVisibility = useCallback(async (boardName) => {
    setHiddenBoards(prev => {
      const isHidden = prev.includes(boardName);
      const next = isHidden ? prev.filter(b => b !== boardName) : [...prev, boardName];
      
      // Persist to backend without blocking local state
      fetch(`${API}/config/hidden-boards`, { 
        method: 'PUT', 
        headers: { 'Content-Type': 'application/json' }, 
        credentials: 'include', 
        body: JSON.stringify({ boards: next }) 
      }).catch(err => console.error("Error saving board visibility:", err));
      
      return next;
    });
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch(`${API}/config/groups`, { credentials: 'include' });
      if (res.ok) setGroupConfig(await res.json());
    } catch { /* silent */ }
  }, []);

  const createBoard = async (name) => {
    try {
      const res = await fetch(`${API}/config/boards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name }) });
      if (res.ok) { const data = await res.json(); setDynamicBoards(data.boards); toast.success(`Tablero "${name}" creado`); return true; }
      else { const err = await res.json(); toast.error(err.detail || 'Error'); return false; }
    } catch { toast.error('Error'); return false; }
  };

  const deleteBoard = async (boardName) => {
    try {
      const res = await fetch(`${API}/config/boards/${encodeURIComponent(boardName)}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { const data = await res.json(); setDynamicBoards(data.boards); toast.success(`Tablero "${boardName}" eliminado`); return true; }
      else { const err = await res.json(); toast.error(err.detail || 'Error'); return false; }
    } catch { toast.error('Error'); return false; }
  };

  const markNotificationsRead = async () => {
    try { await fetch(`${API}/notifications/read`, { method: 'PUT', credentials: 'include' }); setUnreadCount(0); setNotifications(prev => prev.map(n => ({ ...n, read: true }))); } catch { /* silent */ }
  };

  const [removedDefaults, setRemovedDefaults] = useState([]);

  // Load custom columns + removed defaults
  useEffect(() => {
    const loadColumnConfig = async () => {
      try {
        const res = await fetch(`${API}/config/columns`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const removed = data.removed_default_columns || [];
          setRemovedDefaults(removed);
          const activeDefaults = DEFAULT_COLUMNS.filter(c => !removed.includes(c.key));
          const custom = data.custom_columns || [];
          // Filter out custom columns that duplicate a default column key to prevent double columns
          const defaultKeys = new Set(DEFAULT_COLUMNS.map(c => c.key));
          const uniqueCustom = custom.filter(c => !defaultKeys.has(c.key));
          const allCols = [...activeDefaults, ...uniqueCustom];
          setColumns(allCols);
          const newWidths = {};
          activeDefaults.forEach(col => newWidths[col.key] = col.width);
          custom.forEach(col => newWidths[col.key] = col.width || 150);
          setColumnWidths(newWidths);
        }
      } catch { /* use defaults */ }
    };
    loadColumnConfig();
  }, []);

  // Load custom colors
  useEffect(() => {
    const loadColors = async () => {
      try { const res = await fetch(`${API}/config/colors`, { credentials: 'include' }); if (res.ok) { const colors = await res.json(); Object.entries(colors).forEach(([k, v]) => { STATUS_COLORS[k] = v; }); } } catch { /* defaults */ }
    };
    loadColors();
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  useEffect(() => { fetchOptions(); }, [fetchOptions]);
  useEffect(() => { fetchAllOrders(); }, [fetchAllOrders]);
  useEffect(() => { fetchProductionSummary(); }, [fetchProductionSummary]);
  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);
  useEffect(() => { fetchBoards(); }, [fetchBoards]);
  useEffect(() => { fetchGroups(); }, [fetchGroups]);
  useEffect(() => { const interval = setInterval(fetchNotifications, 30000); return () => clearInterval(interval); }, [fetchNotifications]);

  // ==================== REAL-TIME WEBSOCKET ====================
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const fetchOrdersRef = useRef(fetchOrders);
  const fetchProdRef = useRef(fetchProductionSummary);
  const selfUpdateRef = useRef(false);

  useEffect(() => { fetchOrdersRef.current = fetchOrders; }, [fetchOrders]);
  useEffect(() => { fetchProdRef.current = fetchProductionSummary; }, [fetchProductionSummary]);

  const sessionExpiredRef = useRef(false);

  const connectWs = useCallback(() => {
    if (sessionExpiredRef.current) return; // Don't reconnect if session expired
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    try {
      const ws = new WebSocket(WS_URL);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'order_change' || msg.type === 'production_update') {
            fetchProdRef.current();
          }
          if (msg.type === 'order_change') {
            fetchOrdersRef.current(true);
          }
          // Detect session expired message from server
          if (msg.type === 'error' && msg.code === 401) {
            sessionExpiredRef.current = true;
            ws.close();
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!sessionExpiredRef.current) {
          reconnectTimer.current = setTimeout(connectWs, 3000);
        }
      };
      ws.onerror = () => { ws.close(); };
      wsRef.current = ws;
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    connectWs();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWs]);

  const saveColumnsConfig = useCallback(async (cols, removedDefs) => {
    const customCols = cols.filter(c => c.custom);
    try { await fetch(`${API}/config/columns`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ custom_columns: customCols, removed_default_columns: removedDefs || [] }) }); } catch { /* silent */ }
  }, []);

  const saveCustomColumns = useCallback(async (cols) => {
    saveColumnsConfig(cols, removedDefaults);
  }, [saveColumnsConfig, removedDefaults]);

  const handleCellUpdate = async (orderId, field, value) => {
    setOrders(prev => prev.map(o => o.order_id === orderId ? { ...o, [field]: value } : o));
    selfUpdateRef.current = true;
    try {
      const res = await fetch(`${API}/orders/${orderId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ [field]: value }) });
      if (res.ok) {
        const data = await res.json();
        const automations = data._automations_executed || [];
        if (automations.length > 0) {
          const names = automations.map(a => a.name).join(', ');
          setAutomationRunning(true); setAutomationMessage(`Automatizacion: ${names}`);
          setTimeout(async () => { selfUpdateRef.current = true; await fetchOrders(); setAutomationRunning(false); setAutomationMessage(''); toast.success(`Automatizacion ejecutada: ${names}`, { duration: 3000 }); }, 600);
        }
      } else { toast.error(t('update_err')); fetchOrders(); }
    } catch { toast.error(t('update_err')); fetchOrders(); }
  };

  const handleBulkMove = async (selectedOrders, targetBoard) => {
    if (selectedOrders.length === 0) return;
    setOperationLoading(true);
    selfUpdateRef.current = true;
    try { await fetch(`${API}/orders/bulk-move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ order_ids: selectedOrders, board: targetBoard }) }); toast.success(`${selectedOrders.length} ${t('orders')} → ${targetBoard}`); fetchOrders(); fetchAllOrders(); } catch { toast.error(t('move_err')); } finally { setOperationLoading(false); }
  };

  const handleQuickUndo = async () => {
    try {
      const res = await fetch(`${API}/activity?limit=10`, { credentials: 'include' });
      if (!res.ok) return toast.error(t('undo_error'));
      const data = await res.json();
      const lastUndoable = data.logs.find(l => l.undoable && !l.undone && l.action !== 'undo_action');
      if (!lastUndoable) return toast.info(t('no_undo_actions'));
      setOperationLoading(true);
      const undoRes = await fetch(`${API}/undo/${lastUndoable.activity_id}`, { method: 'POST', credentials: 'include' });
      if (undoRes.ok) { const actionLabels = getActionLabels(t); toast.success(`${t('undo')}: ${actionLabels[lastUndoable.action] || lastUndoable.action}`); fetchOrders(); }
      else { const err = await undoRes.json(); toast.error(err.detail || t('undo_error')); }
    } catch { toast.error(t('undo_error')); } finally { setOperationLoading(false); }
  };

  const handleGlobalSearch = async (searchQuery, setCurrentBoard) => {
    if (!searchQuery.trim()) return;
    // Easter egg: secret code opens the system guide
    if (searchQuery.trim() === '201492') {
      return '__GUIDE__';
    }
    setOperationLoading(true);
    try {
      const res = await fetch(`${API}/orders?search=${encodeURIComponent(searchQuery)}`, { credentials: 'include' });
      if (res.ok) {
        const results = await res.json();
        const filtered = results.filter(o => o.board !== 'PAPELERA DE RECICLAJE');
        if (filtered.length === 1) {
          const found = filtered[0];
          setCurrentBoard(found.board);
          const isExactOrderedMatch = found.order_number && String(found.order_number).toLowerCase() === searchQuery.trim().toLowerCase();
          const msg = isExactOrderedMatch 
            ? `${t('order')} ${found.order_number} → ${found.board}`
            : `Referencia encontrada en orden: ${found.order_number} (${found.board})`;
          toast.success(msg);
          return null;
        } else if (filtered.length > 1) {
          toast.info(`${filtered.length} coincidencias encontradas`);
          return filtered;
        } else {
          toast.error(`Referencia no encontrada globalmente`);
          return null;
        }
      }
    } catch { toast.error(t('search_err')); } finally { setOperationLoading(false); }
    return null;
  };

  const handleAddColumn = (newCol) => {
    if (newCol.statusOptions) {
      const vals = newCol.statusOptions.map(o => o.value);
      setOptions(prev => ({ ...prev, [newCol.optionKey]: vals }));
      newCol.statusOptions.forEach(o => { STATUS_COLORS[o.value] = { bg: o.color, text: '#FFFFFF' }; });
    }
    const updatedCols = [...columns, newCol];
    setColumns(updatedCols);
    setColumnWidths(prev => ({ ...prev, [newCol.key]: newCol.width }));
    saveCustomColumns(updatedCols);
  };

  const handleDeleteColumn = (colKey) => {
    if (!window.confirm(t('del_column_confirm') + '?')) return;
    const isDefault = DEFAULT_COLUMNS.some(c => c.key === colKey);
    const updatedCols = columns.filter(c => c.key !== colKey);
    setColumns(updatedCols);
    toast.success(t('column_deleted'));
    if (isDefault) {
      const newRemoved = [...removedDefaults, colKey];
      setRemovedDefaults(newRemoved);
      saveColumnsConfig(updatedCols, newRemoved);
    } else {
      saveColumnsConfig(updatedCols, removedDefaults);
    }
  };

  return {
    orders, setOrders, allOrders, unfilteredOrders, loading, operationLoading, setOperationLoading,
    options, productionSummary, notifications, unreadCount, markNotificationsRead,
    automationRunning, automationMessage, columns, columnWidths, setColumnWidths,
    fetchOrders, fetchAllOrders, fetchOptions, fetchProductionSummary,
    handleCellUpdate, handleBulkMove, handleQuickUndo, handleGlobalSearch,
    handleAddColumn, handleDeleteColumn, saveCustomColumns, saveColumnsConfig, removedDefaults,
    dynamicBoards, hiddenBoards, createBoard, deleteBoard, fetchBoards, toggleBoardVisibility,
    groupConfig, fetchGroups
  };
};
