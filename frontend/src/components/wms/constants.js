// WMS string constants — must mirror backend/wms_constants.py
// Frozen so they can't be mutated at runtime.

export const BoxStatus = Object.freeze({
  RECEIVED: "received",
  PUTAWAY_PENDING: "putaway_pending",
  STORED: "stored",
  CROSS_DOCKED: "cross_docked",
});

export const TicketStatus = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  IN_NECK_CUTTING: "in_neck_cutting",
});

export const PickingStatus = Object.freeze({
  UNASSIGNED: "unassigned",
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
});

export const CycleCountStatus = Object.freeze({
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  APPROVED: "approved",
});

export const AsnStatus = Object.freeze({
  PENDING: "pending",
  PARTIAL: "partial",
  RECEIVED: "received",
});

export const TaskType = Object.freeze({
  PUTAWAY: "putaway",
  CROSS_DOCK: "cross_dock",
  CYCLE_COUNT: "cycle_count",
});

export const PickDestination = Object.freeze({
  PRODUCTION: "production",
  NECK_CUTTING: "neck_cutting",
});

// UI-only filters (not persisted)
export const BoardFilter = Object.freeze({
  ALL: "ALL",
  SCHEDULING: "SCHEDULING",
  BLANKS: "BLANKS",
});

export const BpoFilter = Object.freeze({
  ALL: "ALL",
  REGULAR: "REGULAR",
  BPO: "BPO",
});
