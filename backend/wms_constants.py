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
    # Convención vieja de cierre, dejó de escribirse el 19-jun-2026 (hoy se
    # cierra con CONFIRMED). Sigue viva en tickets históricos, así que todo
    # predicado de "cerrado" tiene que contemplarla — no está aquí para usarse
    # en escrituras nuevas.
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class PickingStatus:
    UNASSIGNED = "unassigned"
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


# Un pick ticket está ABIERTO si y sólo si el tablero lo muestra. Éste es el
# único predicado que decide a la vez qué se lista y qué bloquea la creación de
# un ticket nuevo, para que valga siempre la regla: si no lo puedes ver, no te
# puede bloquear.
#
# Antes eran dos listas negras distintas y divergieron: el guard de duplicados
# bloqueaba con `status $nin [confirmed, cancelled]` mientras el tablero ocultaba
# `picking_status == completed`. Los tickets cerrados con la convención vieja
# (status="completed") caían justo en medio: invisibles en las tres pestañas
# pero bloqueando la creación. Dejó 319 órdenes imposibles de surtir — el equipo
# no encontraba el ticket por ningún lado y al crear otro salía "ya existe".
TICKET_OPEN_QUERY = {
    "status": {"$nin": [TicketStatus.CONFIRMED, TicketStatus.COMPLETED,
                        TicketStatus.CANCELLED]},
    "picking_status": {"$ne": PickingStatus.COMPLETED},
}

# Estados terminales de un pick ticket (surtido y cerrado, en cualquiera de las
# dos convenciones). Úsese para reportes de productividad/SLA.
TICKET_CLOSED_STATUSES = [TicketStatus.CONFIRMED, TicketStatus.COMPLETED]


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
    LPN_RECONCILED = "lpn_reconciled"          # generic import LPN matched to the box's real physical license plate
    INVENTORY_ROW_RECONCILED = "inventory_row_reconciled"  # fila de inventario faltante reconstruida desde las cajas físicas


class AsnStatus:
    PENDING = "pending"          # Nothing received yet
    PARTIAL = "partial"          # Some items received, more expected
    RECEIVED = "received"        # All expected qty has been received
