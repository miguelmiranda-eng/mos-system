import { useEffect, useRef } from "react";

// Events that should trigger a badge refresh
const BADGE_EVENTS = new Set([
  "wms_badge_changed",   // generic invalidation (emitted by WMS endpoints)
  "ticket_assigned",     // existing event
  "cycle_count_assigned", // existing event
]);

/**
 * Subscribes to /api/ws and calls onBadgeInvalidate() when a relevant
 * event fires. Auto-reconnects with backoff. Debounces refresh calls
 * so bulk operations only trigger one refresh.
 */
export function useWmsWebSocket(onBadgeInvalidate) {
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const debounceTimerRef = useRef(null);
  const attemptRef = useRef(0);
  const callbackRef = useRef(onBadgeInvalidate);

  // Keep callback ref fresh without retriggering the effect
  useEffect(() => { callbackRef.current = onBadgeInvalidate; }, [onBadgeInvalidate]);

  useEffect(() => {
    let stopped = false;

    const scheduleRefresh = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => callbackRef.current?.(), 300);
    };

    const connect = () => {
      if (stopped) return;
      const backend = process.env.REACT_APP_BACKEND_URL || "";
      const wsUrl = backend.replace(/^http/, "ws") + "/api/ws";
      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => { attemptRef.current = 0; };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (BADGE_EVENTS.has(msg.type)) scheduleRefresh();
          } catch { /* ignore malformed messages */ }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (stopped) return;
          // Exponential backoff: 1s, 2s, 4s, 8s, capped at 30s
          const delay = Math.min(1000 * Math.pow(2, attemptRef.current), 30000);
          attemptRef.current += 1;
          reconnectTimerRef.current = setTimeout(connect, delay);
        };

        ws.onerror = () => { ws.close(); };
      } catch (err) {
        console.error("[WMS] WebSocket connect failed:", err);
        reconnectTimerRef.current = setTimeout(connect, 5000);
      }
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);
}
