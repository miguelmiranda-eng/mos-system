/* Sistema → Configuración: un solo lugar para lo que antes estaba regado.
   Pestañas (cada una aparece solo si el usuario tiene la acción que la
   gobierna, misma que valida el backend):
   · Permisos        — por acción y por módulo (config.permissions)
   · Catálogos       — lo que era "Configuración WMS"
   · Catálogo UPC
   · Número de parte — IMMEX: prefijos, prendas, fibras… (asn.part_number_config);
                       Entradas conserva el botón como atajo al mismo panel
   · Columnas        — columnas personalizadas de Entradas (asn.columns)
   · Notificaciones  — alertas push de ESTE dispositivo (notifications.push) */
import { useState } from "react";
import { ShieldCheck, BookOpen, ScanLine, Hash, Columns3, Bell, BellOff, Send, Loader2 } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { useWms } from "./lib";
import { HomeModule } from "./Home";
import { UpcCatalog } from "./UpcCatalog";
import { PermissionsPanel } from "./PermissionsPanel";
import { AsnConfigPanel } from "./AsnConfigModal";
import { AsnColumnsPanel } from "./AsnColumnsPanel";
import { Btn } from "./ui";

const TAB_KEY = 'mos_wms_settings_tab';

export const SettingsModule = () => {
  const { t } = useLang();
  const { can } = useWms();
  const canPerms = can('config.permissions');
  const isManager = can('upc.correct');
  const tabs = [
    ...(canPerms ? [{ id: 'permissions', label: t('wms_settings_tab_permissions'), icon: ShieldCheck }] : []),
    { id: 'catalogs', label: t('wms_settings_tab_catalogs'), icon: BookOpen },
    { id: 'upc', label: t('wms_settings_tab_upc'), icon: ScanLine },
    ...(can('asn.part_number_config') ? [{ id: 'part_number', label: t('wms_settings_tab_part_number'), icon: Hash }] : []),
    ...(can('asn.columns') ? [{ id: 'columns', label: t('wms_settings_tab_columns'), icon: Columns3 }] : []),
    ...(can('notifications.push') ? [{ id: 'notifications', label: t('wms_settings_tab_notifications'), icon: Bell }] : []),
  ];
  // Sin pestaña guardada, `tab` queda null y la activa es la primera visible:
  // así el supersu cae en Permisos aunque can() cargue después del montaje.
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(TAB_KEY) || null; } catch { return null; } });
  const active = tabs.some(x => x.id === tab) ? tab : tabs[0].id;
  const pick = (id) => { setTab(id); try { localStorage.setItem(TAB_KEY, id); } catch { /* sin storage */ } };

  return (
    <div className="space-y-6">
      <div className="inline-flex flex-wrap gap-1 bg-muted/40 border border-border rounded-lg p-1" data-testid="wms-settings-tabs">
        {tabs.map(x => {
          const Icon = x.icon;
          const on = x.id === active;
          return (
            <button key={x.id} onClick={() => pick(x.id)} data-testid={`settings-tab-${x.id}`}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-xs font-bold uppercase tracking-wider transition-colors
                ${on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              <Icon className="w-4 h-4" /> {x.label}
            </button>
          );
        })}
      </div>
      {active === 'permissions' && canPerms && <PermissionsPanel />}
      {active === 'catalogs' && <HomeModule />}
      {active === 'upc' && <UpcCatalog isManager={isManager} />}
      {active === 'part_number' && <AsnConfigPanel embedded />}
      {active === 'columns' && <AsnColumnsPanel />}
      {active === 'notifications' && <NotificationsPanel />}
    </div>
  );
};

/* Alertas push de este dispositivo: mismo estado que la campana de la barra
   (WmsContext.push), aquí con explicación y botón de prueba. */
const NotificationsPanel = () => {
  const { t } = useLang();
  const { push } = useWms();
  if (!push) return null;
  const on = push.on === true;
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="wms-notifications-panel">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Bell className="w-4 h-4 text-primary" /> {t('wms_notif_title')}</h2>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t('wms_notif_help')}</p>
      </div>
      <div className="px-5 py-4 space-y-4">
        {!push.supported ? (
          <div className="text-sm text-amber-600 dark:text-amber-400">{t('wms_notif_unsupported')}</div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className={`w-9 h-9 rounded-full flex items-center justify-center ${on ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
                {on ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
              </span>
              <div>
                <div className="text-sm font-medium text-foreground" data-testid="wms-notif-status">{push.on === null ? t('wms_notif_checking') : on ? t('wms_alerts_active') : t('wms_notif_off_status')}</div>
                <div className="text-xs text-muted-foreground">{t('wms_notif_device_note')}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn variant={on ? 'secondary' : 'primary'} onClick={push.toggle} disabled={push.busy || push.on === null} data-testid="wms-notif-toggle">
                {push.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : on ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                {on ? t('wms_notif_disable') : t('wms_notif_enable')}
              </Btn>
              {on && <Btn onClick={push.test} disabled={push.busy} data-testid="wms-notif-test"><Send className="w-4 h-4" /> {t('wms_notif_test')}</Btn>}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default SettingsModule;
