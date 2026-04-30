import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { useLang } from "../contexts/LanguageContext";
import { API, DEFAULT_COLUMNS, STATUS_COLORS, getActionLabels } from "../lib/constants";

const WS_URL = (() => {
  const base = process.env.REACT_APP_BACKEND_URL || '';
  return base.replace(/^http/, 'ws') + '/api/ws';
})();

// Simple local cache to prevent frontend request flooding
const reqCache = new Map();
const reqPromises = new Map();

// Persistent memory for board data to make switching instant
const boardDataCache = {};
const lastFetchedTime = {};

export const apiFetch = async (url, options = {}) => {
  const isGet = !options.method || options.method === 'GET';
  
  if (isGet) {
    const cacheKey = url;
    const now = Date.now();
    
    // 1. Check TTL cache (5 seconds)
    if (reqCache.has(cacheKey)) {
      const { data, timestamp } = reqCache.get(cacheKey);
      if (now - timestamp < 5000) {
        return data.clone();
      } else {
        reqCache.delete(cacheKey);
      }
    }
    
    // 2. Check if request is already in-flight (Promise deduplication)
    if (reqPromises.has(cacheKey)) {
      const res = await reqPromises.get(cacheKey);
      return res.clone();
    }
    
    // 3. Make the actual request
    const fetchPromise = fetch(url, { credentials: 'include', ...options });
    reqPromises.set(cacheKey, fetchPromise);
    
    try {
      const res = await fetchPromise;
      if (res.status === 401) {
        console.warn('[apiFetch] 401 detected — session expired');
        localStorage.removeItem('mos_user');
        window.location.href = '/';
        throw new Error('SESSION_EXPIRED');
      }
      
      if (res.ok) {
        reqCache.set(cacheKey, { data: res.clone(), timestamp: Date.now() });
      }
      return res;
    } finally {
      reqPromises.delete(cacheKey);
    }
  }

  // Non-GET requests (mutations) bypass cache completely
  const res = await fetch(url, { credentials: 'include', ...options });
  if (res.status === 401) {
    console.warn('[apiFetch] 401 detected — session expired');
    localStorage.removeItem('mos_user');
    window.location.href = '/';
    throw new Error('SESSION_EXPIRED');
  }
  
  // Clear related caches on mutation
  if (!isGet) {
    const urlStr = url.toString();
    if (urlStr.includes('/orders')) {
      for (const key of reqCache.keys()) {
        if (key.includes('/orders')) reqCache.delete(key);
      }
    }
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
  const opLoadingTimerRef = useRef(null);
  const safeSetOperationLoading = useCallback((val) => {
    if (val) {
      if (opLoadingTimerRef.current) clearTimeout(opLoadingTimerRef.current);
      opLoadingTimerRef.current = setTimeout(() => setOperationLoading(false), 30000);
    } else {
      if (opLoadingTimerRef.current) { clearTimeout(opLoadingTimerRef.current); opLoadingTimerRef.current = null; }
    }
    setOperationLoading(val);
  }, []);
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
    try {
      const saved = localStorage.getItem('mos_column_widths');
      if (saved) return JSON.parse(saved);
    } catch { /* ignore error */ }
    const widths = {};
    DEFAULT_COLUMNS.forEach(col => widths[col.key] = col.width);
    return widths;
  });

  useEffect(() => {
    localStorage.setItem('mos_column_widths', JSON.stringify(columnWidths));
  }, [columnWidths]);

  const fetchOrders = useCallback(async (silent = false, forceRefresh = false) => {
    // Stale-while-revalidate logic:
    const cacheKey = currentBoard + JSON.stringify(boardFilters[currentBoard] || {});
    const hasCache = boardDataCache[cacheKey];
    const now = Date.now();
    const isStale = !lastFetchedTime[cacheKey] || (now - lastFetchedTime[cacheKey] > 30000); // 30s stale

    if (hasCache && !forceRefresh) {
      setOrders(hasCache);
      setUnfilteredOrders(hasCache);
      if (!isStale) {
        setLoading(false);
        return;
      }
      silent = true; // Update in background
    }

    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (currentBoard !== 'MASTER' && currentBoard !== 'EJEMPLOS') params.append('board', currentBoard);
      const res = await apiFetch(`${API}/orders?${params}`);
      if (res.ok) {
        let data = await res.json();
        data = data.filter(o => o.board !== 'PAPELERA DE RECICLAJE');
        
        // Save to cache before filtering locally
        boardDataCache[cacheKey] = data;
        lastFetchedTime[cacheKey] = now;
        
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
    try { 
      await fetch(`${API}/notifications/read`, { method: 'PUT', credentials: 'include' }); 
      setNotifications(prev => {
        const next = prev.map(n => ({ ...n, read: true }));
        setUnreadCount(0);
        return next;
      });
    } catch { /* silent */ }
  };

  const markNotificationRead = async (notificationId) => {
    try { 
      await fetch(`${API}/notifications/${notificationId}/read`, { method: 'PUT', credentials: 'include' }); 
      setNotifications(prev => prev.map(n => n.notification_id === notificationId ? { ...n, read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch { /* silent */ }
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
          setColumnWidths(prev => ({ ...newWidths, ...prev }));
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

  const lastBoardRef = useRef(null);
  useEffect(() => {
    const isNewBoard = lastBoardRef.current !== currentBoard;
    lastBoardRef.current = currentBoard;
    // Non-silent (shows spinner) on board switch or initial load; silent on filter change
    fetchOrders(!isNewBoard);
  }, [currentBoard, boardFilters]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchOptions(); }, [fetchOptions]);
  useEffect(() => { fetchAllOrders(); }, [fetchAllOrders]);
  useEffect(() => { fetchProductionSummary(); }, [fetchProductionSummary]);
  useEffect(() => { 
    fetchNotifications();
    fetchBoards();
    fetchGroups();
    const interval = setInterval(fetchNotifications, 300000); // Poll notifications every 5 minutes
    return () => clearInterval(interval); 
  }, [fetchNotifications, fetchBoards, fetchGroups]);

  // ==================== REAL-TIME WEBSOCKET ====================
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const fetchOrdersRef = useRef(fetchOrders);
  const fetchProdRef = useRef(fetchProductionSummary);
  const fetchNotifsRef = useRef(fetchNotifications);
  const selfUpdateRef = useRef(false);

  useEffect(() => { fetchOrdersRef.current = fetchOrders; }, [fetchOrders]);
  useEffect(() => { fetchProdRef.current = fetchProductionSummary; }, [fetchProductionSummary]);
  useEffect(() => { fetchNotifsRef.current = fetchNotifications; }, [fetchNotifications]);

  const sessionExpiredRef = useRef(false);

  const updateDebounceTimer = useRef(null);

  const connectWs = useCallback(() => {
    if (sessionExpiredRef.current) return; // Don't reconnect if session expired
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    try {
      const ws = new WebSocket(WS_URL);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'order_change' || msg.type === 'production_update') {
            // Debounce server fetches to prevent flooding during bursts of updates
            if (updateDebounceTimer.current) clearTimeout(updateDebounceTimer.current);
            // Add a random Jitter between 1000ms and 4000ms to prevent Thundering Herds
            // If this exact client made the change, fetch instantly (100ms) for snappy UI
            let jitter = 1000 + Math.random() * 3000;
            if (selfUpdateRef.current) {
              jitter = 50;
              selfUpdateRef.current = false; // Reset flag after consuming
            }
            updateDebounceTimer.current = setTimeout(() => {
              fetchProdRef.current();
              if (msg.type === 'order_change') {
                fetchOrdersRef.current(true, true); // Silent but forced refresh
                if (msg.data?.action === 'add_comment') fetchNotifsRef.current();
              }
            }, jitter);
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
    // Optimistic update: update local state immediately
    const updateFn = (prev) => prev.map(o => o.order_id === orderId ? { ...o, [field]: value } : o);
    setOrders(updateFn);
    setUnfilteredOrders(updateFn);

    try {
      // Clear cache for this board to ensure next background fetch is fresh
      delete boardDataCache[currentBoard + JSON.stringify(boardFilters[currentBoard] || {})];
      
      const res = await fetch(`${API}/orders/${orderId}`, { 
        method: 'PUT', 
        headers: { 'Content-Type': 'application/json' }, 
        credentials: 'include', 
        body: JSON.stringify({ [field]: value }) 
      });

      if (res.ok) {
        const data = await res.json();
        const automations = data._automations_executed || [];
        
        // If automations triggered, we DO need a full refresh to show side-effects
        if (automations.length > 0) {
          const names = automations.map(a => a.name).join(', ');
          setAutomationRunning(true); 
          setAutomationMessage(`Automatización: ${names}`);
          setTimeout(async () => { 
            await fetchOrders(true, true); 
            setAutomationRunning(false); 
            setAutomationMessage(''); 
            toast.success(`Automatización ejecutada: ${names}`, { duration: 3000 }); 
          }, 600);
        } else {
          // No automations? Just update the single order with server's confirmed data
          const finalUpdate = (prev) => prev.map(o => o.order_id === orderId ? data : o);
          setOrders(finalUpdate);
          setUnfilteredOrders(finalUpdate);
          
          // If the board changed, we need to refresh the current view as the order might disappear
          if (field === 'board') fetchOrders(true, true);
        }
      } else { 
        toast.error(t('update_err')); 
        fetchOrders(true, true); // Rollback/Sync
      }
    } catch { 
      toast.error(t('update_err')); 
      fetchOrders(true, true); // Rollback/Sync
    }
  };

  const handleBulkMove = async (orderIds, targetBoard) => {
    if (!orderIds || orderIds.length === 0) return;

    // Optimistic update: remove moved orders from current view
    setOrders(prev => prev.filter(o => !orderIds.includes(o.order_id)));
    setUnfilteredOrders(prev => prev.filter(o => !orderIds.includes(o.order_id)));

    // Signal WebSocket handler that THIS client made the change → 50ms refresh instead of 1-4s jitter
    selfUpdateRef.current = true;

    // Invalidate target board cache so navigating there always fetches fresh data
    delete boardDataCache[targetBoard + JSON.stringify(boardFilters[targetBoard] || {})];
    delete lastFetchedTime[targetBoard + JSON.stringify(boardFilters[targetBoard] || {})];

    try {
      const res = await fetch(`${API}/orders/bulk-move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ order_ids: orderIds, board: targetBoard })
      });

      if (res.ok) {
        toast.success(`${orderIds.length} ${t('orders')} → ${targetBoard}`);
        fetchOrders(true, true);
        fetchAllOrders();
      } else {
        const err = await res.json();
        toast.error(err.detail || t('move_err'));
        selfUpdateRef.current = false;
        fetchOrders(true, true);
      }
    } catch {
      toast.error(t('move_err'));
      selfUpdateRef.current = false;
      fetchOrders(true, true);
    }
  };

  const handleQuickUndo = async () => {
    try {
      const res = await fetch(`${API}/activity?limit=10`, { credentials: 'include' });
      if (!res.ok) return toast.error(t('undo_error'));
      const data = await res.json();
      const lastUndoable = data.logs.find(l => l.undoable && !l.undone && l.action !== 'undo_action');
      if (!lastUndoable) return toast.info(t('no_undo_actions'));
      safeSetOperationLoading(true);
      const undoRes = await fetch(`${API}/undo/${lastUndoable.activity_id}`, { method: 'POST', credentials: 'include' });
      if (undoRes.ok) { const actionLabels = getActionLabels(t); toast.success(`${t('undo')}: ${actionLabels[lastUndoable.action] || lastUndoable.action}`); fetchOrders(); }
      else { const err = await undoRes.json(); toast.error(err.detail || t('undo_error')); }
    } catch { toast.error(t('undo_error')); } finally { safeSetOperationLoading(false); }
  };

  const handleGlobalSearch = async (searchQuery, setCurrentBoard) => {
    if (!searchQuery.trim()) return;
    // Easter egg: secret code opens the system guide
    if (searchQuery.trim() === '201492') {
      return '__GUIDE__';
    }
    safeSetOperationLoading(true);
    try {
      const res = await fetch(`${API}/orders?search=${encodeURIComponent(searchQuery)}`, { credentials: 'include' });
      if (res.ok) {
        const results = await res.json();
        const filtered = results.filter(o => o.board !== 'PAPELERA DE RECICLAJE');
        if (filtered.length >= 1) {
          const found = filtered[0];
          setCurrentBoard(found.board);
          if (filtered.length === 1) {
            const isExactOrderedMatch = found.order_number && String(found.order_number).trim().toLowerCase() === searchQuery.trim().toLowerCase();
            const msg = isExactOrderedMatch 
              ? `${t('order')} ${found.order_number} → ${found.board}`
              : `Referencia encontrada en orden: ${found.order_number} (${found.board})`;
            toast.success(msg);
          } else {
            toast.info(`${filtered.length} coincidencias encontradas`);
          }
          return filtered;
        } else {
          toast.error(`Referencia no encontrada globalmente`);
          return null;
        }
      }
    } catch { toast.error(t('search_err')); } finally { safeSetOperationLoading(false); }
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
    orders, setOrders, allOrders, unfilteredOrders, loading, operationLoading, setOperationLoading: safeSetOperationLoading,
    options, productionSummary, notifications, unreadCount, markNotificationsRead,
    automationRunning, automationMessage, columns, columnWidths, setColumnWidths,
    fetchOrders, fetchAllOrders, fetchOptions, fetchProductionSummary,
    handleCellUpdate, handleBulkMove, handleQuickUndo, handleGlobalSearch,
    handleAddColumn, handleDeleteColumn, saveCustomColumns, saveColumnsConfig, removedDefaults,
    dynamicBoards, hiddenBoards, createBoard, deleteBoard, fetchBoards, toggleBoardVisibility,
    groupConfig, fetchGroups,
    markNotificationRead
  };
};
