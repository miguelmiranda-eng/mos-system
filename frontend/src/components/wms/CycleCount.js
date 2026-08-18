import { Fragment, useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { ArrowLeft, ChevronUp, ChevronDown, MapPin, Loader2, Download, CheckCircle, Plus, ClipboardList, Trash2, History, BarChart3, FileSpreadsheet, AlertTriangle, Shuffle } from "lucide-react";
import * as XLSX from "xlsx";
import SearchableSelect from "../SearchableSelect";
import { useLang } from "../../contexts/LanguageContext";
import { useAuth } from "../../App";
import { fetcher, poster, putter, deleter, logLoadError, useWmsCatalogs, mergeUnique } from "./lib";
import { PrefixLocationInput } from "./PrefixLocationInput";
import { Btn, Chip, cls, EmptyState, StatCard, Th } from "./ui";

// Tono (Chip de ./ui) por pase/estado del box-scan: cada pestaña conserva su
// color propio, en versión suave — 1er neutro, 2do azul, 3ro ámbar,
// supervisor rojo, cuadradas verde.
const PASS_TONES = { 1: "neutral", 2: "info", 3: "warning", supervisor: "danger", ok: "success" };

// SKU canónico STYLE-COLOR-SIZE — espejo EXACTO de _auto_sku() del backend
// (backend/routers/wms.py). El supervisor teclea estilo/color/talla y el SKU se
// genera solo, para no reintroducir fantasmas por SKU corto tecleado a mano.
const ccAutoSku = (style, color, size) => {
  const s = (style || '').trim();
  if (!s) return '';
  const parts = [s.toUpperCase().replace(/ /g, '-')];
  const c = (color || '').trim();
  const z = (size || '').trim();
  if (c) parts.push(c.toUpperCase().replace(/ /g, '-').slice(0, 10));
  if (z) parts.push(z.toUpperCase());
  return parts.join('-');
};

// ── Helpers de la pestaña Eficiencia (todo en hora LOCAL del navegador) ──────
// Fecha local YYYY-MM-DD, formato de <input type="date">.
const localDateStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// Bucket hora-local "YYYY-MM-DD HH" de un instante ISO UTC.
const localHourKey = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}`;
};
// "YYYY-MM-DD HH" → "dd/mm HH:00" para mostrar.
const fmtHourKey = (k) => `${k.slice(8, 10)}/${k.slice(5, 7)} ${k.slice(11, 13)}:00`;

export const CycleCountModule = () => {
  const { t } = useLang();
  const { user } = useAuth();
  const isAdmin = ['admin', 'supersu', 'inspector_qc', 'qc'].includes(user?.role);
  // Nivel de inventario efectivo (mismo criterio que WMS.js / deps.get_inventory_level):
  // admin/supersu = 3; el resto, su inventory_level numérico. Gatea el 3er conteo.
  const invLevel = (user?.role === 'supersu' || user?.role === 'admin')
    ? 3 : (parseInt(user?.inventory_level, 10) || 0);
  // Quién puede generar/exportar reportes: mismo criterio que la pestaña
  // Eficiencia y que el backend (/cycle-counts/{id}/report exige inventory_level 3).
  const canExportReport = user?.access_level >= 5 || user?.role === 'supersu'
    || user?.role === 'admin' || invLevel >= 3;
  const [counts, setCounts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [selectedCount, setSelectedCount] = useState(null);
  const [operators, setOperators] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState({ customers: [], styles: [], colors: [], locations: [] });
  // Zonas del almacen para el conteo ALEATORIO: [{zone,total,with_stock}].
  const [zones, setZones] = useState([]);
  const [form, setForm] = useState({ name: '', is_general: false, is_random: false, random_zones: [], random_per_zone: 5, random_only_stocked: false, location_filter: '', customer_filter: '', style_filter: '', color_filter: '', include_empty: false, assigned_to: '', assigned_to_name: '' });
  const [expandedLocations, setExpandedLocations] = useState({});
  // Box-scan mode: pestaña de pase activa y borrador de escaneo por ubicación.
  const [scanPass, setScanPass] = useState('1'); // '1'|'2'|'3'|'supervisor'|'ok'
  const [scanDraft, setScanDraft] = useState({}); // { [location]: textoLPN }
  // Identificación de caja física: las cajas del import por Excel traen un
  // box_id inventado que NO está impreso en el cartón (el cartón dice "A-123").
  // Al escanear un código desconocido el backend pide el SKU (solo si la
  // ubicación tiene varios) y las unidades reales, y ata el número a la caja.
  const [bindPrompt, setBindPrompt] = useState(null);
  // { loc, code, candidates:[], total, target, units }
  // Ubicación abierta. El conteo general trae miles de ubicaciones: se listan
  // como LÍNEA compacta y solo la abierta despliega el escaneo, para que el
  // contador no se sature.
  const [openLoc, setOpenLoc] = useState(null);
  // Resolución manual del supervisor: { [`${loc}:${boxId}`]: {action,units,sku,color,size,customer} }
  const [supForm, setSupForm] = useState({});
  const [resolvingSup, setResolvingSup] = useState(false);
  // País y composición para las cajas que nacen en el conteo: se ofrecen desde
  // el catálogo curado (mismo origen que Receiving) en vez de texto libre. Es
  // lo que evita que vuelvan a entrar valores como 'WASH COLD' o una
  // composición en el campo país, que hubo que limpiar de 748 cajas.
  const wmsCat = useWmsCatalogs();
  const countryOptions = mergeUnique(wmsCat.countries);
  const fabricOptions = mergeUnique(wmsCat.fabrics);
  // ── Modal de confirmación genérico para acciones destructivas ───────────────
  // { title, message, onConfirm } | null
  const [confirmDialog, setConfirmDialog] = useState(null);

  const [activeTab, setActiveTab] = useState('active'); // 'active' | 'kpis' | 'efficiency' | 'cuarentena'
  // Cola de ubicaciones con material de la carga inicial de Excel, reportada
  // por el piso al toparse con una caja no confiable.
  const [cuarentena, setCuarentena] = useState(null);
  const [loadingCuar, setLoadingCuar] = useState(false);
  const loadCuarentena = useCallback(async () => {
    setLoadingCuar(true);
    try {
      const d = await fetcher('/quarantine/locations');
      setCuarentena(d.items || []);
    } catch (e) { logLoadError('cola de auditoría')(e); setCuarentena([]); }
    finally { setLoadingCuar(false); }
  }, []);

  // ── KPIs de UN conteo (gate nivel 3, igual que el reporte) ────────────────
  // Reusa /cycle-counts/{id}/report: el mismo payload del Excel, pintado en
  // pantalla. `box_kpis` solo trae datos en conteos por escaneo.
  const [kpiCountId, setKpiCountId] = useState('');
  const [kpiReport, setKpiReport] = useState(null);
  const [loadingKpi, setLoadingKpi] = useState(false);

  const loadKpis = useCallback(async (countId) => {
    if (!countId) { setKpiReport(null); return; }
    setLoadingKpi(true);
    try {
      setKpiReport(await fetcher(`/cycle-counts/${countId}/report`));
    } catch {
      toast.error('Error cargando KPIs del conteo');
      setKpiReport(null);
    } finally {
      setLoadingKpi(false);
    }
  }, []);

  // ── Eficiencia (gate nivel 3 en el backend): cierres de ubicación por
  // contador. El endpoint regresa eventos crudos (un pase cerrado por evento);
  // TODA la agregación se hace en el frontend, en hora local del navegador.
  const [effFrom, setEffFrom] = useState(() => localDateStr());
  const [effTo, setEffTo] = useState(() => localDateStr());
  const [effEvents, setEffEvents] = useState(null); // null = aún sin cargar
  const [loadingEff, setLoadingEff] = useState(false);
  const [effOpen, setEffOpen] = useState(null); // by_name del contador expandido

  const loadEfficiency = async () => {
    if (!effFrom || !effTo) { toast.error('Selecciona ambas fechas'); return; }
    setLoadingEff(true);
    try {
      // Fechas locales → instantes UTC: [desde 00:00 local, hasta+1día 00:00 local)
      const fromUtc = new Date(`${effFrom}T00:00:00`).toISOString();
      const toMid = new Date(`${effTo}T00:00:00`);
      toMid.setDate(toMid.getDate() + 1);
      const data = await fetcher(`/cycle-counts/efficiency?from_utc=${encodeURIComponent(fromUtc)}&to_utc=${encodeURIComponent(toMid.toISOString())}`);
      setEffEvents(data.events || []);
      setEffOpen(null);
    } catch {
      toast.error('Error cargando eficiencia');
    } finally {
      setLoadingEff(false);
    }
  };

  // Reporte de UN conteo: `exportCountById` carga /cycle-counts/{id}/report y
  // llama esto para generar el Excel directo desde la lista de conteos activos.
  const exportExcel = (reportDetail) => {
    if (!reportDetail) return;
    const wb = XLSX.utils.book_new();
    const now = new Date().toLocaleString();

    // ── HOJA 1: Portada / Resumen Ejecutivo ──────────────────────────────
    const dur = reportDetail.kpis.duration_mins != null
      ? `${Math.floor(reportDetail.kpis.duration_mins / 60)}h ${reportDetail.kpis.duration_mins % 60}min`
      : 'N/A';
    const summaryData = [
      ["REPORTE DE CICLOCONTEO", ""],
      ["Generado el", now],
      ["", ""],
      ["=== INFORMACIÓN DEL CONTEO ===", ""],
      ["ID Conteo",          reportDetail.count_id],
      ["Nombre",             reportDetail.name],
      ["Estado",             reportDetail.status === 'approved' ? 'APROBADO' : reportDetail.status.toUpperCase()],
      ["Tipo",               reportDetail.is_random
                               ? `Aleatorio (${reportDetail.random_per_zone} ubicaciones por zona)`
                               : reportDetail.is_general ? 'General (Inventario Completo)' : 'Filtrado'],
      ["Zonas Muestreadas",  (reportDetail.random_zones || []).join(', ') || '—'],
      ["Filtro Ubicación",   reportDetail.location_filter || '—'],
      ["Filtro Style",       reportDetail.style_filter    || '—'],
      ["Filtro Color",       reportDetail.color_filter    || '—'],
      ["Filtro Cliente",     reportDetail.customer_filter || '—'],
      ["", ""],
      ["=== CRONOLOGÍA ===", ""],
      ["Fecha Creación",     new Date(reportDetail.created_at).toLocaleString()],
      ["Creado por",         reportDetail.created_by_name || '—'],
      ["Fecha Aprobación",   reportDetail.approved_at ? new Date(reportDetail.approved_at).toLocaleString() : 'N/A'],
      ["Aprobado por",       reportDetail.approved_by_name || '—'],
      ["Duración Total",     dur],
      ["", ""],
      ["=== KPIs DE PRECISIÓN ===", ""],
      ["Total Líneas en Sistema",    reportDetail.kpis.total_lines],
      ["Líneas Contadas",            reportDetail.kpis.counted_lines],
      ["Líneas Pendientes",          reportDetail.kpis.total_lines - reportDetail.kpis.counted_lines],
      ["Líneas con Discrepancia",    reportDetail.kpis.discrepant_lines],
      ["Líneas Exactas",             reportDetail.kpis.exact_lines],
      ["Exactitud General",          `${reportDetail.kpis.accuracy_pct}%`],
      ["", ""],
      ["=== KPIs DE INVENTARIO ===", ""],
      ["Unidades Faltantes",         reportDetail.kpis.units_short],
      ["Unidades Sobrantes",         reportDetail.kpis.units_over],
      ["Total Ajustes Aplicados",    reportDetail.kpis.adjusted_count],
      ...(reportDetail.inventory_kpis ? (() => {
        const inv = reportDetail.inventory_kpis;
        const u = inv.discrepancy_unit || 'piezas';
        return [
          ["", ""],
          ["=== PRECISIÓN DE INVENTARIO (ILA / IRA) ===", ""],
          ["Total Piezas en Sistema",    inv.system_pieces ?? 0],
          ["Total Cajas en Sistema",     inv.system_boxes != null ? inv.system_boxes : 'N/A'],
          [`Discrepancia Neta (${u})`,      inv.net_discrepancy ?? 0],
          [`Discrepancia Absoluta (${u})`,  inv.abs_discrepancy ?? 0],
          ["ILA (Inventory Location Accuracy)", inv.ila_pct != null ? `${inv.ila_pct}%` : 'N/A'],
          ["IRA (Inventory Record Accuracy)",   inv.ira_pct != null ? `${inv.ira_pct}%` : 'N/A'],
        ];
      })() : []),
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary['!cols'] = [{ wch: 32 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, "Resumen Ejecutivo");

    // ── HOJA 2: Todas las Líneas (con auditor y horario) ─────────────────
    const allLinesData = reportDetail.all_lines.map(l => ({
      "Ubicación":          l.location,
      "Style":              l.style,
      "Color":              l.color,
      "Talla":              l.size,
      "Cliente":            l.customer,
      "Cant. Sistema":      l.system_qty,
      "Cant. Contada":      l.counted_qty ?? '',
      "Diferencia":         l.discrepancy ?? '',
      "¿Ajustado?":         l.adjusted ? 'SÍ' : 'NO',
      "¿Contada?":          l.counted ? 'SÍ' : 'PENDIENTE',
      "Auditor":            l.counted_by_name || l.counted_by || '—',
      "Fecha Conteo":       l.counted_at ? new Date(l.counted_at).toLocaleDateString() : '—',
      "Hora Conteo":        l.counted_at ? new Date(l.counted_at).toLocaleTimeString() : '—',
    }));
    const wsAll = XLSX.utils.json_to_sheet(allLinesData);
    wsAll['!cols'] = [14,12,12,8,16,14,14,10,10,10,22,14,12].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, wsAll, "Todas las Líneas");

    // ── HOJA 3: Discrepancias (con auditor, hora, y tipo) ────────────────
    const discData = reportDetail.discrepancy_table.map(l => ({
      "Ubicación":          l.location,
      "Style":              l.style,
      "Color":              l.color,
      "Talla":              l.size,
      "Cliente":            l.customer,
      "Cant. Sistema":      l.system_qty,
      "Cant. Contada":      l.counted_qty,
      "Diferencia":         l.discrepancy,
      "Tipo Error":         l.discrepancy > 0 ? 'SOBRANTE' : 'FALTANTE',
      "Impacto (Abs)": Math.abs(l.discrepancy),
      "¿Ajustado?":         l.adjusted ? 'SÍ' : 'NO',
    }));
    const wsDisc = XLSX.utils.json_to_sheet(discData);
    wsDisc['!cols'] = [14,12,12,8,16,14,14,10,10,12,10].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, wsDisc, "Discrepancias");

    // ── HOJA 4: Cronograma (feed cronológico detallado) ──────────────────
    const timelineData = reportDetail.all_lines
      .filter(l => l.counted && l.counted_at)
      .sort((a, b) => new Date(a.counted_at) - new Date(b.counted_at))
      .map((l, i) => ({
        "#":                  i + 1,
        "Fecha":              new Date(l.counted_at).toLocaleDateString(),
        "Hora":               new Date(l.counted_at).toLocaleTimeString(),
        "Fecha y Hora Completa": new Date(l.counted_at).toLocaleString(),
        "Auditor":            l.counted_by_name || l.counted_by || 'Desconocido',
        "Ubicación":          l.location,
        "Style":              l.style,
        "Color":              l.color,
        "Talla":              l.size,
        "Cant. Sistema":      l.system_qty,
        "Cant. Contada":      l.counted_qty,
        "Diferencia":         l.discrepancy || 0,
        "¿Discrepancia?":     (l.discrepancy && l.discrepancy !== 0) ? 'SÍ' : 'NO',
      }));
    if (timelineData.length > 0) {
      const wsTimeline = XLSX.utils.json_to_sheet(timelineData);
      wsTimeline['!cols'] = [5,12,12,22,22,14,12,12,8,14,14,10,12].map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, wsTimeline, "Cronograma");
    }

    // ── HOJA 5: Cronograma por Auditor ───────────────────────────────────
    const countedLines = reportDetail.all_lines
      .filter(l => l.counted && l.counted_at)
      .sort((a, b) => new Date(a.counted_at) - new Date(b.counted_at));
    const auditorGroups = {};
    countedLines.forEach(l => {
      const name = l.counted_by_name || l.counted_by || 'Desconocido';
      if (!auditorGroups[name]) auditorGroups[name] = [];
      auditorGroups[name].push(l);
    });
    const perAuditorRows = [];
    Object.entries(auditorGroups).forEach(([name, lines]) => {
      const times = lines.map(l => new Date(l.counted_at));
      const start = new Date(Math.min(...times));
      const end   = new Date(Math.max(...times));
      const totalMins = Math.round((end - start) / 60000);
      const diffs = lines.filter(l => l.discrepancy && l.discrepancy !== 0).length;
      const units = lines.reduce((s, l) => s + (l.counted_qty || 0), 0);
      perAuditorRows.push({ AUDITOR: `>>> ${name}`, INICIO: '', FIN: '', DURACION_SESION: '',
        UBICACION: '', STYLE: '', COLOR: '', TALLA: '', SISTEMA: '', CONTADO: '', DIFERENCIA: '', DISCREPANCIA: '',
        '__blank': '' });
      perAuditorRows.push({
        AUDITOR: 'RESUMEN',
        INICIO: start.toLocaleString(), FIN: end.toLocaleString(),
        DURACION_SESION: `${Math.floor(totalMins/60)}h ${totalMins%60}min`,
        UBICACION: `${lines.length} líneas`,
        STYLE: `${units} uds contadas`,
        COLOR: `${diffs} discrepancias`,
        TALLA: '', SISTEMA: '', CONTADO: '', DIFERENCIA: '', DISCREPANCIA: '', '__blank': ''
      });
      lines.forEach((l, i) => {
        const prevTime = i > 0 ? new Date(lines[i-1].counted_at) : null;
        const gap = prevTime ? Math.round((new Date(l.counted_at) - prevTime) / 60000) : null;
        perAuditorRows.push({
          AUDITOR: name,
          INICIO: new Date(l.counted_at).toLocaleTimeString(),
          FIN: '',
          DURACION_SESION: gap != null ? `+${gap} min` : '—',
          UBICACION: l.location,
          STYLE: l.style,
          COLOR: l.color,
          TALLA: l.size,
          SISTEMA: l.system_qty,
          CONTADO: l.counted_qty,
          DIFERENCIA: l.discrepancy || 0,
          DISCREPANCIA: (l.discrepancy && l.discrepancy !== 0) ? 'SÍ' : 'NO',
        });
      });
      perAuditorRows.push({ AUDITOR: '', INICIO: '', FIN: '', DURACION_SESION: '',
        UBICACION: '', STYLE: '', COLOR: '', TALLA: '', SISTEMA: '', CONTADO: '', DIFERENCIA: '', DISCREPANCIA: '' });
    });
    if (perAuditorRows.length > 0) {
      const wsPerAuditor = XLSX.utils.json_to_sheet(perAuditorRows);
      wsPerAuditor['!cols'] = [22,14,14,16,16,14,12,8,12,12,10,12].map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, wsPerAuditor, "Cronograma x Auditor");
    }

    // ── HOJA 6: Productividad ────────────────────────────────────────────
    const auditorStats = {};
    reportDetail.all_lines.filter(l => l.counted).forEach(l => {
      const name = l.counted_by_name || l.counted_by || 'Desconocido';
      if (!auditorStats[name]) auditorStats[name] = { lines: 0, units: 0, diffs: 0, first: null, last: null };
      auditorStats[name].lines += 1;
      auditorStats[name].units += (l.counted_qty || 0);
      if (l.discrepancy && l.discrepancy !== 0) auditorStats[name].diffs += 1;
      if (l.counted_at) {
        const t = new Date(l.counted_at);
        if (!auditorStats[name].first || t < auditorStats[name].first) auditorStats[name].first = t;
        if (!auditorStats[name].last  || t > auditorStats[name].last)  auditorStats[name].last  = t;
      }
    });
    const prodData = Object.entries(auditorStats)
      .map(([name, s], i) => {
        const mins = s.first && s.last ? Math.round((s.last - s.first) / 60000) : null;
        return {
          "#":                    i + 1,
          "Auditor":              name,
          "Hora Inicio":          s.first ? s.first.toLocaleTimeString() : '—',
          "Hora Fin":             s.last  ? s.last.toLocaleTimeString()  : '—',
          "Duración Sesión":      mins != null ? `${Math.floor(mins/60)}h ${mins%60}min` : '—',
          "Líneas Contadas":      s.lines,
          "Unidades Físicas":     s.units,
          "Errores Detectados":   s.diffs,
          "% Precisión":          s.lines > 0 ? `${((s.lines - s.diffs) / s.lines * 100).toFixed(1)}%` : '—',
          "Ritmo (líneas/hora)":  mins > 0 ? (s.lines / (mins / 60)).toFixed(1) : '—',
        };
      })
      .sort((a, b) => b["Líneas Contadas"] - a["Líneas Contadas"]);
    if (prodData.length > 0) {
      const wsProd = XLSX.utils.json_to_sheet(prodData);
      wsProd['!cols'] = [5,22,12,12,16,16,16,16,12,16].map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, wsProd, "Productividad");
    }

    // ── HOJA 7: Por Ubicación ────────────────────────────────────────────
    const locData = reportDetail.location_breakdown.map(l => ({
      "Ubicación":          l.location,
      "Líneas Totales":     l.total,
      "Contadas":           l.counted,
      "Con Discrepancia":   l.discrepant,
      "Sin Discrepancia":   l.counted - l.discrepant,
      "Precisión Ubic. %":  l.counted > 0 ? `${((l.counted - l.discrepant) / l.counted * 100).toFixed(1)}%` : '—',
      "Diferencia Uds Abs": l.units_delta,
    }));
    const wsLoc = XLSX.utils.json_to_sheet(locData);
    wsLoc['!cols'] = [16,14,12,16,16,16,16].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, wsLoc, "Por Ubicación");

    // ── HOJA 8: Detalle por Caja (números de caja escaneados) ────────────
    // Solo aplica a conteos por escaneo (box_scan); vacía en conteos por líneas.
    if (Array.isArray(reportDetail.scanned_boxes) && reportDetail.scanned_boxes.length > 0) {
      const boxData = reportDetail.scanned_boxes.map(b => ({
        "Ubicación":     b.location,
        "N° de Caja":    b.box_id,
        "Tipo":          b.tipo,
        "Estado Ubic.":  b.loc_status,
        "Contado por":   b.counted_by_name || '—',
        "Fecha":         b.counted_at ? new Date(b.counted_at).toLocaleDateString() : '—',
        "Hora":          b.counted_at ? new Date(b.counted_at).toLocaleTimeString() : '—',
      }));
      const wsBoxes = XLSX.utils.json_to_sheet(boxData);
      wsBoxes['!cols'] = [16,18,12,14,22,14,12].map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, wsBoxes, "Detalle por Caja");
    }

    const fname = `CC_${reportDetail.name.replace(/[^a-zA-Z0-9]/g,'_')}_${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb, fname);
  };

  // Exporta el reporte de UN conteo directo desde su fila en la lista, sin abrir
  // el detalle: carga /cycle-counts/{id}/report y genera el mismo Excel.
  const [exportingId, setExportingId] = useState(null);
  const exportCountById = async (countId) => {
    setExportingId(countId);
    try {
      const rd = await fetcher(`/cycle-counts/${countId}/report`);
      if (!rd || !rd.count_id) { toast.error('No se pudo generar el reporte de este conteo'); return; }
      exportExcel(rd);
    } catch { toast.error('No se pudo generar el reporte de este conteo'); }
    finally { setExportingId(null); }
  };

  const load = useCallback(() => { fetcher('/cycle-counts').then(setCounts).catch(logLoadError('data')); }, []);
  useEffect(() => {
    load();
    fetcher('/operators').then(setOperators).catch(logLoadError('data'));
    fetcher('/inventory/options?').then(d => setOptions({
      customers: d.customers || [],
      styles: d.styles || [],
      colors: d.colors || [],
      locations: d.locations || []
    })).catch(logLoadError('data'));
  }, [load]);

  // Las zonas solo hacen falta al abrir el formulario de creacion; se cargan
  // una vez (el catalogo casi no cambia) y no en cada montada del modulo.
  useEffect(() => {
    if (!showForm || zones.length) return;
    fetcher('/locations/zones').then(d => setZones(Array.isArray(d) ? d : [])).catch(logLoadError('zonas'));
  }, [showForm, zones.length]);

  const toggleNewForm = () => setShowForm(!showForm);

  const handleCreate = async () => {
    if (!form.name) { toast.error(t('wms_name_req')); return; }
    if (form.is_random && form.random_zones.length === 0) {
      toast.error('Selecciona al menos una zona para el conteo aleatorio');
      return;
    }
    setLoading(true);
    try {
      const res = await poster('/cycle-counts', {
        ...form,
        random_per_zone: Number(form.random_per_zone) || 5,
        // En aleatorio manda la casilla del panel; el include_empty suelto es
        // para los conteos por filtro.
        include_empty: form.is_random ? !form.random_only_stocked : form.include_empty,
      });
      if (res.ok) {
        const data = await res.json();
        // En aleatorio lo que importa NO son los renglones de inventario sino
        // cuantas ubicaciones salieron sorteadas: eso es lo que va a caminar el
        // contador.
        if (data.is_random) {
          toast.success(`Conteo aleatorio creado: ${data.total_scan_locations} ubicaciones de ${(data.random_zones || []).length} zona(s)`);
        } else {
          toast.success(t('wms_cc_created', { count: data.total_lines }));
        }
        setShowForm(false);
        setForm({ name: '', is_general: false, is_random: false, random_zones: [], random_per_zone: 5, random_only_stocked: false, location_filter: '', customer_filter: '', style_filter: '', color_filter: '', include_empty: false, assigned_to: '', assigned_to_name: '' });
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  const openCount = async (c) => {
    try {
      const data = await fetcher(`/cycle-counts/${c.count_id}`);
      setSelectedCount(data);
    } catch { toast.error(t('wms_cc_load_err')); }
  };

  const handleDelete = async (countId, e) => {
    e.stopPropagation();
    if (!window.confirm(t('wms_cc_delete_conf') || '¿Está seguro de que desea eliminar este conteo cíclico?')) return;
    try {
      const res = await deleter(`/cycle-counts/${countId}`);
      toast.success(res.message || 'Conteo cíclico eliminado correctamente');
      load();
    } catch {
      toast.error('Error al eliminar conteo cíclico');
    }
  };

  const saveProgress = async (countedItems) => {
    if (!selectedCount) return;
    setSaving(true);
    try {
      const res = await putter(`/cycle-counts/${selectedCount.count_id}/count`, { counted_items: countedItems });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.success(data.adjustments
          ? `${t('wms_cc_saved')} · ${data.adjustments} ajuste(s) aplicados al inventario`
          : t('wms_cc_saved'));
        const updated = await fetcher(`/cycle-counts/${selectedCount.count_id}`);
        setSelectedCount(updated);
        load();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error'); }
    finally { setSaving(false); }
  };

  const approveCount = async () => {
    if (!selectedCount) return;
    setConfirmDialog({
      title: 'Aprobar conteo',
      message: '¿Confirmas que quieres aprobar este conteo? Esta acción aplicará los ajustes de inventario y no se puede deshacer.',
      onConfirm: async () => {
        setSaving(true);
        try {
          const res = await putter(`/cycle-counts/${selectedCount.count_id}/approve`, {});
          if (res.ok) {
            const data = await res.json();
            toast.success(data.message || t('success'));
            setSelectedCount(null);
            load();
          } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('error')); }
        } catch { toast.error(t('error')); }
        finally { setSaving(false); }
      },
    });
  };

  // Counting interface
  if (selectedCount) {
    const lines = selectedCount.lines || [];
    const grouped = {};
    lines.forEach(l => {
      const key = l.inv_location || t('wms_no_loc').toUpperCase();
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(l);
    });
    const locations = Object.keys(grouped).sort();
    const totalLines = lines.length;
    const countedLines = lines.filter(l => l.counted).length;
    const discrepancies = lines.filter(l => l.counted && l.discrepancy !== 0).length;
    const pct = totalLines > 0 ? Math.round((countedLines / totalLines) * 100) : 0;

    const handleInputChange = (lineId, val) => {
      setSelectedCount(prev => ({
        ...prev,
        lines: prev.lines.map(l => l.line_id === lineId ? { ...l, counted_qty: val === '' ? null : parseInt(val) || 0 } : l)
      }));
    };

    const handleSaveAll = () => {
      const counted = {};
      lines.forEach(l => {
        if (l.counted_qty !== null && l.counted_qty !== undefined) {
          counted[l.line_id] = l.counted_qty;
        }
      });
      saveProgress(counted);
    };

    // ── BOX-SCAN: conteo por caja (escaneo LPN) por ubicación, 3 pases ──
    // Aplica el resultado de un escaneo ya resuelto. OJO: se guarda el box_id
    // CANÓNICO que devuelve el backend (no el código tecleado), porque el
    // número físico "A-123" queda atado a la caja del sistema.
    const applyScanResult = (loc, data) => {
      const shown = data.scanned_code || data.box_id;
      let alreadyScanned = data.duplicate;
      
      setSelectedCount(prev => ({
        ...prev,
        scan_locations: prev.scan_locations.map(L => {
          if (L.location !== loc) return L;
          const currentScanned = L.scanned_boxes || [];
          if (currentScanned.includes(data.box_id)) {
            alreadyScanned = true;
          }
          return {
            ...L,
            scanned_boxes: alreadyScanned ? currentScanned : [...currentScanned, data.box_id],
            scanned_labels: (data.scanned_code && data.scanned_code !== data.box_id)
              ? { ...(L.scanned_labels || {}), [data.box_id]: data.scanned_code }
              : (L.scanned_labels || {}),
          };
        })
      }));
      if (alreadyScanned) toast.warning(`${shown} ya estaba escaneada`);
      else if (data.bound) toast.success(`${shown} identificada y registrada ✔`);
      else if (!data.expected_here) toast.warning(`⚠️ ${shown} NO pertenece a ${loc} (ajena)`);
    };

    // Envía el escaneo. Si el backend pide SKU o unidades, abre el diálogo.
    const sendScan = async (loc, code, opts = {}) => {
      const payload = { location: loc, box_id: code };
      if (opts.targetBoxId) payload.target_box_id = opts.targetBoxId;
      if (opts.forceUnknown) payload.force_unknown = true;
      if (opts.units !== undefined && opts.units !== '') payload.actual_units = parseInt(opts.units, 10);
      const res = await poster(`/cycle-counts/${selectedCount.count_id}/scan-location`, payload);
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || 'Error al escanear'); return null; }
      const data = await res.json();
      if (data.needs_box) {
        // Código físico sin registrar: el contador elige a MANO a qué caja
        // (de las que tienen LPN genérico en esta ubicación) corresponde.
        setBindPrompt({
          loc, code, candidates: data.candidates || [],
          total: data.candidate_total || (data.candidates || []).length,
          target: '', units: '',
        });
        return data;
      }
      setBindPrompt(null);
      applyScanResult(loc, data);
      return data;
    };

    const scanBox = async (loc) => {
      const boxId = (scanDraft[loc] || '').trim().toUpperCase();
      if (!boxId) return;
      setScanDraft(d => ({ ...d, [loc]: '' }));
      try { await sendScan(loc, boxId); }
      catch { toast.error('Error de conexión'); }
    };

    // Quita un LPN escaneado por error antes de cerrar la ubicación.
    const unscanBox = async (loc, boxId) => {
      try {
        const res = await poster(`/cycle-counts/${selectedCount.count_id}/unscan-location`, { location: loc, box_id: boxId });
        if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || 'Error al quitar'); return; }
        const data = await res.json().catch(() => ({}));
        const canonical = data.box_id || boxId;
        setSelectedCount(prev => ({
          ...prev,
          scan_locations: prev.scan_locations.map(L => L.location === loc
            ? { ...L, scanned_boxes: (L.scanned_boxes || []).filter(b => b !== canonical) }
            : L)
        }));
        toast.success(`${data.scanned_code || boxId} quitada del escaneo`);
      } catch { toast.error('Error de conexión'); }
    };

    // Resolución manual (nivel 3) de una ubicación en 'supervisor': por cada LPN
    // desconocido, crear con unidades tecleadas o descartar, y cerrar la ubicación.
    const resolveSupervisor = async (loc, unknownBoxes) => {
      const resolutions = (unknownBoxes || []).map(b => {
        const f = supForm[`${loc}:${b}`] || {};
        const action = f.action || 'discard';
        return action === 'create'
          ? { box_id: b, action, units: parseInt(f.units, 10) || 0, style: f.style || '', color: f.color || '', size: f.size || '', customer: f.customer || '',
              country_of_origin: f.country_of_origin || '', fabric_content: f.fabric_content || '' }
          : { box_id: b, action: 'discard' };
      });
      const bad = resolutions.find(r => r.action === 'create' && (!r.units || r.units <= 0 || !r.style));
      if (bad) { toast.error(`Falta el estilo o unidades (>0) para crear ${bad.box_id}`); return; }
      // El país y la composición son la identidad del LOTE: sin ellos la caja
      // nace con firma vacía y no casa con ningún renglón. Se avisa, pero no se
      // bloquea — en piso puede tocar un cartón sin etiqueta legible.
      const sinLote = resolutions.filter(r => r.action === 'create' && (!r.country_of_origin || !r.fabric_content));
      if (sinLote.length) {
        const seguir = window.confirm(
          `${sinLote.length} caja(s) se crearán SIN país de origen o sin contenido de tela.\n\n` +
          `Esos campos son la identidad del lote: sin ellos la caja no se puede casar con su ` +
          `renglón de inventario y el país es requisito de etiquetado para exportación.\n\n` +
          `¿Continuar de todas formas?`);
        if (!seguir) return;
      }
      setResolvingSup(true);
      try {
        const res = await poster(`/cycle-counts/${selectedCount.count_id}/resolve-supervisor`, { location: loc, resolutions });
        if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || 'Error'); return; }
        const data = await res.json();
        // El número de caja lo asigna el sistema (secuencia BOX-######), no el
        // código que se escaneó: hay que decírselo al operador para que sepa
        // qué etiqueta imprimir y pegar en el cartón.
        const nuevas = (data.items || []).filter(i => i.action === 'create');
        toast.success(`${loc}: resuelta · ${data.created} creada(s), ${data.discarded} descartada(s)`);
        if (nuevas.length) {
          toast.info(
            `Cajas creadas — imprime y pega estas etiquetas:\n` +
            nuevas.map(i => `${i.box_id}${i.codigo_escaneado && i.codigo_escaneado !== i.box_id
              ? `  (escaneaste ${i.codigo_escaneado})` : ''}`).join('\n'),
            { duration: 15000 });
        }
        const updated = await fetcher(`/cycle-counts/${selectedCount.count_id}`);
        setSelectedCount(updated);
      } catch { toast.error('Error de conexión'); }
      finally { setResolvingSup(false); }
    };

    const closeLocation = async (loc) => {
      try {
        const res = await poster(`/cycle-counts/${selectedCount.count_id}/close-location`, { location: loc });
        if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || 'Error'); return; }
        const data = await res.json();
        const r = data.resolution;
        const acts = r ? (r.moved + r.restored + r.shrunk) : 0;
        const summ = r
          ? [r.moved && `${r.moved} movida(s)`, r.shrunk && `${r.shrunk} agotada(s)`, r.restored && `${r.restored} restaurada(s)`]
              .filter(Boolean).join(' · ')
          : '';
        if (data.needs_supervisor) {
          // Discrepancia confirmada con LPN desconocido(s) → supervisor.
          const unk = r?.unknown?.length ? ` (${r.unknown.length} LPN desconocido[s])` : '';
          toast.error(`${loc}: revisión de supervisor${unk}${acts ? ` · ${summ}` : ''}`);
        } else if (r) {
          // Discrepancia confirmada y resuelta (pase 2 == contador 1, o cierre nivel 3).
          toast.success(acts
            ? `${loc}: ✅ confirmada y resuelta · ${summ}`
            : `${loc}: ✅ confirmada (sin cambios de inventario)`);
        } else if (data.matched) {
          toast.success(`${loc}: ✅ cuadra con el sistema`);
        } else {
          toast.warning(`${loc}: discrepancia → pasa al ${data.pass}° conteo`);
        }
        const updated = await fetcher(`/cycle-counts/${selectedCount.count_id}`);
        setSelectedCount(updated);
      } catch { toast.error('Error de conexión'); }
    };

    if (selectedCount.mode === 'box_scan') {
      const SL = selectedCount.scan_locations || [];
      const needs = (L, n) => L.pass === n && (L.status === 'pending' || L.status === 'escalated');
      const buckets = {
        '1': SL.filter(L => needs(L, 1)),
        '2': SL.filter(L => needs(L, 2)),
        '3': SL.filter(L => needs(L, 3)),
        'supervisor': SL.filter(L => L.status === 'supervisor'),
        'ok': SL.filter(L => L.status === 'ok'),
      };
      // El 3er conteo solo lo procesa inventario nivel 3.
      const canPass3 = invLevel >= 3;
      const TABS = [
        { k: '1', label: '1er Conteo' }, { k: '2', label: '2do Cicloconteo' },
        { k: '3', label: '3er Cicloconteo', lvl3: true }, { k: 'supervisor', label: 'Rev. Supervisor' },
        { k: 'ok', label: 'Cuadradas' },
      ].filter(tb => !tb.lvl3 || canPass3);
      // Si un no-nivel-3 quedó parado en la pestaña 3, mándalo a la 1.
      const effectivePass = (scanPass === '3' && !canPass3) ? '1' : scanPass;
      const active = buckets[effectivePass] || [];
      return (
        <>
        {confirmDialog && (
          <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-card border border-border rounded-lg shadow-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-border">
                <div className="font-semibold text-base text-foreground">{confirmDialog.title}</div>
              </div>
              <div className="px-5 py-4">
                <p className="text-sm text-muted-foreground leading-relaxed">{confirmDialog.message}</p>
              </div>
              <div className="px-5 py-3 bg-muted/40 border-t border-border/40 flex justify-end gap-2">
                <Btn onClick={() => setConfirmDialog(null)}>
                  Cancelar
                </Btn>
                <Btn variant="primary" onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }}>
                  Confirmar
                </Btn>
              </div>
            </div>
          </div>
        )}
        <div className="space-y-4" data-testid="cycle-count-boxscan">
          {/* ── Identificar caja física ──────────────────────────────────────
              Las cajas cargadas por Excel tienen un LPN genérico que NO está
              impreso en el cartón. Al escanear un número físico ("A-123") el
              backend pide el SKU (solo si la ubicación tiene varios) y las
              unidades reales, y lo ata a la caja del sistema. */}
          {bindPrompt && (
            <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" data-testid="cc-bind-modal">
              <div className="w-full max-w-md bg-card border border-border rounded-lg shadow-xl overflow-hidden">
                <div className="px-5 py-3 bg-amber-50 dark:bg-amber-500/10 border-b border-amber-200/70 dark:border-amber-500/25">
                  <div className="font-semibold text-sm text-amber-700 dark:text-amber-300">Identificar caja</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    <span className="font-mono font-medium text-foreground">{bindPrompt.code}</span> en {bindPrompt.loc}
                  </div>
                </div>
                <div className="p-5 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Este número no está en el sistema. Elige a qué caja de <b className="text-foreground">{bindPrompt.loc}</b> corresponde
                    {bindPrompt.total > bindPrompt.candidates.length && (
                      <> <span className="text-amber-500">(mostrando {bindPrompt.candidates.length} de {bindPrompt.total})</span></>
                    )}:
                  </p>
                  <div className="space-y-1.5 max-h-[38vh] overflow-y-auto custom-scrollbar">
                    {bindPrompt.candidates.map(cd => {
                      const sel = bindPrompt.target === cd.box_id;
                      return (
                        <button key={cd.box_id}
                          onClick={() => setBindPrompt(p => ({ ...p, target: cd.box_id }))}
                          className={`w-full text-left px-3 py-2 rounded-md border flex items-center justify-between gap-2 transition-colors ${sel ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-border hover:border-primary/50 hover:bg-muted/40'}`}
                          data-testid={`cc-bind-box-${cd.box_id}`}>
                          <span className="min-w-0">
                            <span className="block font-mono font-medium text-sm text-foreground truncate">{cd.sku}</span>
                            <span className="block text-xs text-muted-foreground truncate">
                              {cd.color} / {cd.size} · <span className="font-mono">{cd.box_id}</span>
                            </span>
                          </span>
                          <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                            {cd.system_units} u
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <label className="text-xs font-medium text-muted-foreground block pt-1">Unidades REALES en la caja</label>
                  <input type="number" min="0" inputMode="numeric"
                    value={bindPrompt.units}
                    onChange={e => setBindPrompt(p => ({ ...p, units: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && bindPrompt.target && bindPrompt.units !== '') {
                        e.preventDefault();
                        sendScan(bindPrompt.loc, bindPrompt.code, { targetBoxId: bindPrompt.target, units: bindPrompt.units });
                      }
                    }}
                    className="w-full px-3 py-2.5 bg-background border border-input rounded-md text-lg font-semibold font-mono tabular-nums text-foreground"
                    data-testid="cc-bind-units" />
                  <p className="text-xs text-muted-foreground">Cuenta lo que hay físicamente. Se aplica al confirmar el conteo, no ahora.</p>
                </div>
                <div className="px-5 py-3 bg-muted/40 border-t border-border/40 flex justify-between gap-2">
                  <button
                    onClick={() => sendScan(bindPrompt.loc, bindPrompt.code, { forceUnknown: true })}
                    className="px-3 py-2 bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25 rounded-md text-xs font-medium"
                    title="El producto de esta caja no coincide con ninguna de la lista — se manda a revisión de supervisor."
                    data-testid="cc-bind-none">
                    Ninguna de estas
                  </button>
                  <div className="flex gap-2">
                    <Btn onClick={() => setBindPrompt(null)} data-testid="cc-bind-cancel">Cancelar</Btn>
                    <Btn
                      variant="primary"
                      onClick={() => sendScan(bindPrompt.loc, bindPrompt.code, { targetBoxId: bindPrompt.target, units: bindPrompt.units })}
                      disabled={!bindPrompt.target || bindPrompt.units === ''}
                      data-testid="cc-bind-confirm">
                      Registrar caja
                    </Btn>
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <button onClick={() => setSelectedCount(null)} className="p-1.5 text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors"><ArrowLeft className="w-4 h-4" /></button>
            <div>
              <h2 className="text-lg font-bold text-foreground">{selectedCount.name}</h2>
              <span className="text-xs text-muted-foreground">Conteo por caja (escaneo LPN) · {SL.length} ubicaciones</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {TABS.map(tb => (
              <button key={tb.k} onClick={() => setScanPass(tb.k)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${effectivePass === tb.k ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:text-foreground'}`}>
                {tb.label} <Chip tone={PASS_TONES[tb.k] || 'neutral'}>{buckets[tb.k].length}</Chip>
              </button>
            ))}
            {!canPass3 && buckets['3'].length > 0 && (
              <span className="px-3 py-1.5 text-xs text-muted-foreground italic">
                {buckets['3'].length} ubicación(es) en 3er conteo — requiere inventario nivel 3
              </span>
            )}
          </div>
          <div className="border border-border rounded-lg overflow-hidden max-h-[620px] overflow-y-auto custom-scrollbar">
            {active.length === 0 && (
              <div className="text-center text-muted-foreground text-sm py-10">Sin ubicaciones en esta pestaña.</div>
            )}
            {active.map(L => {
              const exp = new Set(L.expected_boxes || []);
              const scanned = L.scanned_boxes || [];
              const labels = L.scanned_labels || {};
              const isTerminal = L.status === 'ok' || L.status === 'supervisor';
              const open = openLoc === L.location;
              const dot = L.status === 'supervisor' ? 'bg-red-500'
                : L.status === 'ok' ? 'bg-emerald-500'
                : scanned.length > 0 ? 'bg-amber-500' : 'bg-muted-foreground/40';
              return (
                <div key={L.loc_id} className={`border-b border-border/60 ${open ? 'bg-muted/30' : ''}`}>
                  {/* LÍNEA compacta: una ubicación por renglón */}
                  <button
                    onClick={() => setOpenLoc(open ? null : L.location)}
                    className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-muted/40 transition-colors"
                    data-testid={`cc-loc-row-${L.location}`}>
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                    <MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-mono font-medium text-sm truncate">{L.location}</span>
                    <Chip tone={PASS_TONES[L.status === 'supervisor' ? 'supervisor' : L.status === 'ok' ? 'ok' : L.pass] || 'neutral'}>P{L.pass}</Chip>
                    <span className="ml-auto text-xs font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                      <span className={scanned.length === exp.size ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-foreground font-semibold'}>{scanned.length}</span>
                      <span className="opacity-50">/{exp.size}</span>
                    </span>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </button>
                  {open && (
                  <div className="p-3 space-y-2">
                    {!isTerminal && (
                      <div className="flex gap-2">
                        <input
                          autoFocus
                          value={scanDraft[L.location] || ''}
                          onChange={e => setScanDraft(d => ({ ...d, [L.location]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); scanBox(L.location); } }}
                          placeholder="Escanea la caja (LPN o número físico A-…)"
                          className="flex-1 px-3 py-2 bg-background border border-input rounded-md text-sm font-mono"
                          data-testid={`cc-scan-${L.location}`} />
                        <Btn onClick={() => scanBox(L.location)}>Escanear</Btn>
                      </div>
                    )}
                    {scanned.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {scanned.map(b => (
                          <span key={b} className={`inline-flex items-center gap-1 text-xs font-mono font-medium px-2 py-0.5 rounded-md border ${exp.has(b) ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25' : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25'}`} title={`${labels[b] ? `Etiqueta física ${labels[b]} → ${b}. ` : ''}${exp.has(b) ? 'Esperada aquí' : 'AJENA — no pertenece a esta ubicación'}`}>
                            {labels[b] || b}{exp.has(b) ? '' : ' ⚠'}
                            {!isTerminal && (
                              <button onClick={() => unscanBox(L.location, b)}
                                className="ml-0.5 leading-none text-sm opacity-60 hover:opacity-100 hover:text-red-500"
                                title="Quitar (escaneada por error)"
                                data-testid={`cc-unscan-${L.location}-${b}`}>×</button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    {(L.missing?.length > 0 || L.extra?.length > 0) && (
                      <div className="text-xs space-y-0.5">
                        {L.missing?.length > 0 && <div className="text-red-600 dark:text-red-400">Faltan: <span className="font-mono">{L.missing.join(', ')}</span></div>}
                        {L.extra?.length > 0 && <div className="text-amber-600 dark:text-amber-400">Ajenas: <span className="font-mono">{L.extra.join(', ')}</span></div>}
                      </div>
                    )}
                    {!isTerminal && (
                      <button
                        onClick={() => setConfirmDialog({
                          title: `Cerrar ${L.location}`,
                          message: `¿Confirmas que terminaste de escanear todas las cajas de ${L.location}? Esta acción registrará el conteo y no se puede deshacer fácilmente.`,
                          onConfirm: () => closeLocation(L.location),
                        })}
                        className="w-full mt-1 px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
                        data-testid={`cc-close-${L.location}`}>
                        Cerrar ubicación
                      </button>
                    )}
                    {L.status === 'supervisor' && (
                      <div className="space-y-2 border-t border-red-200 dark:border-red-500/25 pt-2 mt-1">
                        <div className="text-xs text-red-600 dark:text-red-400 font-semibold">⚑ Cajas desconocidas — requiere resolución del supervisor</div>
                        {invLevel < 3 ? (
                          <div className="text-xs text-muted-foreground italic">Requiere inventario nivel 3 para resolver.</div>
                        ) : (
                          <>
                            {(L.unknown_boxes || []).map(b => {
                              const key = `${L.location}:${b}`;
                              const f = supForm[key] || { action: 'discard' };
                              const upd = (patch) => setSupForm(s => ({ ...s, [key]: { ...f, ...patch } }));
                              const isCreate = f.action === 'create';
                              return (
                                <div key={b} className="bg-background/50 border border-border rounded-md p-2 space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-mono font-medium text-amber-600 dark:text-amber-400">{b}</span>
                                    <div className="ml-auto flex gap-1">
                                      <button onClick={() => upd({ action: 'create' })} className={`px-2 py-0.5 rounded-md text-xs font-medium transition-colors ${isCreate ? 'bg-emerald-600 text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>Crear</button>
                                      <button onClick={() => upd({ action: 'discard' })} className={`px-2 py-0.5 rounded-md text-xs font-medium transition-colors ${!isCreate ? 'bg-red-600 text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>Descartar</button>
                                    </div>
                                  </div>
                                  {isCreate && (
                                    <div className="grid grid-cols-2 gap-1.5">
                                      <input value={f.units || ''} onChange={e => upd({ units: e.target.value })} type="number" min="1" placeholder="Unidades *" className="px-2 py-1 bg-background border border-input rounded-md text-xs font-mono" />
                                      <input value={f.style || ''} onChange={e => upd({ style: e.target.value })} placeholder="Estilo *" className="px-2 py-1 bg-background border border-input rounded-md text-xs font-mono" />
                                      <input value={f.color || ''} onChange={e => upd({ color: e.target.value })} placeholder="Color" className="px-2 py-1 bg-background border border-input rounded-md text-xs font-mono" />
                                      <input value={f.size || ''} onChange={e => upd({ size: e.target.value })} placeholder="Talla" className="px-2 py-1 bg-background border border-input rounded-md text-xs font-mono" />
                                      {/* País y composición: el LOTE. Van por catálogo curado, no
                                          texto libre — es lo que impide que vuelvan a entrar
                                          valores como 'WASH COLD' en el campo país. */}
                                      <SearchableSelect
                                        value={f.country_of_origin || ''}
                                        onChange={v => upd({ country_of_origin: v })}
                                        options={countryOptions}
                                        placeholder="País de origen *"
                                        allowCreate={false}
                                        testId={`cc-sup-coo-${b}`} />
                                      <SearchableSelect
                                        value={f.fabric_content || ''}
                                        onChange={v => upd({ fabric_content: v })}
                                        options={fabricOptions}
                                        placeholder="Contenido de tela *"
                                        allowCreate={false}
                                        testId={`cc-sup-fabric-${b}`} />
                                      <div className="col-span-2 text-[11px] text-muted-foreground font-mono">
                                        SKU: <span className="text-foreground font-medium">{ccAutoSku(f.style, f.color, f.size) || '—'}</span>
                                        <span className="opacity-70"> · se genera solo</span>
                                      </div>
                                      <div className="col-span-2 text-[11px] text-muted-foreground">
                                        N° de caja: <span className="text-foreground font-medium font-mono">BOX-######</span>
                                        <span className="opacity-70"> · lo asigna el sistema al crear; imprime esa etiqueta para el cartón</span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            <button
                              onClick={() => setConfirmDialog({
                                title: `Resolver y cerrar ${L.location}`,
                                message: `¿Confirmas que las decisiones para cada caja desconocida son correctas? Se crearán o descartarán según lo indicado y se cerrará la ubicación.`,
                                onConfirm: () => resolveSupervisor(L.location, L.unknown_boxes),
                              })}
                              disabled={resolvingSup}
                              className="w-full px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                              data-testid={`cc-resolve-sup-${L.location}`}>
                              {resolvingSup ? 'Resolviendo…' : 'Cerrar ubicación (resuelto)'}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {L.status === 'ok' && <div className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">✅ Cuadró</div>}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        </>
      );
    }

    return (
      <>
      {confirmDialog && (
        <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-card border border-border rounded-lg shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <div className="font-semibold text-base text-foreground">{confirmDialog.title}</div>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-muted-foreground leading-relaxed">{confirmDialog.message}</p>
            </div>
            <div className="px-5 py-3 bg-muted/40 border-t border-border/40 flex justify-end gap-2">
              <Btn onClick={() => setConfirmDialog(null)}>
                Cancelar
              </Btn>
              <Btn variant="primary" onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }}>
                Confirmar
              </Btn>
            </div>
          </div>
        </div>
      )}
      <div className="space-y-4" data-testid="cycle-count-detail">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setSelectedCount(null)} className="p-1.5 text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors"><ArrowLeft className="w-4 h-4" /></button>
            <div>
              <h2 className="text-lg font-bold text-foreground">{selectedCount.name}</h2>
              <span className="text-xs text-muted-foreground">{selectedCount.count_id}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-md border font-medium whitespace-nowrap ${selectedCount.status === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25' : selectedCount.status === 'completed' ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25' : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25'}`}>
              {selectedCount.status === 'approved' ? t('wms_status_approved') : selectedCount.status === 'completed' ? t('wms_status_completed') : t('wms_status_in_progress')}
            </span>
            {selectedCount.assigned_to_name && <span className="text-xs bg-muted text-foreground/70 border border-border px-2 py-0.5 rounded-md font-medium">{selectedCount.assigned_to_name}</span>}
          </div>
        </div>
        {/* Progress */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">{t('wms_cc_progress_label')} {countedLines}/{totalLines} {t('wms_cc_items')}</span>
            <div className="flex items-center gap-3">
              {discrepancies > 0 && <span className="text-xs px-2 py-0.5 rounded-md border font-medium bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25">{discrepancies} {t('wms_cc_discrepancies')}</span>}
              <span className="text-sm font-semibold tabular-nums">{pct}%</span>
            </div>
          </div>
          <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-primary' : 'bg-muted-foreground/40'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        {/* Lines by location */}
        <div className="space-y-3 max-h-[500px] overflow-y-auto">
          {locations.map(loc => {
            const isExpanded = expandedLocations[loc];
            return (
              <div key={loc} className="border border-border rounded-lg overflow-hidden">
                <div
                  className="bg-muted/40 px-3 py-2 text-sm font-semibold flex items-center gap-2 cursor-pointer hover:bg-muted/60 transition-colors"
                  onClick={() => setExpandedLocations(prev => ({ ...prev, [loc]: !prev[loc] }))}
                >
                  <MapPin className="w-4 h-4 text-muted-foreground" /> {loc}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {grouped[loc].filter(l => l.counted).length}/{grouped[loc].length}
                  </span>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground ml-2" /> : <ChevronDown className="w-4 h-4 text-muted-foreground ml-2" />}
                </div>
                {isExpanded && (
                  <div className="divide-y divide-border">
                    {grouped[loc].map(line => (
                      <div key={line.line_id} className={`flex items-center gap-3 px-3 py-2 ${line.counted && line.discrepancy !== 0 ? 'bg-red-500/5' : line.counted ? 'bg-emerald-500/5' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-sm font-mono font-medium text-foreground">{line.style}</span>
                            {line.customer && (
                              <span className="text-xs font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                {line.customer}
                              </span>
                            )}
                          </div>
                          <div className="text-xs font-mono text-muted-foreground">
                            {line.color || '—'} / <span className="text-foreground font-medium">{line.size || '—'}</span>
                          </div>
                          {(line.description || line.fabric_content || line.country_of_origin) && (
                            <div className="text-xs text-muted-foreground/80 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                              {line.description && (
                                <span title={line.description}>{line.description}</span>
                              )}
                              {line.fabric_content && (
                                <span title={line.fabric_content}>· {line.fabric_content}</span>
                              )}
                              {line.country_of_origin && (
                                <span className="font-mono text-muted-foreground/70" title="País">· {line.country_of_origin}</span>
                              )}
                            </div>
                          )}
                        </div>
                        {isAdmin && (
                          <div className="text-center w-20">
                            <div className="text-xs text-muted-foreground">{t('wms_cc_system')}</div>
                            <div className="text-sm font-medium tabular-nums">{line.system_qty}</div>
                          </div>
                        )}
                        <div className="w-24">
                          <div className="text-xs text-muted-foreground">{t('wms_cc_count')}</div>
                          <input type="number" min="0" value={line.counted_qty ?? ''} onChange={e => handleInputChange(line.line_id, e.target.value)}
                            className="w-full px-2 py-1.5 bg-background border border-input rounded-md text-center text-sm font-mono font-medium tabular-nums"
                            disabled={selectedCount.status === 'approved'}
                            data-testid={`cc-input-${line.line_id}`} />
                        </div>
                        {isAdmin && (
                          <div className="w-16 text-center">
                            {line.counted && (
                              <span className={`text-sm font-semibold tabular-nums ${line.discrepancy === 0 ? 'text-emerald-600 dark:text-emerald-400' : line.discrepancy > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'}`}>
                                {line.discrepancy > 0 ? '+' : ''}{line.discrepancy}
                              </span>
                            )}
                            {line.adjusted && (
                              <div className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400" title="Diferencia ya aplicada al inventario">ajustado</div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Actions */}
        {selectedCount.status !== 'approved' && (
          <div className="flex gap-3 sticky bottom-0 bg-background pt-3 border-t border-border">
            <button onClick={handleSaveAll} disabled={saving} className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-md text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50" data-testid="cc-save">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} {t('wms_cc_save')}
            </button>
            {selectedCount.status === 'completed' && (
              <button onClick={approveCount} disabled={saving} className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md text-sm font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50" data-testid="cc-approve">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} {t('wms_cc_approve')}
              </button>
            )}
          </div>
        )}
      </div>
      </>
    );
  }

  // ── Eficiencia: agregación en el frontend (zona horaria local) ────────────
  // Por contador: ubicaciones = nº de eventos, cajas = Σ boxes, horas activas =
  // nº de buckets hora-local distintos; ritmos = totales / horas activas.
  const effList = effEvents || [];
  const effByCounter = {};
  effList.forEach(ev => {
    const name = ev.by_name || ev.by || 'Desconocido';
    if (!effByCounter[name]) effByCounter[name] = { name, locations: 0, boxes: 0, hours: {} };
    const agg = effByCounter[name];
    const hk = localHourKey(ev.at);
    agg.locations += 1;
    agg.boxes += (ev.boxes || 0);
    if (!agg.hours[hk]) agg.hours[hk] = { key: hk, locations: 0, boxes: 0 };
    agg.hours[hk].locations += 1;
    agg.hours[hk].boxes += (ev.boxes || 0);
  });
  const effCounters = Object.values(effByCounter)
    .map(c => {
      const activeHours = Object.keys(c.hours).length;
      return {
        name: c.name,
        locations: c.locations,
        boxes: c.boxes,
        activeHours,
        locPerHour: activeHours > 0 ? c.locations / activeHours : 0,
        boxesPerHour: activeHours > 0 ? c.boxes / activeHours : 0,
        // Desglose por hora, cronológico (la clave "YYYY-MM-DD HH" ordena sola).
        hourRows: Object.values(c.hours).sort((a, b) => a.key.localeCompare(b.key)),
      };
    })
    .sort((a, b) => b.boxes - a.boxes);
  const effTotalBoxes = effList.reduce((s, ev) => s + (ev.boxes || 0), 0);

  // Detalle de "fuera de inventario": las SOBRANTE de scanned_boxes, o sea la
  // caja que apareció en la ubicación y el sistema no tenía ahí.
  const outOfInventoryRows = (kpiReport?.scanned_boxes || []).filter(b => b.tipo === 'SOBRANTE');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg border border-border">
          <button
            onClick={() => setActiveTab('active')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'active' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <ClipboardList className="w-4 h-4" />
            ACTIVOS
          </button>
          {canExportReport && (
            <button
              onClick={() => {
                setActiveTab('kpis');
                // Sin conteo elegido: abre con el más reciente (la lista ya viene
                // ordenada por fecha desde /cycle-counts).
                const target = kpiCountId || selectedCount?.count_id || counts[0]?.count_id || '';
                if (target && target !== kpiCountId) { setKpiCountId(target); loadKpis(target); }
                else if (target && !kpiReport && !loadingKpi) loadKpis(target);
              }}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'kpis' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              data-testid="cc-tab-kpis"
            >
              <BarChart3 className="w-4 h-4" />
              KPIs
            </button>
          )}
          {(user?.access_level >= 5 || user?.role === 'supersu' || user?.role === 'admin' || (parseInt(user?.inventory_level, 10) || 0) >= 3) && (
            <button
              onClick={() => { setActiveTab('efficiency'); if (effEvents === null && !loadingEff) loadEfficiency(); }}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'efficiency' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              data-testid="cc-tab-efficiency"
            >
              <BarChart3 className="w-4 h-4" />
              EFICIENCIA
            </button>
          )}
          {/* Cola de auditoría del material de la carga inicial. La llena el
              piso: cada vez que un operador se topa con una caja no confiable
              reporta su ubicación, y aquí se ve ordenada por cuánto estorba. */}
          <button
            onClick={() => { setActiveTab('cuarentena'); if (cuarentena === null && !loadingCuar) loadCuarentena(); }}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'cuarentena' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="cc-tab-cuarentena"
          >
            <AlertTriangle className="w-4 h-4" />
            POR AUDITAR
            {cuarentena?.length > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-500 text-black text-[10px] font-bold tabular-nums">
                {cuarentena.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {activeTab === 'active' && (
            <Btn
              variant="primary"
              onClick={() => setShowForm(!showForm)}
              data-testid="new-cc-btn"
            >
              <Plus className="w-4 h-4" /> {t('wms_new_cc')}
            </Btn>
          )}
        </div>
      </div>
      
      {activeTab === 'active' && (
        <>
          {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-4 animate-in fade-in slide-in-from-top-4 duration-300" data-testid="cc-form">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">{t('wms_cc_name')}</label>
              <input placeholder={t('wms_cc_name_placeholder')} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className={cls.input} data-testid="cc-name" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">{t('wms_assign_op')}</label>
              <select value={form.assigned_to} onChange={e => { const op = operators.find(o => (o.user_id || o.email) === e.target.value); setForm(p => ({ ...p, assigned_to: e.target.value, assigned_to_name: op ? (op.name || op.email) : '' })); }} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="cc-assign">
                <option value="">{t('unassigned')}</option>
                {operators.map(op => <option key={op.user_id || op.email} value={op.user_id || op.email}>{op.name || op.email}</option>)}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3 bg-card border border-border rounded-lg">
            <input
              type="checkbox"
              id="cc_is_general"
              checked={form.is_general}
              onChange={e => setForm(p => ({ ...p, is_general: e.target.checked, ...(e.target.checked ? { is_random: false, random_zones: [] } : {}), location_filter: '', customer_filter: '', style_filter: '', color_filter: '' }))}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary/20 bg-background"
              data-testid="cc-is-general"
            />
            <label htmlFor="cc_is_general" className="text-xs font-medium text-foreground cursor-pointer select-none">
              Conteo General (Contar Todo el Inventario)
            </label>
          </div>

          {/* Conteo ALEATORIO: muestreo por zona. El supervisor marca varias
              zonas y el sistema sortea N ubicaciones de cada una (5 por default).
              Excluyente con el conteo general y con los filtros dirigidos. */}
          <div className="border border-border rounded-lg bg-card">
            <div className="flex items-start gap-3 p-3">
              <input
                type="checkbox"
                id="cc_is_random"
                checked={form.is_random}
                onChange={e => setForm(p => ({
                  ...p,
                  is_random: e.target.checked,
                  ...(e.target.checked
                    ? { is_general: false, location_filter: '', customer_filter: '', style_filter: '', color_filter: '' }
                    : { random_zones: [] }),
                }))}
                className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary/20 bg-background"
                data-testid="cc-is-random"
              />
              <label htmlFor="cc_is_random" className="text-xs font-medium text-foreground cursor-pointer select-none">
                Conteo Aleatorio (muestreo por zona)
                <span className="block text-muted-foreground/70 font-normal mt-0.5">
                  Elige las zonas y el sistema toma ubicaciones al azar de cada una.
                </span>
              </label>
            </div>

            {form.is_random && (
              <div className="px-3 pb-3 space-y-3 animate-in fade-in duration-200">
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="text-xs text-muted-foreground" htmlFor="cc_random_per_zone">Ubicaciones por zona</label>
                  <input
                    id="cc_random_per_zone"
                    type="number"
                    min={1}
                    max={50}
                    value={form.random_per_zone}
                    onChange={e => setForm(p => ({
                      ...p,
                      random_per_zone: e.target.value === '' ? '' : Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)),
                    }))}
                    onBlur={() => setForm(p => ({ ...p, random_per_zone: p.random_per_zone || 5 }))}
                    className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-foreground"
                    data-testid="cc-random-per-zone"
                  />
                  <span className="text-xs text-muted-foreground/70">
                    Si una zona tiene menos, se toman todas las que haya.
                  </span>
                </div>

                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.random_only_stocked}
                    onChange={e => setForm(p => ({
                      ...p,
                      random_only_stocked: e.target.checked,
                      // Al acotar a con-stock hay zonas que se quedan sin pool:
                      // se sueltan solas para no mandar una seleccion invalida.
                      random_zones: e.target.checked
                        ? p.random_zones.filter(zn => (zones.find(z => z.zone === zn)?.with_stock || 0) > 0)
                        : p.random_zones,
                    }))}
                    className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary/20 bg-background"
                    data-testid="cc-random-only-stocked"
                  />
                  <span className="text-xs font-medium text-foreground">
                    Solo ubicaciones con stock
                    <span className="block text-muted-foreground/70 font-normal mt-0.5">
                      Apagado (default): el sorteo entra a TODA la zona, vacias incluidas — asi se caza stock
                      encontrado donde el sistema no ve nada. Prendido: solo ubicaciones con caja viva.
                    </span>
                  </span>
                </label>

                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-muted-foreground">
                    Zonas ({form.random_zones.length} seleccionada{form.random_zones.length === 1 ? '' : 's'})
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setForm(p => ({
                        ...p,
                        random_zones: zones.filter(z => (p.random_only_stocked ? z.with_stock : z.total) > 0).map(z => z.zone),
                      }))}
                    >Todas</button>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:underline"
                      onClick={() => setForm(p => ({ ...p, random_zones: [] }))}
                    >Ninguna</button>
                  </div>
                </div>

                <div className="max-h-56 overflow-y-auto border border-border rounded bg-background divide-y divide-border" data-testid="cc-random-zones">
                  {zones.length === 0 && (
                    <div className="px-3 py-4 text-xs text-muted-foreground">Cargando zonas...</div>
                  )}
                  {zones.map(z => {
                    const checked = form.random_zones.includes(z.zone);
                    // Pool real del sorteo: toda la zona (vacias incluidas) o
                    // solo las ubicaciones con caja viva si asi se pidio.
                    const pool = form.random_only_stocked ? z.with_stock : z.total;
                    const take = Math.min(pool, Number(form.random_per_zone) || 5);
                    return (
                      <label
                        key={z.zone}
                        className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-secondary/40 ${pool === 0 ? 'opacity-50' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={pool === 0}
                          onChange={e => setForm(p => ({
                            ...p,
                            random_zones: e.target.checked
                              ? [...p.random_zones, z.zone]
                              : p.random_zones.filter(x => x !== z.zone),
                          }))}
                          className="w-4 h-4 rounded border-border text-primary focus:ring-primary/20 bg-background"
                          data-testid={`cc-zone-${z.zone}`}
                        />
                        <span className="text-xs font-medium text-foreground flex-1">{z.zone}</span>
                        <span className="text-xs text-muted-foreground/70">
                          {pool === 0
                            ? 'sin ubicaciones para muestrear'
                            : `${take} de ${pool} ubicacion${pool === 1 ? '' : 'es'}${form.random_only_stocked ? '' : ` · ${z.with_stock} con stock`}`}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {form.random_zones.length > 0 && (
                  <div className="text-xs text-muted-foreground/80" data-testid="cc-random-preview">
                    Se generaran hasta{' '}
                    <b>{zones
                      .filter(z => form.random_zones.includes(z.zone))
                      .reduce((n, z) => n + Math.min(form.random_only_stocked ? z.with_stock : z.total, Number(form.random_per_zone) || 5), 0)}</b>
                    {' '}ubicaciones a contar.
                  </div>
                )}
              </div>
            )}
          </div>

          <div className={`space-y-2 transition-all duration-300 ${(form.is_general || form.is_random) ? 'opacity-40 pointer-events-none scale-[0.98]' : ''}`}>
            <div className="text-xs font-medium text-muted-foreground">{t('wms_cc_filters')}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t('wms_cc_loc_filter')}
                  <span className="ml-1 text-muted-foreground font-medium">(prefijo)</span>
                </label>
                <PrefixLocationInput
                  locations={options.locations}
                  value={form.location_filter}
                  onChange={val => setForm(p => ({ ...p, location_filter: val }))}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t('client')}</label>
                <SearchableSelect options={options.customers} value={form.customer_filter} onChange={val => setForm(p => ({ ...p, customer_filter: val }))} placeholder={t('all')} testId="cc-customer" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t('style')}</label>
                <SearchableSelect options={options.styles} value={form.style_filter} onChange={val => setForm(p => ({ ...p, style_filter: val }))} placeholder={t('all')} testId="cc-style" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Color</label>
                <SearchableSelect options={options.colors} value={form.color_filter} onChange={val => setForm(p => ({ ...p, color_filter: val }))} placeholder={t('all')} testId="cc-color" />
              </div>
            </div>
            <div className="text-xs text-muted-foreground/70 mt-1">
              Puedes combinar filtros. Ej: solo <b>style 5000 + color BLACK</b> cuenta esas dos dimensiones donde existan.
            </div>
          </div>

          {/* Incluir locaciones vacías: solo tiene sentido en conteo por ubicación
              o general. Con filtro de cliente/estilo/color se deshabilita porque una
              locación vacía no casa esos filtros. */}
          {!form.is_random && (() => {
            const emptyApplicable = !(form.customer_filter || form.style_filter || form.color_filter);
            return (
              <div className={`flex items-start gap-3 p-3 bg-card border border-border rounded-lg ${emptyApplicable ? '' : 'opacity-40'}`}>
                <input
                  type="checkbox"
                  id="cc_include_empty"
                  checked={emptyApplicable && form.include_empty}
                  disabled={!emptyApplicable}
                  onChange={e => setForm(p => ({
                    ...p,
                    include_empty: e.target.checked,
                    random_zones: e.target.checked
                      ? p.random_zones
                      : p.random_zones.filter(zn => (zones.find(z => z.zone === zn)?.with_stock || 0) > 0),
                  }))}
                  className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary/20 bg-background"
                  data-testid="cc-include-empty"
                />
                <label htmlFor="cc_include_empty" className="text-xs font-medium text-foreground cursor-pointer select-none">
                  Incluir locaciones vacías
                  <span className="block text-muted-foreground/70 font-normal mt-0.5">
                    Visita también las ubicaciones que el sistema cree vacías para detectar stock encontrado.
                    {emptyApplicable ? '' : ' No aplica con filtro de cliente/estilo/color.'}
                  </span>
                </label>
              </div>
            );
          })()}

          <div className="flex gap-2 pt-2">
            <Btn variant="primary" onClick={handleCreate} disabled={loading} data-testid="cc-create">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />} {t('wms_create_cc')}
            </Btn>
            <Btn onClick={() => setShowForm(false)}>{t('cancel')}</Btn>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {counts.map(c => {
          // Un conteo box_scan guarda el avance en scan_locations, NO en lines:
          // medirlo con counted_lines/total_lines lo deja SIEMPRE en 0% aunque
          // lleve cientos de cajas escaneadas. Se mide por ubicaciones cerradas.
          const SL = Array.isArray(c.scan_locations) ? c.scan_locations : [];
          const isBoxScan = SL.length > 0;
          const locDone = SL.filter(L => L.status === 'ok' || L.status === 'supervisor').length;
          const boxesScanned = SL.reduce((n, L) => n + ((L.scanned_boxes || []).length), 0);
          const pct = isBoxScan
            ? Math.round((locDone / SL.length) * 100)
            : (c.total_lines > 0 ? Math.round((c.counted_lines / c.total_lines) * 100) : 0);
          const statusColors = {
            'approved': 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25',
            'completed': 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25',
            'in_progress': 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25'
          };

          return (
            <div
              key={c.count_id}
              onClick={() => openCount(c)}
              className="cursor-pointer group text-left border border-border rounded-lg bg-card hover:border-primary/40 transition-colors relative overflow-hidden"
              data-testid={`cc-${c.count_id}`}
            >
              <div className={`h-1 w-full ${c.status === 'approved' ? 'bg-emerald-500' : c.status === 'completed' ? 'bg-blue-500' : 'bg-amber-500'}`} />

              <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
                      <ClipboardList className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-xs font-mono bg-muted px-2 py-0.5 rounded text-muted-foreground inline-block mb-1">
                        #{c.count_id.slice(-6)}
                      </div>
                      <h4 className="text-sm font-semibold text-foreground truncate max-w-[120px]">{c.name}</h4>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap border ${statusColors[c.status] || 'bg-muted text-foreground/70 border-border'}`}>
                      {c.status === 'approved' ? t('wms_status_approved') : c.status === 'completed' ? t('wms_status_completed') : t('wms_status_in_progress')}
                    </div>
                    {canExportReport && (
                    <button
                      onClick={(e) => { e.stopPropagation(); exportCountById(c.count_id); }}
                      disabled={exportingId === c.count_id}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                      title="Exportar reporte Excel"
                      data-testid={`export-cc-${c.count_id}`}
                    >
                      {exportingId === c.count_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                    </button>
                    )}
                    {isAdmin && (
                      <button
                        onClick={(e) => handleDelete(c.count_id, e)}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title={t('delete') || 'Eliminar'}
                        data-testid={`delete-cc-${c.count_id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-muted/40 rounded-lg p-4 mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-muted-foreground">{t('wms_cc_progress_title')}</span>
                    <span className="text-sm font-semibold tabular-nums">{pct}%</span>
                  </div>
                  <div className="h-2 bg-background rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-700 ${pct === 100 ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground flex items-center justify-between">
                    {isBoxScan ? (
                      <span>
                        {locDone} {t('of')} {SL.length} ubicaciones
                        <span className="ml-1.5 text-foreground font-medium">· {boxesScanned} cajas</span>
                      </span>
                    ) : (
                      <span>{c.counted_lines} {t('of')} {c.total_lines} {t('wms_cc_items')}</span>
                    )}
                    {c.assigned_to_name && <span className="italic">@{c.assigned_to_name}</span>}
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/60 pt-3 gap-2 flex-wrap">
                  <span className="flex items-center gap-1"><History className="w-3 h-3" /> {new Date(c.created_at).toLocaleDateString()}</span>
                  {c.is_random ? (
                    <span className="flex items-center gap-1 opacity-80" title={(c.random_zones || []).join(', ')}>
                      <Shuffle className="w-3 h-3" />
                      Aleatorio - {(c.random_zones || []).length} zona(s) x {c.random_per_zone}
                    </span>
                  ) : c.is_general ? (
                    <span className="px-2 py-0.5 rounded-md border text-xs font-medium bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25 flex items-center gap-1">Conteo General</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1 justify-end">
                      {c.location_filter && <span className="flex items-center gap-1 opacity-80"><MapPin className="w-3 h-3" /> {c.location_filter}</span>}
                      {c.style_filter && <span className="bg-muted border border-border text-foreground/70 px-1.5 py-0.5 rounded-md font-medium">STYLE {c.style_filter}</span>}
                      {c.color_filter && <span className="px-1.5 py-0.5 rounded-md border font-medium bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25">{c.color_filter}</span>}
                      {c.customer_filter && <span className="opacity-70">{c.customer_filter}</span>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
        {counts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 rounded-lg border border-dashed border-border">
            <p className="text-sm font-semibold text-foreground/80">{t('wms_no_cc')}</p>
            <p className="text-sm text-muted-foreground mt-1">{t('wms_cc_hint')}</p>
          </div>
        )}
        </>
      )}

      {activeTab === 'kpis' && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300" data-testid="cc-kpis">

          {/* ── Selector de conteo ────────────────────────────────────────── */}
          <div className="flex items-end gap-3 flex-wrap">
            <div className="min-w-[18rem]">
              <label className="text-xs font-medium text-muted-foreground block mb-1">Conteo</label>
              <select
                value={kpiCountId}
                onChange={e => { setKpiCountId(e.target.value); loadKpis(e.target.value); }}
                className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground"
                data-testid="cc-kpi-select"
              >
                <option value="">Selecciona un conteo…</option>
                {counts.map(c => (
                  <option key={c.count_id} value={c.count_id}>
                    {(c.name || c.count_id)} · {c.status === 'approved' ? 'aprobado' : c.status}
                    {c.created_at ? ` · ${new Date(c.created_at).toLocaleDateString()}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {kpiCountId && (
              <Btn onClick={() => loadKpis(kpiCountId)} disabled={loadingKpi} data-testid="cc-kpi-reload">
                Actualizar
              </Btn>
            )}
            {kpiReport && (
              <Btn variant="primary" onClick={() => exportExcel(kpiReport)} data-testid="cc-kpi-export">
                <FileSpreadsheet className="w-4 h-4" /> Excel
              </Btn>
            )}
          </div>

          {loadingKpi ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin mb-4" />
              <p className="text-sm">Cargando KPIs...</p>
            </div>
          ) : !kpiReport ? (
            <EmptyState title="Elige un conteo para ver sus KPIs."
              hint="Se muestran los datos de ese conteo: líneas, unidades y cajas." />
          ) : (
            <>
              {/* ── Inventario: piezas/cajas en sistema, discrepancias, ILA/IRA ── */}
              {kpiReport.inventory_kpis && (() => {
                const inv = kpiReport.inventory_kpis;
                const unidad = inv.discrepancy_unit || 'piezas';
                const netSigno = inv.net_discrepancy > 0 ? '+' : '';
                return (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Inventario</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                      <StatCard label="Piezas en sistema" value={(inv.system_pieces ?? 0).toLocaleString()} />
                      <StatCard label="Cajas en sistema" value={inv.system_boxes != null ? inv.system_boxes.toLocaleString() : '—'} />
                      <StatCard label="Discrepancia neta"
                        value={`${netSigno}${(inv.net_discrepancy ?? 0).toLocaleString()}`}
                        sub={unidad} />
                      <StatCard label="Discrepancia absoluta"
                        value={(inv.abs_discrepancy ?? 0).toLocaleString()}
                        sub={unidad} />
                      <StatCard label="ILA"
                        value={inv.ila_pct != null ? `${inv.ila_pct}%` : '—'}
                        sub="Inventory Location Accuracy" />
                      <StatCard label="IRA"
                        value={inv.ira_pct != null ? `${inv.ira_pct}%` : '—'}
                        sub="Inventory Record Accuracy" />
                    </div>
                    {inv.is_box_scan && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Discrepancia en cajas · ILA por ubicación · IRA ponderado por piezas.
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* ── Precisión del conteo ──────────────────────────────────── */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Precisión</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                  <StatCard label="Líneas en sistema" value={kpiReport.kpis.total_lines} />
                  <StatCard label="Líneas contadas" value={kpiReport.kpis.counted_lines} />
                  <StatCard label="Pendientes" value={kpiReport.kpis.total_lines - kpiReport.kpis.counted_lines} />
                  <StatCard label="Con discrepancia" value={kpiReport.kpis.discrepant_lines} />
                  <StatCard label="Exactitud" value={`${kpiReport.kpis.accuracy_pct}%`} />
                </div>
              </div>

              {/* ── Unidades ──────────────────────────────────────────────── */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Unidades</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <StatCard label="Unidades faltantes" value={kpiReport.kpis.units_short} />
                  <StatCard label="Unidades sobrantes" value={kpiReport.kpis.units_over} />
                  <StatCard label="Ajustes aplicados" value={kpiReport.kpis.adjusted_count} />
                  <StatCard label="Duración" value={kpiReport.kpis.duration_mins != null
                    ? `${Math.floor(kpiReport.kpis.duration_mins / 60)}h ${kpiReport.kpis.duration_mins % 60}m`
                    : '—'} />
                </div>
              </div>

              {/* ── Cajas: solo conteos por escaneo ───────────────────────── */}
              {kpiReport.box_kpis?.is_box_scan ? (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Cajas escaneadas</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                    <StatCard label="Ubicaciones" value={kpiReport.box_kpis.locations_total} />
                    <StatCard label="Ubic. cerradas" value={kpiReport.box_kpis.locations_closed} />
                    <StatCard label="Ubic. con hallazgos" value={kpiReport.box_kpis.locations_with_findings} />
                    <StatCard label="Cajas escaneadas" value={kpiReport.box_kpis.boxes_scanned} />
                    <StatCard label="Cajas faltantes" value={kpiReport.box_kpis.boxes_missing} />
                    <StatCard label="Fuera de inventario" value={kpiReport.box_kpis.boxes_out_of_inventory} />
                  </div>
                  {kpiReport.box_kpis.boxes_unknown > 0 && (
                    <p className="text-xs text-muted-foreground mt-2">
                      {kpiReport.box_kpis.boxes_unknown} caja(s) con código desconocido, atadas por supervisor.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Este conteo es por líneas, no por escaneo de cajas: los KPIs de caja no aplican.
                </p>
              )}

              {/* ── Fuera de inventario: el detalle ───────────────────────── */}
              {outOfInventoryRows.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Cajas contadas fuera de inventario ({outOfInventoryRows.length})
                  </h3>
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="overflow-x-auto max-h-80 overflow-y-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-muted/50 border-b border-border sticky top-0">
                          <tr><Th>Ubicación</Th><Th>Caja</Th><Th>Contó</Th><Th>Fecha</Th></tr>
                        </thead>
                        <tbody>
                          {outOfInventoryRows.map((b, i) => (
                            <tr key={`${b.location}-${b.box_id}-${i}`} className="border-b border-border/60">
                              <td className="px-3 py-2 font-mono">{b.location}</td>
                              <td className="px-3 py-2 font-mono">{b.box_id}</td>
                              <td className="px-3 py-2">{b.counted_by_name || '—'}</td>
                              <td className="px-3 py-2 tabular-nums">{b.counted_at ? new Date(b.counted_at).toLocaleString() : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Ubicaciones con más discrepancias ─────────────────────── */}
              {(kpiReport.location_breakdown || []).some(l => l.discrepant > 0) && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Ubicaciones con más discrepancias</h3>
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="overflow-x-auto max-h-80 overflow-y-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-muted/50 border-b border-border sticky top-0">
                          <tr><Th>Ubicación</Th><Th right>Líneas</Th><Th right>Contadas</Th><Th right>Discrepantes</Th><Th right>Δ unidades</Th></tr>
                        </thead>
                        <tbody>
                          {kpiReport.location_breakdown.filter(l => l.discrepant > 0).slice(0, 50).map(l => (
                            <tr key={l.location} className="border-b border-border/60">
                              <td className="px-3 py-2 font-mono">{l.location}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{l.total}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{l.counted}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">{l.discrepant}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{l.units_delta}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === 'cuarentena' && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300" data-testid="cc-cuarentena">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-semibold text-sm">
              <AlertTriangle className="w-4 h-4" /> Material de la carga inicial (Excel)
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              Estas cajas se crearon a partir de un total, no de un cartón real: su
              número no está impreso en ningún lado y sus piezas son un reparto
              estimado. La lista la llena el piso — cada vez que un operador se topa
              con una, reporta su ubicación. <b className="text-foreground">Las de
              arriba son las que más estorban</b>: audítalas primero.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Btn variant="secondary" onClick={loadCuarentena} disabled={loadingCuar}>
              {loadingCuar ? 'Cargando…' : 'Actualizar'}
            </Btn>
            {cuarentena?.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {cuarentena.length} ubicación{cuarentena.length === 1 ? '' : 'es'} ·{' '}
                {cuarentena.reduce((s, i) => s + (i.unidades_import || 0), 0).toLocaleString()} pz por auditar
              </span>
            )}
          </div>

          {loadingCuar ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
            </div>
          ) : !cuarentena?.length ? (
            <EmptyState icon={CheckCircle} title="Nada por auditar"
              subtitle="El piso no ha reportado cajas de la carga inicial. Aparecerán aquí conforme se las encuentren." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <Th>Ubicación</Th>
                    <Th className="text-right">Veces topada</Th>
                    <Th className="text-right">Cajas sin auditar</Th>
                    <Th className="text-right">Piezas</Th>
                    <Th>Último reporte</Th>
                    <Th>Acción</Th>
                  </tr>
                </thead>
                <tbody>
                  {cuarentena.map(it => (
                    <tr key={it.location} className="border-t border-border/60 hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono font-semibold">{it.location}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                          (it.encuentros || 0) >= 5 ? 'bg-red-500/20 text-red-500'
                          : (it.encuentros || 0) >= 2 ? 'bg-amber-500/20 text-amber-500'
                          : 'bg-muted text-muted-foreground'}`}>
                          {it.encuentros || 1}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{it.cajas_import ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        {(it.unidades_import || 0).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {(it.ultimo_encuentro_at || '').slice(0, 16).replace('T', ' ')}
                        {it.ultimo_encuentro_por && <> · {it.ultimo_encuentro_por}</>}
                      </td>
                      <td className="px-3 py-2">
                        <Btn variant="secondary"
                          onClick={() => { setForm(f => ({ ...f, name: `Auditoría ${it.location}`, location_filter: it.location, include_empty: true })); setActiveTab('active'); setShowForm(true); }}
                          data-testid={`cc-cuar-count-${it.location}`}>
                          Crear conteo
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'efficiency' && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300" data-testid="cc-efficiency">

          {/* ── Rango de fechas (locales; se mandan como instantes UTC) ───── */}
          <div className="flex items-end gap-3 flex-wrap">
            <div className="w-40">
              <label className="text-xs font-medium text-muted-foreground block mb-1">Desde</label>
              <input type="date" value={effFrom} onChange={e => setEffFrom(e.target.value)}
                className={cls.input} data-testid="cc-eff-from" />
            </div>
            <div className="w-40">
              <label className="text-xs font-medium text-muted-foreground block mb-1">Hasta</label>
              <input type="date" value={effTo} onChange={e => setEffTo(e.target.value)}
                className={cls.input} data-testid="cc-eff-to" />
            </div>
            <Btn variant="primary" onClick={loadEfficiency} disabled={loadingEff} data-testid="cc-eff-apply">
              Aplicar
            </Btn>
          </div>

          {loadingEff ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin mb-4" />
              <p className="text-sm">Cargando eficiencia...</p>
            </div>
          ) : effCounters.length === 0 ? (
            <EmptyState title="Sin actividad de conteo en el rango."
              hint="Ajusta las fechas y vuelve a aplicar." />
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard label="Ubicaciones contadas" value={effList.length} />
                <StatCard label="Cajas contadas" value={effTotalBoxes} />
                <StatCard label="Contadores activos" value={effCounters.length} />
              </div>

              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-muted/50 border-b border-border">
                      <tr>
                        <Th>Contador</Th>
                        <Th right>Ubicaciones</Th>
                        <Th right>Cajas</Th>
                        <Th right>Horas activas</Th>
                        <Th right>Ubic./hora</Th>
                        <Th right>Cajas/hora</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {effCounters.map(c => {
                        const open = effOpen === c.name;
                        return (
                          <Fragment key={c.name}>
                            <tr
                              onClick={() => setEffOpen(open ? null : c.name)}
                              className="border-b border-border/60 hover:bg-muted/40 transition-colors cursor-pointer"
                              data-testid={`cc-eff-row-${c.name}`}
                            >
                              <td className="px-3 py-2.5">
                                <span className="flex items-center gap-2 font-medium text-foreground">
                                  <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                                  {c.name}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.locations}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.boxes}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.activeHours}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.locPerHour.toFixed(1)}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{c.boxesPerHour.toFixed(1)}</td>
                            </tr>
                            {open && (
                              <tr className="border-b border-border/60">
                                <td colSpan={6} className="px-3 pb-3 pt-1 bg-muted/20">
                                  {/* Desglose por hora local de este contador */}
                                  <table className="w-full max-w-md text-sm">
                                    <thead className="bg-muted/50 border-b border-border">
                                      <tr>
                                        <Th>Hora</Th>
                                        <Th right>Ubicaciones</Th>
                                        <Th right>Cajas</Th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {c.hourRows.map(h => (
                                        <tr key={h.key} className="border-b border-border/60 hover:bg-muted/40 transition-colors">
                                          <td className="px-3 py-2.5 font-mono tabular-nums">{fmtHourKey(h.key)}</td>
                                          <td className="px-3 py-2.5 text-right tabular-nums">{h.locations}</td>
                                          <td className="px-3 py-2.5 text-right tabular-nums">{h.boxes}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
