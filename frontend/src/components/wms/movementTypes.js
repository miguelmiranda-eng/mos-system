// Tipos de movimiento del WMS → llave i18n. Lo comparten el buscador global
// de cajas (timeline) y Auditoría → Movimientos (desplegable y tabla).
// Friendly labels (i18n keys) for the movement types a box's timeline can surface.
export const MV_TYPE_KEYS = {
  receiving: "wms_mv_receiving", receiving_update: "wms_bs_mv_receiving_update",
  putaway: "wms_bs_mv_putaway", putaway_bulk: "wms_bs_mv_putaway_bulk",
  box_edited: "wms_bs_mv_box_edited", box_deleted: "wms_bs_mv_box_deleted",
  inventory_adjust_box: "wms_bs_mv_inventory_adjust_box", lpn_reconciled: "wms_bs_mv_lpn_reconciled",
  bulk_relocation: "wms_bs_mv_bulk_relocation", transit_relocation: "wms_bs_mv_transit_relocation",
  edit_finished_good: "wms_bs_mv_edit_finished_good", production_move: "wms_bs_mv_production_move",
  shipment: "wms_mv_shipment", allocation: "wms_bs_mv_allocation", deallocate: "wms_mv_deallocate",
  pick_ticket_created: "wms_bs_mv_pick_ticket_created", pick_confirmed: "wms_bs_mv_pick_confirmed",
  pick_progress: "wms_bs_mv_pick_progress", neck_cut_delivery: "wms_bs_mv_neck_cut_delivery",
  manual_inventory_add: "wms_bs_mv_manual_inventory_add", manual_inventory_remove: "wms_bs_mv_manual_inventory_remove",
  // Faltaban: sin ellos el descuento por surtido (el evento que baja las piezas
  // de la caja al surtir una orden) salía como chip crudo "pick deduction", y el
  // resto de eventos de conteo/generación sin etiqueta legible.
  pick_deduction: "wms_bs_mv_pick_deduction", exit_to_production: "wms_bs_mv_exit_to_production",
  cycle_count_shrink: "wms_bs_mv_cycle_count_shrink", cycle_count_manual_discard: "wms_bs_mv_cycle_count_manual_discard",
  cycle_count_manual_create: "wms_bs_mv_cycle_count_manual_create", cycle_count_bind_box: "wms_bs_mv_cycle_count_bind_box",
  box_generated: "wms_bs_mv_box_generated", box_style_restored: "wms_bs_mv_box_style_restored",
  // Auditoría → Movimientos: los tipos frecuentes de la bitácora que no
  // pasan por el timeline de una caja.
  inventory_adjustment: "wms_mvt_inventory_adjustment",
  material_return: "wms_mvt_material_return",
  pick_size: "wms_mvt_pick_size",
  asn_receipt: "wms_mvt_asn_receipt",
  asn_imported: "wms_mvt_asn_imported",
  receiving_deleted: "wms_mvt_receiving_deleted",
  cycle_count_created: "wms_mvt_cycle_count_created",
  cycle_count_progress: "wms_mvt_cycle_count_progress",
  cycle_count_location_closed: "wms_mvt_cycle_count_location_closed",
  cycle_count_adjustment: "wms_mvt_cycle_count_adjustment",
  cycle_count_box_unmatched: "wms_mvt_cycle_count_box_unmatched",
  cycle_count_units_fix: "wms_mvt_cycle_count_units_fix",
  cycle_count_move: "wms_mvt_cycle_count_move",
  cycle_count_restore: "wms_mvt_cycle_count_restore",
  cycle_count_approved: "wms_mvt_cycle_count_approved",
  cycle_count_deleted: "wms_mvt_cycle_count_deleted",
  pick_ticket_edited: "wms_mvt_pick_ticket_edited",
  pick_ticket_assigned: "wms_mvt_pick_ticket_assigned",
  pick_ticket_unassigned: "wms_mvt_pick_ticket_unassigned",
  pick_boxes: "wms_mvt_pick_boxes",
  box_bound: "wms_mvt_box_bound",
  reconciliation_commit: "wms_mvt_reconciliation_commit",
  inventory_row_reconciled: "wms_mvt_inventory_row_reconciled",
  empty_box_removed: "wms_mvt_empty_box_removed",
  inventory_deleted: "wms_mvt_inventory_deleted",
  lif_cart_cleanup: "wms_mvt_lif_cart_cleanup",
  gts_cart_cleanup: "wms_mvt_gts_cart_cleanup",
  upc_internal_generated: "wms_mvt_upc_internal_generated",
  upc_propagate: "wms_mvt_upc_propagate",
  upc_deleted: "wms_mvt_upc_deleted",
  catalog_rename: "wms_mvt_catalog_rename",
  writeoff_papel_muerto: "wms_mvt_writeoff_papel_muerto",
  box_pack_correction: "wms_mvt_box_pack_correction",
  carro_reconciliation: "wms_mvt_carro_reconciliation",
  location_deleted: "wms_mvt_location_deleted",
  location_renamed: "wms_mvt_location_renamed",
  location_hold_add: "wms_mvt_location_hold_add",
  box_reactivated: "wms_mvt_box_reactivated",
  phantom_scan: "wms_mvt_phantom_scan",
  incident_reported: "wms_mvt_incident_reported",
  manual_correction: "wms_mvt_manual_correction",
  location_check_created: "wms_mvt_location_check_created",
  location_check_resolved: "wms_mvt_location_check_resolved",
};

// Etiqueta legible de un tipo de movimiento; los tipos sin traducción (hay
// ~100 en la bitácora, muchos de scripts de limpieza) salen con el código
// en palabras ("lif cart cleanup").
export const mvTypeLabel = (type, t) => (MV_TYPE_KEYS[type] ? t(MV_TYPE_KEYS[type]) : String(type || "").replace(/_/g, " "));

// Familias para el desplegable de Auditoría → Movimientos: un clic filtra
// todas las variantes de un mismo hecho físico. El putaway de la PDA se
// registra como `transit_relocation` (carro → ubicación) y el tipo `putaway`
// es el flujo viejo (último registro may-2026); buscar "putaway" debe traer
// los dos. El valor es la lista separada por comas que acepta el backend.
export const MV_TYPE_FAMILIES = [
  { id: "putaway", labelKey: "wms_mvf_putaway", types: ["transit_relocation", "putaway", "putaway_bulk"] },
];
