"""WMS string constants — single source of truth for status enums.

Using plain classes (not Enum) so values remain plain strings for
Mongo serialization and direct equality checks (`x == BoxStatus.RECEIVED`).
"""


class BoxStatus:
    RECEIVED = "received"            # Just received, awaiting putaway
    PUTAWAY_PENDING = "putaway_pending"  # Assigned location but not stored
    STORED = "stored"                # Physically in a shelf
    CROSS_DOCKED = "cross_docked"    # Sent directly to production


class TicketStatus:
    PENDING = "pending"
    CONFIRMED = "confirmed"
    IN_NECK_CUTTING = "in_neck_cutting"


class PickingStatus:
    UNASSIGNED = "unassigned"
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class CycleCountStatus:
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"          # Lines counted, awaiting approval
    APPROVED = "approved"


class TaskType:
    PUTAWAY = "putaway"
    CROSS_DOCK = "cross_dock"
    CYCLE_COUNT = "cycle_count"


class TaskStatus:
    PENDING = "pending"
    COMPLETED = "completed"


class PickDestination:
    PRODUCTION = "production"
    NECK_CUTTING = "neck_cutting"


class MovementType:
    RECEIVING = "receiving"
    PUTAWAY = "putaway"
    PUTAWAY_BULK = "putaway_bulk"
    ALLOCATION = "allocation"
    DEALLOCATE = "deallocate"
    PICK_TICKET_CREATED = "pick_ticket_created"
    PICK_CONFIRMED = "pick_confirmed"
    PRODUCTION_MOVE = "production_move"
    SHIPMENT = "shipment"
    TASK_COMPLETED = "task_completed"
    NECK_CUT_DELIVERY = "neck_cut_delivery"
    CYCLE_COUNT_CREATED = "cycle_count_created"
    CYCLE_COUNT_APPROVED = "cycle_count_approved"
    CYCLE_COUNT_DELETED = "cycle_count_deleted"
    BULK_RELOCATION = "bulk_relocation"
    ASN_IMPORTED = "asn_imported"
    ASN_RECEIPT = "asn_receipt"
    TRANSIT_RELOCATION = "transit_relocation"  # boxes moved out of UBICACION TEMPORAL


class AsnStatus:
    PENDING = "pending"          # Nothing received yet
    PARTIAL = "partial"          # Some items received, more expected
    RECEIVED = "received"        # All expected qty has been received
