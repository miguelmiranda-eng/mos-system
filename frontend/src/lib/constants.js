const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

export const BOARDS = [
  "MASTER", "SCHEDULING", "READY TO SCHEDULED", "BLANKS", "SCREENS", "NECK", "EJEMPLOS", "COMPLETOS",
  "MAQUINA1", "MAQUINA2", "MAQUINA3", "MAQUINA4",
  "MAQUINA5", "MAQUINA6", "MAQUINA7", "MAQUINA8", "MAQUINA9", "MAQUINA10",
  "MAQUINA11", "MAQUINA12", "MAQUINA13", "MAQUINA14", "FINAL BILL"
];

export const STATUS_COLORS = {
  'RUSH': { bg: '#990000', text: '#FFFFFF' },
  'OVERSOLD': { bg: '#e69138', text: '#FFFFFF' },
  'PRIORITY 1': { bg: '#cf0000', text: '#FFFFFF' },
  'PRIORITY 2': { bg: '#ff0000', text: '#FFFFFF' },
  'EVENT': { bg: '#20124d', text: '#FFFFFF' },
  'SPECIAL RUSH': { bg: '#674ea7', text: '#FFFFFF' },
  'LOVE IN FAITH': { bg: '#3d85c6', text: '#FFFFFF' },
  'GOODIE TWO SLEEVES': { bg: '#3d85c6', text: '#FFFFFF' },
  'SCREENWORKS': { bg: '#674ea7', text: '#FFFFFF' },
  'TARGET': { bg: '#3d85c6', text: '#FFFFFF' },
  'Tractor Supply': { bg: '#38761d', text: '#FFFFFF' },
  'ROSS': { bg: '#f1c232', text: '#000000' },
  'Hot Topic': { bg: '#e69138', text: '#FFFFFF' },
  'EDI': { bg: '#20124d', text: '#FFFFFF' },
  'Fashion Nova': { bg: '#e066cc', text: '#FFFFFF' },
  'Pacsun': { bg: '#b4a7d6', text: '#000000' },
  'Forever 21': { bg: '#674ea7', text: '#FFFFFF' },
  'Urban Outfitters': { bg: '#38761d', text: '#FFFFFF' },
  'Meijer': { bg: '#6fa8dc', text: '#FFFFFF' },
  'Buckle': { bg: '#cc0000', text: '#FFFFFF' },
  'Tillys': { bg: '#b44253', text: '#FFFFFF' },
  'Aeropostale': { bg: '#e69138', text: '#FFFFFF' },
  "Altard's State": { bg: '#e066cc', text: '#FFFFFF' },
  'Fred Meyers': { bg: '#b4a7d6', text: '#000000' },
  'American Wholesale': { bg: '#b4a7d6', text: '#000000' },
  'Mardel': { bg: '#674ea7', text: '#FFFFFF' },
  'Nordstrom': { bg: '#6fa8dc', text: '#FFFFFF' },
  'FOCO': { bg: '#b4a7d6', text: '#000000' },
  'TREVCO': { bg: '#3d85c6', text: '#FFFFFF' },
  'WALLMART': { bg: '#38761d', text: '#FFFFFF' },
  'JAKO ENTERPRISES': { bg: '#674ea7', text: '#FFFFFF' },
  'MIDSTATE': { bg: '#b4a7d6', text: '#000000' },
  'Ross': { bg: '#cc0000', text: '#FFFFFF' },
  'Spencers Spirit': { bg: '#f1c232', text: '#000000' },
  'Spencers': { bg: '#f1c232', text: '#000000' },
  'LIF Regular': { bg: '#cf0000', text: '#FFFFFF' },
  'LIF Broker': { bg: '#3d85c6', text: '#FFFFFF' },
  'Buc-ees': { bg: '#b4a7d6', text: '#000000' },
  'LIF Wholesale': { bg: '#b4a7d6', text: '#000000' },
  'Target': { bg: '#3d85c6', text: '#FFFFFF' },
  'GLO STOCK': { bg: '#3d85c6', text: '#FFFFFF' },
  'FROM USA': { bg: '#e69138', text: '#FFFFFF' },
  'CLIENT': { bg: '#674ea7', text: '#FFFFFF' },
  'GTS STOCK': { bg: '#3d85c6', text: '#FFFFFF' },
  'LKWID STOCK': { bg: '#674ea7', text: '#FFFFFF' },
  'LIF STOCK': { bg: '#b4a7d6', text: '#000000' },
  'STOCK+BPO': { bg: '#b4a7d6', text: '#000000' },
  'BLANK SOURCE': { bg: '#999999', text: '#FFFFFF' },
  'PURCH': { bg: '#f1c232', text: '#000000' },
  'BPO': { bg: '#f1c232', text: '#000000' },
  'CONTADO/PICKED': { bg: '#3d85c6', text: '#FFFFFF' },
  'PICK TICKET READY': { bg: '#cf0000', text: '#FFFFFF' },
  'PULL IN PROCESS': { bg: '#674ea7', text: '#FFFFFF' },
  'APROVED RUN SHORT': { bg: '#b4a7d6', text: '#000000' },
  'PARTIAL': { bg: '#b4a7d6', text: '#000000' },
  'PARTIAL - REPORTED': { bg: '#38761d', text: '#FFFFFF' },
  'SENT TO DYE HOUSE': { bg: '#f1c232', text: '#000000' },
  'HOLD': { bg: '#e69138', text: '#FFFFFF' },
  'CANCELLED': { bg: '#20124d', text: '#FFFFFF' },
  'CONTAINERS': { bg: '#3d85c6', text: '#FFFFFF' },
  'READY FOR DYE HOUSE': { bg: '#e066cc', text: '#FFFFFF' },
  'PENDIENTE': { bg: '#cf0000', text: '#FFFFFF' },
  'PARTIAL - Reported': { bg: '#999999', text: '#FFFFFF' },
  'NECESITA LABEL': { bg: '#38761d', text: '#FFFFFF' },
  'PROCESO DE NECK LABEL': { bg: '#cf0000', text: '#FFFFFF' },
  'LABEL LISTO': { bg: '#674ea7', text: '#FFFFFF' },
  'EN ESPERA': { bg: '#b4a7d6', text: '#000000' },
  'EN PRODUCCION': { bg: '#b4a7d6', text: '#000000' },
  'NECESITA EMPACAR': { bg: '#38761d', text: '#FFFFFF' },
  'EN PROCESO DE EMPAQUE': { bg: '#f1c232', text: '#000000' },
  'NECESITA QC': { bg: '#e69138', text: '#FFFFFF' },
  'LISTO PARA FULFILLMENT': { bg: '#20124d', text: '#FFFFFF' },
  'LISTO PARA ENVIO': { bg: '#3d85c6', text: '#FFFFFF' },
  'EJEMPLO APROBADO': { bg: '#6fa8dc', text: '#FFFFFF' },
  'PROCESO DE LABEL': { bg: '#6fa8dc', text: '#FFFFFF' },
  'LISTO PARA INVENTARIO': { bg: '#38761d', text: '#FFFFFF' },
  'ESPERA DE APROBAC': { bg: '#3d85c6', text: '#FFFFFF' },
  'TRIM-PARCIAL': { bg: '#f1c232', text: '#000000' },
  'EN PROCESO': { bg: '#3d85c6', text: '#FFFFFF' },
  'EN ESPERA DE TRIM': { bg: '#cf0000', text: '#FFFFFF' },
  'COMPLETE TRIM': { bg: '#674ea7', text: '#FFFFFF' },
  'BOX LABEL IMPRESO': { bg: '#b4a7d6', text: '#000000' },
  'NEEDS TRIM': { bg: '#b4a7d6', text: '#000000' },
  'Listo': { bg: '#f1c232', text: '#000000' },
  'En curso': { bg: '#3d85c6', text: '#FFFFFF' },
  'EJEMPLO PRIMERO': { bg: '#f1c232', text: '#000000' },
  'LICENCIA': { bg: '#cf0000', text: '#FFFFFF' },
  'APR. POR FOTO': { bg: '#674ea7', text: '#FFFFFF' },
  'APR. PARA EJEMPLO': { bg: '#b4a7d6', text: '#000000' },
  'NEW': { bg: '#3d85c6', text: '#FFFFFF' },
  'REORDER': { bg: '#cf0000', text: '#FFFFFF' },
  'SEPS DONE': { bg: '#674ea7', text: '#FFFFFF' },
  'REORDER W/CHANGE': { bg: '#b4a7d6', text: '#000000' },
  'NEED SAMPLE': { bg: '#b4a7d6', text: '#000000' },
  'WAITING ON INFO': { bg: '#38761d', text: '#FFFFFF' },
  'NEEDS ART FILE': { bg: '#6fa8dc', text: '#FFFFFF' },
  'RHINESTONE': { bg: '#b44253', text: '#FFFFFF' },
  'REVIEW': { bg: '#e69138', text: '#FFFFFF' },
  'N/A': { bg: '#f1c232', text: '#000000' },
  'EMB ORDER': { bg: '#e066cc', text: '#FFFFFF' },
  'BSA': { bg: '#b4a7d6', text: '#000000' },
  'JG': { bg: '#b4a7d6', text: '#000000' },
  'LICENCIA-EJEMPLO PRIMERO': { bg: '#b4a7d6', text: '#000000' },
  'PRODUCCION-EJEMPLO PRIMERO': { bg: '#e066cc', text: '#FFFFFF' },
  'APROBADO': { bg: '#38761d', text: '#FFFFFF' },
  'CUSTOMER': { bg: '#38761d', text: '#FFFFFF' },
  'CUSTOMER WILL PROVIDE LABELS': { bg: '#38761d', text: '#FFFFFF' },
  'SHIPPING': { bg: '#e69138', text: '#FFFFFF' }
};

export const getStatusColor = (value) => {
  if (!value) return null;
  return STATUS_COLORS[value] || null;
};

export const FILTER_COLUMNS = [
  { key: 'blank_status', label: 'Blank Status' },
  { key: 'production_status', label: 'Production Status' },
  { key: 'trim_status', label: 'Trim Status' },
  { key: 'sample', label: 'Sample' },
  { key: 'artwork_status', label: 'Artwork Status' },
  { key: 'client', label: 'Cliente' },
  { key: 'priority', label: 'Priority' },
  { key: 'screens', label: 'Screens' }
];

export const DEFAULT_COLUMNS = [
  { key: 'order_number', label: 'Orden', type: 'text', width: 100 },
  { key: 'customer_po', label: 'Customer PO', type: 'text', width: 160 },
  { key: 'store_po', label: 'Store PO', type: 'text', width: 160 },
  { key: 'cancel_date', label: 'Cancel Date', type: 'date', width: 150 },
  { key: 'client', label: 'Cliente', type: 'select', optionKey: 'clients', width: 190 },
  { key: 'branding', label: 'Branding', type: 'select', optionKey: 'brandings', width: 190 },
  { key: 'priority', label: 'Priority', type: 'select', optionKey: 'priorities', width: 160 },
  { key: 'quantity', label: 'Qty', type: 'number', width: 110 },
  { key: 'due_date', label: 'Entrega', type: 'date', width: 150 },
  { key: 'blank_source', label: 'Blank Source', type: 'select', optionKey: 'blank_sources', width: 180 },
  { key: 'blank_status', label: 'Blank Status', type: 'select', optionKey: 'blank_statuses', width: 210 },
  { key: 'production_status', label: 'Production Status', type: 'select', optionKey: 'production_statuses', width: 240 },
  { key: 'trim_status', label: 'Trim Status', type: 'select', optionKey: 'trim_statuses', width: 180 },
  { key: 'trim_box', label: 'Trim Box', type: 'select', optionKey: 'trim_boxes', width: 140 },
  { key: 'sample', label: 'Sample', type: 'select', optionKey: 'samples', width: 200 },
  { key: 'artwork_status', label: 'Artwork Status', type: 'select', optionKey: 'artwork_statuses', width: 190 },
  { key: 'betty_column', label: 'Betty Column', type: 'select', optionKey: 'betty_columns', width: 240 },
  { key: 'job_title_a', label: 'Job Title A', type: 'link_desc', width: 240 },
  { key: 'job_title_b', label: 'Job Title B', type: 'link_desc', width: 240 },
  { key: 'shipping', label: 'Shipping', type: 'select', optionKey: 'shippings', width: 250 },
  { key: 'notes', label: 'Notas', type: 'text', width: 280 }
];

export const BOARD_COLORS = {
  'MASTER': { bg: '#1a1a2e', accent: '#e94560' },
  'SCHEDULING': { bg: '#0f3460', accent: '#16c79a' },
  'BLANKS': { bg: '#4a1942', accent: '#e066cc' },
  'SCREENS': { bg: '#1b4332', accent: '#52b788' },
  'NECK': { bg: '#6a040f', accent: '#e85d04' },
  'EJEMPLOS': { bg: '#240046', accent: '#7b2cbf' },
  'COMPLETOS': { bg: '#004e64', accent: '#25a18e' },
};

export const getBoardStyle = (board) => {
  const colors = BOARD_COLORS[board];
  if (colors) return { background: `linear-gradient(135deg, ${colors.bg} 0%, ${colors.accent}99 100%)`, borderLeft: `5px solid ${colors.accent}` };
  if (board.startsWith('MAQUINA')) {
    const num = parseInt(board.replace('MAQUINA', '')) || 1;
    const hue = (num * 25) % 360;
    return { background: `linear-gradient(135deg, hsl(${hue}, 50%, 15%) 0%, hsl(${hue}, 60%, 25%) 100%)`, borderLeft: `5px solid hsl(${hue}, 70%, 50%)` };
  }
  return { background: '#333', borderLeft: '5px solid #666' };
};

export const evaluateFormula = (field, order, allCols) => {
  const col = allCols?.find(c => c.key === field);
  if (!col?.formula) return '';
  let expr = col.formula;
  const refs = expr.match(/\b[a-z_]+\b/gi) || [];
  for (const ref of refs) {
    const refLower = ref.toLowerCase();
    if (['if', 'then', 'else', 'and', 'or', 'sum', 'abs'].includes(refLower)) continue;
    const val = parseFloat(order[refLower]) || 0;
    expr = expr.replace(new RegExp(`\\b${ref}\\b`, 'g'), val);
  }
  const ifMatch = expr.match(/IF\s*\(\s*(.+?)\s*,\s*(.+?)\s*,\s*(.+?)\s*\)/i);
  if (ifMatch) {
    try {
      const cond = Function(`"use strict"; return (${ifMatch[1]})`)();
      expr = cond ? ifMatch[2] : ifMatch[3];
    } catch { return '#ERROR'; }
  }
  try {
    const sanitized = String(expr).replace(/[^0-9+\-*/().%\s]/g, '');
    if (!sanitized.trim()) return '';
    const result = Function(`"use strict"; return (${sanitized})`)();
    return typeof result === 'number' ? (Number.isInteger(result) ? result : result.toFixed(2)) : result;
  } catch { return '#ERROR'; }
};

export const ACTION_COLORS = {
  'create_order': 'bg-green-500/20 text-green-400',
  'update_order': 'bg-blue-500/20 text-blue-400',
  'move_order': 'bg-yellow-500/20 text-yellow-400',
  'delete_order': 'bg-red-500/20 text-red-400',
  'permanent_delete_order': 'bg-red-700/20 text-red-500',
  'bulk_move_orders': 'bg-yellow-500/20 text-yellow-400',
  'undo_action': 'bg-purple-500/20 text-purple-400',
};

export const getActionLabels = (t) => ({
  'create_order': t('action_create_order'),
  'update_order': t('action_update_order'),
  'move_order': t('action_move_order'),
  'delete_order': t('action_delete_order'),
  'permanent_delete_order': t('action_permanent_delete'),
  'bulk_move_orders': t('action_bulk_move'),
  'add_comment': t('action_add_comment'),
  'create_automation': t('action_create_automation'),
  'update_automation': t('action_update_automation'),
  'delete_automation': t('action_delete_automation'),
  'automation_triggered': t('action_automation_triggered'),
  'upload_image': t('action_upload_image'),
  'export_orders': t('action_export'),
  'update_options': t('action_update_options'),
  'send_email': t('action_send_email'),
  'login': t('action_login'),
  'logout': t('action_logout'),
  'undo_action': t('action_undo'),
  'register_production': t('action_register_production'),
  'delete_production_log': t('action_delete_production'),
});

export const formatDetails = (action, details, actionLabels) => {
  if (!details) return '';
  switch (action) {
    case 'create_order': return `#${details.order_number || details.order_id}`;
    case 'update_order': return `#${details.order_number || ''} → ${(details.changed_fields || []).filter(f => f !== 'updated_at').join(', ')}`;
    case 'move_order': return `#${details.order_number || ''} ${details.from_board} → ${details.to_board}`;
    case 'delete_order': return `#${details.order_number || details.order_id}`;
    case 'bulk_move_orders': return `${details.order_count} ordenes → ${details.target_board}`;
    case 'add_comment': return `en #${details.order_number || details.order_id}`;
    case 'undo_action': return `${actionLabels[details.undone_action] || details.undone_action}`;
    default: return Object.values(details).filter(v => typeof v === 'string').join(', ').slice(0, 60);
  }
};
