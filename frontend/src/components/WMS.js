import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import {
  Package, MapPin, ClipboardList, BarChart3, ClipboardCheck,
  CheckCircle, History, ArrowLeft, Warehouse, FileDown,
  ScanLine, X, ChevronRight, Settings, Loader2, Menu,
  Sun, Moon, LayoutDashboard, LogOut, Scissors, Clock, Truck,
} from "lucide-react";

import InventoryDashboard from "./InventoryDashboard";
import OrderHistoryModal from "./OrderHistoryModal";
import { useLang } from "../contexts/LanguageContext";
import { useTheme } from "../contexts/ThemeContext";
import { API, AUTH_API, fetcher, logLoadError, WmsContext, useWms, useHttpBusy } from "./wms/lib";
import { useWmsWebSocket } from "./wms/useWmsWebSocket";
import { BoxStatus, TicketStatus, CycleCountStatus } from "./wms/constants";
import { HomeModule } from "./wms/Home";
import { ReceivingModule } from "./wms/Receiving";
import { PutawayModule } from "./wms/Putaway";
import { InventoryModule } from "./wms/Inventory";
import { LocationsModule } from "./wms/Locations";
import { PickingModule } from "./wms/Picking";
import { NeckCuttingModule } from "./wms/NeckCutting";
import { FinishedGoodsModule } from "./wms/FinishedGoods";
import { MovementsModule } from "./wms/Movements";
import { CycleCountModule } from "./wms/CycleCount";
import { DirectedWorkModule } from "./wms/DirectedWork";
import { AsnModule } from "./wms/Asn";
import { TransitModule } from "./wms/Transit";

// Re-export useWms so external consumers keep the same import path
export { useWms };

const renderActiveModule = (moduleId, ctx) => {
  switch (moduleId) {
    case 'home':         return <HomeModule onNavigate={ctx.setActiveModule} />;
    case 'directed':     return <DirectedWorkModule />;
    case 'dashboard':    return <InventoryDashboard customer={ctx.associatedCustomer} apiBase={API} />;
    case 'receiving':    return <ReceivingModule />;
    case 'transit':      return <TransitModule />;
    case 'putaway':      return <PutawayModule />;
    case 'inventory':    return <InventoryModule initialCustomer={ctx.associatedCustomer} />;
    case 'locations':    return <LocationsModule currentUser={ctx.currentUser} />;
    case 'picking':      return <PickingModule />;
    case 'neck_cutting': return <NeckCuttingModule />;
    case 'finished':     return <FinishedGoodsModule />;
    case 'movements':    return <MovementsModule />;
    case 'cycle_count':  return <CycleCountModule />;
    case 'asn':          return <AsnModule currentUser={ctx.currentUser} />;
    default:             return <ReceivingModule />;
  }
};

export default function WMS() {
  const navigate = useNavigate();
  const { t } = useLang();
  const [activeModule, setActiveModule] = useState('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false); // off-canvas drawer on phones/PDAs
  // Short transient flag shown the moment the user clicks a different module
  // so the content area doesn't look frozen until the new module's first paint.
  const [moduleSwitching, setModuleSwitching] = useState(false);
  const isFirstModuleRender = useRef(true);
  const httpBusyRaw = useHttpBusy();
  // Debounce: only show the global progress bar after sustained busy >400ms.
  // Short requests (badge refreshes, fast polls) shouldn't make it blink.
  const [httpBusy, setHttpBusy] = useState(false);
  useEffect(() => {
    if (!httpBusyRaw) { setHttpBusy(false); return; }
    const id = setTimeout(() => setHttpBusy(true), 400);
    return () => clearTimeout(id);
  }, [httpBusyRaw]);
  const { theme, toggleTheme: toggleAppTheme } = useTheme();
  const isDark = theme === 'dark';
  const [badges, setBadges] = useState({ putaway: 0, picking: 0, cycle_count: 0, neck_cutting: 0 });
  const [currentUser, setCurrentUser] = useState(null);
  // Pickers see a simple 2-option launcher (Picking / Putaway) on entry.
  const [pickerHome, setPickerHome] = useState(true);
  const [historyOrder, setHistoryOrder] = useState(null);
  const [globalSearch, setGlobalSearch] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // Fetch current user to detect associated_customer for auto-filtering
  useEffect(() => {
    fetch(`${AUTH_API}/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => { if (u) setCurrentUser(u); })
      .catch(logLoadError('current user'));
  }, []);

  const associatedCustomer = currentUser?.associated_customer || '';

  // Show "switching…" spinner for 200ms whenever the active module changes
  useEffect(() => {
    if (isFirstModuleRender.current) { isFirstModuleRender.current = false; return; }
    setModuleSwitching(true);
    const t = setTimeout(() => setModuleSwitching(false), 200);
    return () => clearTimeout(t);
  }, [activeModule]);

  const MODULES = [
    { id: 'home', label: 'Configuración WMS', icon: Settings, color: 'text-primary', desc: 'Catálogos editables para los dropdowns de Receiving / Picking' },
    { id: 'directed', label: t('wms_mod_directed') || 'Directed Work', icon: ScanLine, color: 'text-yellow-400', desc: t('wms_mod_directed_desc') || 'Instrucciones inteligentes para el piso' },
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, color: 'text-primary', desc: 'Visión general del inventario en tiempo real' },
    { id: 'receiving', label: t('wms_mod_receiving'), icon: Package, color: 'text-blue-400', desc: t('wms_mod_receiving_desc') },
    { id: 'transit', label: 'Putaway 2.0', icon: Truck, color: 'text-amber-400', desc: 'Carros de tránsito — cajas pendientes de ubicación física' },
    // STANDBY — Putaway 1.0 oculto del sidebar. Reemplazado por Putaway 2.0 (id: 'transit').
    // El import + el case 'putaway' del switch se quedan vivos por si hay que reactivarlo.
    // { id: 'putaway', label: t('wms_mod_putaway'), icon: MapPin, color: 'text-purple-400', desc: t('wms_mod_putaway_desc') },
    { id: 'inventory', label: t('wms_mod_inventory'), icon: BarChart3, color: 'text-emerald-400', desc: t('wms_mod_inventory_desc') },
    { id: 'locations', label: 'Locaciones', icon: MapPin, color: 'text-cyan-400', desc: 'Mapa lógico y gestión de ubicaciones' },
    { id: 'picking', label: t('wms_mod_picking'), icon: ClipboardCheck, color: 'text-indigo-400', desc: t('wms_mod_picking_desc') },
    { id: 'neck_cutting', label: 'Corte de Neck', icon: Scissors, color: 'text-pink-400', desc: 'Material surtido en espera de corte' },
    { id: 'finished', label: t('wms_mod_finished'), icon: CheckCircle, color: 'text-cyan-400', desc: t('wms_mod_finished_desc') },
    { id: 'movements', label: t('wms_mod_movements'), icon: History, color: 'text-slate-400', desc: t('wms_mod_movements_desc') },
    { id: 'asn', label: 'ASN', icon: FileDown, color: 'text-orange-400', desc: 'Avisos de Llegada' },
    { id: 'cycle_count', label: t('wms_mod_cycle_count'), icon: ClipboardList, color: 'text-lime-400', desc: t('wms_mod_cycle_count_desc') },
  ];

  const loadBadges = useCallback(async () => {
    try {
      const [pendingBoxes, pendingTickets, activeCounts, neckCutting] = await Promise.all([
        fetcher(`/boxes?status=${BoxStatus.RECEIVED}`),
        fetcher(`/pick-tickets?status=${TicketStatus.PENDING}`),
        fetcher(`/cycle-counts?status=${CycleCountStatus.IN_PROGRESS}`),
        fetcher('/neck-cutting')
      ]);
      setBadges({
        putaway: pendingBoxes.length || 0,
        picking: pendingTickets.length || 0,
        cycle_count: activeCounts.length || 0,
        neck_cutting: neckCutting.length || 0
      });
    } catch (err) { logLoadError('badges')(err); }
  }, []);

  // Initial badge load (subsequent updates come from WebSocket)
  useEffect(() => { loadBadges(); }, [loadBadges]);

  // Subscribe to WMS events for real-time badge updates
  useWmsWebSocket(loadBadges);

  const wmsCtx = useMemo(() => ({ badges, refreshBadges: loadBadges }), [badges, loadBadges]);

  // Forzar módulo inicial según rol (customer=dashboard, picker=directed)
  useEffect(() => {
    if (currentUser?.role === 'customer') {
      setActiveModule('dashboard');
    } else if (currentUser?.role === 'picker') {
      // Pickers land on a 2-option launcher (Picking / Putaway), not a module.
      setPickerHome(true);
    }
  }, [currentUser]);

  // Handle URL parameters from Home Dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab) {
      if (tab === 'tintas') setActiveModule('inventory');
      if (tab === 'logs') setActiveModule('movements');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const toggleTheme = toggleAppTheme;

  const handleLogout = async () => {
    try {
      await fetch(`${AUTH_API}/logout`, { method: 'POST', credentials: 'include' });
    } catch (err) {
      // Intentionally non-blocking: even if server logout fails, clear local state.
      console.error('[WMS] logout request failed:', err);
    }
    localStorage.removeItem("mos_user");
    window.location.href = '/';
  };

  const handleGlobalOrderSearch = async (e) => {
    e.preventDefault();
    if (!globalSearch.trim()) return;
    setIsSearching(true);
    try {
      // Usar el endpoint de reportes para buscar la orden por PO
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/reports/order-history/${globalSearch}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setHistoryOrder(data.order);
        setGlobalSearch('');
      } else {
        toast.error('Orden / PO no encontrado');
      }
    } catch {
      toast.error('Error al buscar orden');
    } finally {
      setIsSearching(false);
    }
  };

  // Picker launcher: two big buttons (Picking / Putaway). Picking one enters
  // that module; the sidebar then only exposes those same two.
  if (currentUser?.role === 'picker' && pickerHome) {
    const opts = MODULES.filter(m => ['picking', 'transit'].includes(m.id));
    const firstName = (currentUser?.name || '').trim().split(' ')[0];
    return (
      <div className="h-screen bg-background text-foreground flex flex-col overflow-hidden">
        <Toaster position="bottom-right" theme={isDark ? 'dark' : 'light'} />
        <header className="flex items-center justify-between p-4 border-b border-border/40">
          <span className="font-barlow font-black text-lg italic flex items-center gap-1.5">
            <Warehouse className="w-5 h-5 text-primary" /> MOS <span className="text-primary not-italic ml-0.5">WMS</span>
          </span>
          <div className="flex items-center gap-2">
            <button onClick={toggleTheme} title={isDark ? t('light_mode') : t('dark_mode')}
              className="p-2 rounded-xl bg-secondary/20 hover:bg-secondary/40 text-muted-foreground hover:text-foreground transition-all border border-border/20">
              {isDark ? <Sun className="w-4 h-4 text-primary" /> : <Moon className="w-4 h-4 text-indigo-400" />}
            </button>
            <button onClick={handleLogout} title="Cerrar Sesión"
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-destructive/10 hover:bg-destructive/20 text-destructive/80 hover:text-destructive transition-all border border-destructive/20">
              <LogOut className="w-4 h-4" /> <span className="text-[11px] font-bold uppercase tracking-wider">Salir</span>
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-6">
          <div className="min-h-full flex flex-col items-center justify-center gap-8 sm:gap-10">
            <h1 className="text-2xl sm:text-3xl font-black uppercase tracking-tight text-center">
              {firstName ? `Hola, ${firstName}` : 'Hola'} — ¿Qué vas a hacer?
            </h1>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-6 w-full max-w-3xl">
              {opts.map(m => {
                const Icon = m.icon;
                const badgeCount = m.id === 'transit' ? (badges.putaway || 0) : (badges[m.id] || 0);
                return (
                  <button key={m.id} onClick={() => { if (m.id === 'picking') { navigate('/pda'); } else { setActiveModule(m.id); setPickerHome(false); } }}
                    data-testid={`picker-launch-${m.id}`}
                    className="relative flex flex-col items-center justify-center gap-3 sm:gap-5 p-6 sm:p-14 rounded-3xl border border-border bg-card/60 hover:bg-card hover:border-primary/50 hover:scale-[1.02] active:scale-95 transition-all shadow-xl">
                    {badgeCount > 0 && (
                      <span className="absolute top-4 right-4 min-w-[26px] h-[26px] px-2 rounded-full bg-primary text-primary-foreground text-xs font-black flex items-center justify-center">
                        {badgeCount}
                      </span>
                    )}
                    <div className="p-4 sm:p-6 rounded-2xl bg-primary/10">
                      <Icon className={`w-12 h-12 sm:w-16 sm:h-16 ${m.color}`} />
                    </div>
                    <span className="text-xl sm:text-2xl font-black uppercase tracking-wide text-center">{m.label}</span>
                    <span className="text-xs text-muted-foreground text-center max-w-[220px]">{m.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <WmsContext.Provider value={wmsCtx}>
    <div className="h-screen bg-background flex flex-col text-foreground overflow-hidden">
      <div className="flex-1 flex overflow-hidden">
        <Toaster position="bottom-right" theme={isDark ? 'dark' : 'light'} />
      {/* Mobile backdrop when the nav drawer is open */}
      {mobileNav && <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={() => setMobileNav(false)} />}
      {/* Sidebar — off-canvas drawer on phones/PDAs, static column on md+ */}
      <aside
        className={`${sidebarCollapsed ? 'md:w-16' : 'md:w-64'} w-72 fixed md:static inset-y-0 left-0 z-40 md:z-20 transform transition-transform duration-300 ${mobileNav ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 bg-card md:bg-card/40 backdrop-blur-xl border-r border-border/50 flex flex-col shadow-2xl`}
      >
        <div className="p-4 border-b border-border/40 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => currentUser?.role === 'picker' ? setPickerHome(true) : navigate('/dashboard')}
              className="p-1.5 rounded-lg bg-secondary/50 hover:bg-primary/20 text-muted-foreground hover:text-primary transition-all group"
              title={currentUser?.role === 'picker' ? 'Inicio' : t('wms_back_main')}          >
              <ArrowLeft className="w-5 h-5 group-hover:-translate-x-0.5 transition-transform" />
            </button>
            {!sidebarCollapsed && (
              <div className="flex flex-col">
                <span className="font-barlow font-black text-lg tracking-tighter flex items-center gap-1.5 italic">
                  <Warehouse className="w-5 h-5 text-primary" />
                  MOS <span className="text-primary not-italic tracking-normal ml-0.5">WMS</span>
                </span>
              </div>
            )}
            <button
              onClick={() => { if (typeof window !== 'undefined' && window.innerWidth < 768) { setMobileNav(false); } else { setSidebarCollapsed(!sidebarCollapsed); } }}
              className="ml-auto p-1.5 rounded-lg hover:bg-secondary/80 text-muted-foreground transition-all"
            >
              {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <X className="w-4 h-4" />}
            </button>
          </div>

          <div className={`flex ${sidebarCollapsed ? 'flex-col' : 'flex-row'} gap-2`}>
            <button
              onClick={toggleTheme}
              className="flex-1 flex items-center justify-center gap-2 p-2 rounded-xl bg-secondary/10 hover:bg-secondary/40 text-muted-foreground hover:text-foreground transition-all border border-border/20"
              title={isDark ? t('light_mode') : t('dark_mode')}
              data-testid="wms-theme-toggle"
            >
              {isDark ? <Sun className="w-4 h-4 text-primary animate-spin-slow" /> : <Moon className="w-4 h-4 text-indigo-400" />}
              {!sidebarCollapsed && <span className="text-[10px] font-bold uppercase tracking-wider">{isDark ? t('light_mode') : t('dark_mode')}</span>}
            </button>

            <button
              onClick={handleLogout}
              className="flex-1 flex items-center justify-center gap-2 p-2 rounded-xl bg-destructive/10 hover:bg-destructive/20 text-destructive/80 hover:text-destructive transition-all border border-destructive/20"
              title="Cerrar Sesión"
            >
              <LogOut className="w-4 h-4" />
              {!sidebarCollapsed && <span className="text-[10px] font-bold uppercase tracking-wider">Salir</span>}
            </button>
          </div>
        </div>

        <nav className="flex-1 py-4 space-y-1 overflow-y-auto px-2 custom-scrollbar">
          {MODULES.filter(m => {
            if (currentUser?.role === 'customer') return m.id === 'dashboard';
            if (currentUser?.role === 'picker') return ['transit'].includes(m.id);
            return true;
          }).map(m => {
            const Icon = m.icon;
            const isActive = activeModule === m.id;
            const badgeCount = badges[m.id] || 0;

            return (
              <button
                key={m.id}
                onClick={() => { setActiveModule(m.id); setMobileNav(false); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all relative group
                  ${isActive
                    ? 'bg-primary/10 text-primary shadow-[0_0_15px_rgba(255,193,7,0.1)]'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
                data-testid={`wms-nav-${m.id}`}
                title={m.label}
              >
                <div className={`p-1.5 rounded-lg transition-all ${isActive ? 'bg-primary/20 shadow-inner' : 'group-hover:bg-secondary'}`}>
                  <Icon className={`w-5 h-5 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
                </div>

                {!sidebarCollapsed && (
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className={`text-[13px] font-bold uppercase tracking-wide leading-none ${isActive ? 'text-primary' : ''}`}>
                      {m.label}
                    </span>
                    {isActive && (
                      <span className="text-[10px] text-muted-foreground truncate w-full mt-0.5 font-medium italic opacity-70">
                        {t('wms_viewing_now')}
                      </span>
                    )}
                  </div>
                )}

                {!sidebarCollapsed && badgeCount > 0 && (
                  <span className="bg-primary text-black text-[10px] font-black px-1.5 py-0.5 rounded-full min-w-[20px] shadow-[0_0_10px_rgba(255,193,7,0.5)]">
                    {badgeCount}
                  </span>
                )}

                {sidebarCollapsed && badgeCount > 0 && (
                  <div className="absolute top-1 right-1 w-2.5 h-2.5 bg-primary rounded-full shadow-[0_0_5px_rgba(255,193,7,0.8)] border-2 border-card" />
                )}

                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-2/3 bg-primary rounded-r-full shadow-[2px_0_10px_rgba(255,193,7,0.5)]" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-border/40 space-y-2">
          {!sidebarCollapsed && (
            <div className="bg-secondary/30 rounded-xl p-3 border border-border/20 backdrop-blur-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_5px_rgba(34,197,94,0.5)]" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{t('wms_status')}</span>
              </div>
              <div className="text-[11px] font-medium text-foreground opacity-80">{t('wms_terminal')}</div>
              <div className="text-[11px] font-medium text-foreground opacity-80 uppercase">{new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto custom-scrollbar relative">
        {/* Global progress bar — always reserves its 2px row to prevent layout
            shift when HTTP requests start/finish; the inner bar fades in/out. */}
        <div className="sticky top-0 z-[60] h-0.5 overflow-hidden pointer-events-none">
          <div
            className={`h-full w-full bg-gradient-to-r from-primary/0 via-primary to-primary/0 animate-[wms-progress_1.2s_linear_infinite] transition-opacity duration-150 ${(httpBusy || moduleSwitching) ? 'opacity-100' : 'opacity-0'}`}
          />
        </div>
        {/* Module Header Overlay */}
        <div className="sticky top-0 z-10 p-3 sm:p-6 pb-2 bg-gradient-to-b from-background via-background/95 to-transparent backdrop-blur-sm">
          {(() => {
            const m = MODULES.find(mod => mod.id === activeModule);
            const Icon = m?.icon || Package;
            return (
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5 sm:gap-4 min-w-0">
                  <button onClick={() => setMobileNav(true)} className="md:hidden p-2 rounded-xl bg-card border border-border/40 text-muted-foreground active:bg-secondary shrink-0" title="Menú">
                    <Menu className="w-6 h-6" />
                  </button>
                  <div className={`hidden sm:block p-3 rounded-2xl bg-card border border-border/40 shadow-xl ${m?.color || 'text-primary'}`}>
                    <Icon className="w-8 h-8" />
                  </div>
                  <div className="min-w-0">
                    <h1 className="text-xl sm:text-3xl font-black italic uppercase tracking-tighter leading-none mb-1 truncate">
                      {m?.label}
                    </h1>
                    <p className="hidden sm:flex text-sm text-muted-foreground font-medium items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                      {m?.desc}
                    </p>
                  </div>
                </div>
                {/* Global Search Order - Admin Only */}
                <div className="flex items-center gap-4">
                  <div className="hidden lg:flex flex-col items-end">
                    <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground opacity-50 mb-1">{t('wms_mgmt')}</div>
                    <div className="text-lg font-mono font-black text-foreground/80 tabular-nums">
                      {new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Component Content — key forces remount on module switch, plus fade-in */}
        <div className="p-3 sm:p-6 pt-2">
          {moduleSwitching ? (
            <div className="flex flex-col items-center justify-center py-20 animate-in fade-in duration-150">
              <Loader2 className="w-10 h-10 animate-spin text-primary" />
              <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 mt-3">Cargando módulo…</span>
            </div>
          ) : (
            <div key={activeModule} className="animate-in fade-in duration-200">
              {renderActiveModule(activeModule, { associatedCustomer, setActiveModule, currentUser })}
            </div>
          )}
        </div>
        <OrderHistoryModal order={historyOrder} isOpen={!!historyOrder} onClose={() => setHistoryOrder(null)} />
      </main>
      </div>
    </div>
    </WmsContext.Provider>
  );
}
