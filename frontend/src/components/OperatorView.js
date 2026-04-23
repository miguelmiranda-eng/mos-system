import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../App";
import { Toaster, toast } from "sonner";
import {
  ClipboardCheck, MapPin, CheckCircle, Package, Loader2, LogOut,
  ChevronDown, ChevronUp, Save, Check, AlertTriangle, Bell
} from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
const WS_URL = `${process.env.REACT_APP_BACKEND_URL}`.replace(/^http/, 'ws') + '/api/ws';
const fetcher = (url) => fetch(`${API}${url}`, { credentials: 'include' }).then(r => r.ok ? r.json() : Promise.reject(r));
const putter = (url, body) => fetch(`${API}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });

const SIZES_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X'];

const TicketCard = ({ ticket, onSelect, isActive }) => {
  const sizes = ticket.sizes || {};
  const totalQty = Object.values(sizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
  const pickedSizes = ticket.picked_sizes || {};
  const totalPicked = Object.values(pickedSizes).reduce((s, v) => s + (parseInt(v) || 0), 0);
  const progress = totalQty > 0 ? Math.round((totalPicked / totalQty) * 100) : 0;
  const statusColor = ticket.picking_status === 'completed' ? 'bg-green-500/15 text-green-400' :
    ticket.picking_status === 'in_progress' ? 'bg-yellow-500/15 text-yellow-400' :
    'bg-blue-500/15 text-blue-400';

  return (
    <button
      onClick={() => onSelect(ticket)}
      className={`w-full text-left p-4 rounded-lg border transition-all ${isActive ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'border-border bg-card hover:border-primary/50'}`}
      data-testid={`operator-ticket-${ticket.ticket_id}`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono font-bold text-primary text-sm">{ticket.order_number}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor}`}>{ticket.picking_status}</span>
      </div>
      <div className="text-xs text-muted-foreground space-y-0.5">
        <div>{ticket.customer} / {ticket.manufacturer}</div>
        <div className="font-mono">{ticket.style} - {ticket.color}</div>
      </div>
      <div className="mt-2">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-muted-foreground">Progreso</span>
          <span className="font-bold">{totalPicked}/{totalQty} ({progress}%)</span>
        </div>
        <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${progress === 100 ? 'bg-green-500' : progress > 0 ? 'bg-yellow-500' : 'bg-gray-500'}`} style={{ width: `${progress}%` }} />
        </div>
      </div>
    </button>
  );
};

const PickingInterface = ({ ticket, onSave, saving }) => {
  const [pickedSizes, setPickedSizes] = useState({});
  const [expandedSize, setExpandedSize] = useState(null);

  useEffect(() => {
    setPickedSizes(ticket.picked_sizes || {});
    setExpandedSize(null);
  }, [ticket]);

  const sizes = ticket.sizes || {};
  const sizeLocs = ticket.size_locations || {};
  const activeSizes = SIZES_ORDER.filter(sz => parseInt(sizes[sz]) > 0);

  const updatePicked = (sz, loc, val) => {
    const locData = sizeLocs[sz]?.locations || sizeLocs[sz] || [];
    const targetLoc = locData.find(l => l.location === loc);
    if (!targetLoc) return;

    const max = targetLoc.available;
    const numVal = Math.max(0, Math.min(parseInt(val) || 0, max));
    
    setPickedSizes(p => {
      const currentSizeData = p[sz] || { total: 0, details: {} };
      const newDetails = { ...currentSizeData.details, [loc]: numVal };
      const newTotal = Object.values(newDetails).reduce((a, b) => a + b, 0);
      
      // Prevent exceeding required amount across all locations for this size
      const required = parseInt(sizes[sz]) || 0;
      if (newTotal > required) {
        toast.error(`No puedes surtir más de lo requerido (${required})`);
        return p;
      }

      return { ...p, [sz]: { total: newTotal, details: newDetails } };
    });
  };

  const totalRequired = activeSizes.reduce((s, sz) => s + (parseInt(sizes[sz]) || 0), 0);
  const totalPicked = activeSizes.reduce((s, sz) => s + (parseInt(pickedSizes[sz]?.total) || 0), 0);
  const isComplete = totalPicked >= totalRequired && totalRequired > 0;

  return (
    <div className="space-y-4" data-testid="picking-interface">
      {/* Ticket Header */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-lg font-bold text-foreground">{ticket.order_number}</div>
            <div className="text-sm text-muted-foreground">{ticket.ticket_id}</div>
          </div>
          <div className="text-right">
            <div className="text-sm font-bold text-foreground">{ticket.customer}</div>
            <div className="text-xs text-muted-foreground">{ticket.manufacturer}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-mono font-bold text-primary bg-primary/10 px-2 py-1 rounded">{ticket.style}</span>
          <span className="bg-secondary px-2 py-1 rounded">{ticket.color}</span>
          <span className="text-muted-foreground">Qty: {ticket.quantity}</span>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-bold">Progreso Total</span>
          <span className={`text-sm font-bold ${isComplete ? 'text-green-400' : 'text-yellow-400'}`}>
            {totalPicked} / {totalRequired} piezas
          </span>
        </div>
        <div className="w-full h-3 bg-secondary rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-300 ${isComplete ? 'bg-green-500' : totalPicked > 0 ? 'bg-yellow-500' : 'bg-gray-500'}`}
            style={{ width: `${totalRequired > 0 ? Math.round((totalPicked / totalRequired) * 100) : 0}%` }} />
        </div>
      </div>

      {/* Size Picking List */}
      <div className="space-y-2">
        {activeSizes.map(sz => {
          const required = parseInt(sizes[sz]) || 0;
          const sizeData = pickedSizes[sz] || { total: 0, details: {} };
          const picked = sizeData.total;
          const locs = sizeLocs[sz]?.locations || sizeLocs[sz] || [];
          const locsArr = Array.isArray(locs) ? locs : [];
          const isDone = picked >= required;
          const isExpanded = expandedSize === sz;

          return (
            <div key={sz} className={`border rounded-lg overflow-hidden transition-all ${isDone ? 'border-green-500/30 bg-green-500/5' : 'border-border bg-card'}`}>
              <div className="flex items-center p-3 gap-3 cursor-pointer" onClick={() => setExpandedSize(isExpanded ? null : sz)}
                data-testid={`operator-size-row-${sz}`}>
                {isDone ? (
                  <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
                ) : (
                  <Package className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold">{sz}</span>
                    <span className="text-sm text-muted-foreground">Requerido: {required}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {Object.entries(sizeData.details).map(([loc, q]) => q > 0 && (
                      <span key={loc} className="text-[10px] font-mono bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded border border-green-500/30">
                        {loc}: <strong>{q}</strong>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="w-20 px-2 py-2 bg-secondary/30 border border-border rounded text-center text-lg font-mono font-bold">
                    {picked}
                  </div>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
              </div>
              
              {isExpanded && locsArr.length > 0 && (
                <div className="px-3 pb-3 border-t border-border/50 pt-3 bg-secondary/10">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground font-black">
                      <MapPin className="w-3 h-3 inline mr-1" />Desglose por Ubicación
                    </div>
                    <span className="text-[10px] text-muted-foreground italic">Ingresa cuánto sacaste de cada estante</span>
                  </div>
                  <div className="space-y-2">
                    {locsArr.map((l, i) => {
                      const currentLocPicked = sizeData.details[l.location] || 0;
                      return (
                        <div key={i} className="flex items-center justify-between px-3 py-2 bg-background border border-border/50 rounded-xl hover:border-primary/40 transition-all group">
                          <div className="flex flex-col">
                            <span className="font-mono font-black text-primary text-sm">{l.location}</span>
                            <span className="text-[10px] text-muted-foreground">Disponible: <strong className="text-green-500">{l.available}</strong></span>
                          </div>
                          <div className="flex items-center gap-3">
                            <input 
                              type="number" min="0" max={l.available}
                              value={currentLocPicked || ''}
                              onChange={(e) => updatePicked(sz, l.location, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="0"
                              className="w-16 px-2 py-1 bg-secondary/30 border border-border rounded text-center text-sm font-bold"
                            />
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                const needed = required - picked + currentLocPicked;
                                const toPick = Math.min(needed, l.available);
                                updatePicked(sz, l.location, toPick);
                              }}
                              className="px-2 py-1 bg-primary text-white text-[10px] font-black uppercase rounded hover:bg-primary/80 transition-all"
                            >
                              MAX
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 sticky bottom-0 bg-background pt-3 pb-2 border-t border-border">
        <button
          onClick={() => onSave(ticket.ticket_id, pickedSizes, false)}
          disabled={saving}
          className="flex-1 px-4 py-3 bg-secondary text-foreground rounded-lg text-sm font-bold flex items-center justify-center gap-2 hover:bg-secondary/80 disabled:opacity-50"
          data-testid="operator-save-partial"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Guardar Progreso
        </button>
        <button
          onClick={() => onSave(ticket.ticket_id, pickedSizes, true)}
          disabled={saving || !isComplete}
          className="flex-1 px-4 py-3 bg-green-600 text-white rounded-lg text-sm font-bold flex items-center justify-center gap-2 hover:bg-green-700 disabled:opacity-50"
          data-testid="operator-complete-pick"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Completar Surtido
        </button>
      </div>
    </div>
  );
};

export default function OperatorView() {
  const { user, logout } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTicketAlert, setNewTicketAlert] = useState(false);
  const wsRef = useRef(null);

  const loadTickets = useCallback(async () => {
    try {
      const data = await fetcher('/operator/my-tickets');
      setTickets(data);
      if (selectedTicket) {
        const updated = data.find(t => t.ticket_id === selectedTicket.ticket_id);
        if (updated) setSelectedTicket(updated);
        else setSelectedTicket(null);
      }
    } catch {
      toast.error('Error al cargar tickets');
    } finally {
      setLoading(false);
    }
  }, [selectedTicket]);

  useEffect(() => { loadTickets(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket for real-time notifications
  useEffect(() => {
    if (!user) return;
    const connect = () => {
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'ticket_assigned') {
              const data = msg.data || {};
              // Check if this ticket is assigned to me
              const userId = user.user_id || user.email || '';
              if (data.assigned_to === userId || data.assigned_to === user.email) {
                setNewTicketAlert(true);
                toast.success(
                  `Nuevo ticket asignado: ${data.order_number || data.ticket_id}`,
                  { duration: 8000, icon: <Bell className="w-4 h-4" /> }
                );
                // Play notification sound
                try { new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbsGczHi2GtN/NjVgyJEqFqMy6dkAxI0OAtdPLi1w5LUt+rMexbUMtJ0R/sMy4cUUuKER8q8KtaEIuKkh8qL+oYz0sK0x9qb+oYz0sK0x9qL6kXDcnJkp3p76mYDorKkp3pL6mYDonJkp2or6lXjchI0Zzo76oYz4uK0t9qL2iWzYmJkl3p8CuaEYwLUuAr8q2cEEsJkB8r8+/f0w1K0Z8q8CrZD0rKUx7p7mkWzUpKEt5pbWfVi8mJ0p4o7KaUi0lJkh2oK+UTSokJEd2n6yPRygjI0V0naqMRCcjI0VznKiKQicjI0V0naqMRCcjIw==').play(); } catch {}
                // Refresh tickets
                loadTickets();
                setTimeout(() => setNewTicketAlert(false), 3000);
              }
            }
          } catch {}
        };
        ws.onclose = () => { setTimeout(connect, 3000); };
        ws.onerror = () => { ws.close(); };
      } catch {}
    };
    connect();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async (ticketId, pickedSizes, isComplete) => {
    setSaving(true);
    try {
      const res = await putter(`/pick-tickets/${ticketId}/pick-progress`, {
        picked_sizes: pickedSizes,
        is_complete: isComplete
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(isComplete ? 'Surtido completado!' : 'Progreso guardado');
        if (isComplete) {
          setSelectedTicket(null);
        }
        await loadTickets();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al guardar');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setSaving(false);
    }
  };

  const pendingTickets = tickets.filter(t => t.picking_status !== 'completed');
  const inProgressTickets = pendingTickets.filter(t => t.picking_status === 'in_progress');
  const assignedTickets = pendingTickets.filter(t => t.picking_status === 'assigned');

  return (
    <div className="min-h-screen bg-background" data-testid="operator-view">
      <Toaster position="bottom-right" theme="dark" />
      {/* Header */}
      <header className="bg-card border-b border-border px-4 py-3 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <ClipboardCheck className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-base font-bold text-foreground">Surtido de Pedidos</h1>
            <p className="text-xs text-muted-foreground">{user?.name || user?.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {newTicketAlert && (
            <span className="flex items-center gap-1 text-xs bg-green-500/15 text-green-400 px-2 py-1 rounded-full animate-pulse font-bold" data-testid="operator-new-ticket-alert">
              <Bell className="w-3 h-3" /> Nuevo ticket!
            </span>
          )}
          <span className="text-xs bg-primary/15 text-primary px-2 py-1 rounded-full font-bold">
            {pendingTickets.length} pendiente{pendingTickets.length !== 1 ? 's' : ''}
          </span>
          <button onClick={logout} className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-secondary" data-testid="operator-logout">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <div className="flex h-[calc(100vh-57px)]">
        {/* Ticket List Sidebar */}
        <aside className="w-80 border-r border-border bg-card p-4 overflow-y-auto flex-shrink-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : pendingTickets.length === 0 ? (
            <div className="text-center py-12">
              <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
              <p className="text-sm font-bold text-foreground">Todo al dia!</p>
              <p className="text-xs text-muted-foreground mt-1">No tienes tickets pendientes</p>
            </div>
          ) : (
            <div className="space-y-4">
              {inProgressTickets.length > 0 && (
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-yellow-400 font-bold mb-2 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> En Progreso ({inProgressTickets.length})
                  </h3>
                  <div className="space-y-2">
                    {inProgressTickets.map(t => (
                      <TicketCard key={t.ticket_id} ticket={t} onSelect={setSelectedTicket} isActive={selectedTicket?.ticket_id === t.ticket_id} />
                    ))}
                  </div>
                </div>
              )}
              {assignedTickets.length > 0 && (
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-blue-400 font-bold mb-2 flex items-center gap-1">
                    <ClipboardCheck className="w-3 h-3" /> Asignados ({assignedTickets.length})
                  </h3>
                  <div className="space-y-2">
                    {assignedTickets.map(t => (
                      <TicketCard key={t.ticket_id} ticket={t} onSelect={setSelectedTicket} isActive={selectedTicket?.ticket_id === t.ticket_id} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>

        {/* Main Picking Area */}
        <main className="flex-1 p-6 overflow-y-auto">
          {selectedTicket ? (
            <PickingInterface ticket={selectedTicket} onSave={handleSave} saving={saving} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <ClipboardCheck className="w-16 h-16 text-muted-foreground/30 mb-4" />
              <h2 className="text-lg font-bold text-foreground mb-1">Selecciona un ticket</h2>
              <p className="text-sm text-muted-foreground">Elige un pick ticket de la lista para comenzar el surtido</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
