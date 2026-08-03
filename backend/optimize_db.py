import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

# WMS-009: the wms_* collections had ZERO indexes, so picking/putaway/inventory
# queries (by sku/color/size/location/status) were full collection scans. Each
# entry is (collection, keys, options). Keys is a single field name or a list of
# (field, direction) tuples for compound indexes. Every create is wrapped in
# try/except so a pre-existing duplicate (e.g. drifted box_id) can't block boot.
WMS_INDEXES = [
    ("wms_inventory", [("sku", 1), ("color", 1), ("size", 1), ("location", 1)], {}),
    ("wms_inventory", [("style", 1), ("color", 1), ("size", 1), ("location", 1)], {}),
    ("wms_inventory", "inventory_id", {"unique": True}),
    ("wms_inventory", "location", {}),
    ("wms_boxes", [("sku", 1), ("color", 1), ("size", 1), ("location", 1), ("units", 1)], {}),
    ("wms_boxes", [("style", 1), ("color", 1), ("size", 1), ("location", 1)], {}),
    # Consultas SOLO por location (p.ej. _cc_bind_candidates del conteo ciclico,
    # que busca las cajas fantasma de una ubicacion al identificar un LPN fisico
    # desconocido) no calzaban con ninguno de los compuestos de arriba (location
    # va 4ta, Mongo no la usa como prefijo). Sin esto caia al indice de box_id y
    # examinaba las ~50k cajas "LPN*" completas por cada escaneo no resuelto
    # (verificado: 49,980 examinados -> 12 tras este indice). Confirmado en vivo
    # 2026-07-18 durante el conteo general.
    ("wms_boxes", "location", {}),
    ("wms_boxes", "box_id", {"unique": True}),
    ("wms_boxes", "receiving_id", {}),
    ("wms_boxes", [("status", 1), ("state", 1)], {}),
    ("wms_boxes", "seq_num", {}),
    # Etiqueta física escaneable (LPN externo o BOX- registrado). Sparse porque
    # solo se llena cuando el picker escanea por primera vez la caja física.
    # Unique para que un mismo LPN nunca apunte a dos cajas distintas.
    ("wms_boxes", "physical_lpn", {"unique": True, "sparse": True, "name": "uniq_physical_lpn"}),
    ("wms_pick_tickets", "ticket_id", {"unique": True}),
    ("wms_pick_tickets", [("assigned_to", 1), ("status", 1)], {}),
    ("wms_pick_tickets", "order_id", {}),
    ("wms_pick_tickets", "status", {}),
    ("wms_movements", [("created_at", -1)], {}),
    ("wms_tasks", [("task_type", 1), ("status", 1)], {}),
    ("wms_locations", "name", {}),
    ("wms_asn", "asn_id", {}),
    # wms_cycle_counts no tenia NINGUN indice mas alla de _id: cada operacion del
    # conteo por caja (scan-location, unscan, close, resolve) busca por count_id
    # sin indice. La coleccion es chica (~30 docs) pero cada documento de un
    # pasillo del conteo general pesa hasta ~280KB (scan_locations embebido) y se
    # reescribe entero en cada escaneo. Confirmado en vivo 2026-07-18.
    ("wms_cycle_counts", "count_id", {"unique": True}),
    # wms_recon_phantom no tenia NINGUN indice. El escaneo de stock fantasma
    # hace un find_one_and_update POR ITEM (~2,000 por corrida) buscando por
    # phantom_id: sin indice, cada uno es un collection scan de la coleccion
    # entera -> ~2,000 x 2,000 comparaciones por escaneo. Observado en vivo el
    # 2026-08-03: el job nocturno reclamo su turno a las 23:19 y seguia sin
    # terminar 5 minutos despues.
    # NO unique, aunque phantom_id sea determinista por llave y el upsert ya
    # asuma que identifica una sola fila: la coleccion tiene 3 documentos
    # LEGADOS sin phantom_id que no son fantasmas — son bitacoras de borrados
    # autorizados (hard_delete_location_phantom PO#1849,
    # hard_delete_customer_material SPEKTRUM, delete_duplicate_pick_ticket) que
    # se guardaron aqui en vez de en una coleccion de auditoria. Con `unique`
    # el indice NO se crearia (tres nulls colisionan) y ensure_wms_indexes lo
    # saltaria en silencio, dejando el escaneo lento para siempre: justo el
    # modo de fallo que se acaba de corregir. El rendimiento lo da el indice,
    # no la unicidad.
    ("wms_recon_phantom", "phantom_id", {}),
    # La pestana Stock Fantasma lista lo pendiente ordenado por delta.
    ("wms_recon_phantom", [("status", 1), ("delta", -1)], {}),
    # Core (non-WMS) uniqueness guards against duplicate generated IDs.
    ("invoices", "invoice_id", {"unique": True}),
]


async def ensure_wms_indexes(db):
    """Create the WMS indexes if missing. Idempotent and boot-safe: a unique
    index that can't be built (existing duplicates) is logged and skipped rather
    than crashing startup, so the lookup indexes still get created. Also seeds the
    atomic box-sequence counter from the current max so concurrent receivings stop
    minting duplicate BOX-ids (read-max-then-+1 race)."""
    created, skipped = 0, 0
    for coll, keys, opts in WMS_INDEXES:
        try:
            await db[coll].create_index(keys, **opts)
            created += 1
        except Exception as e:
            skipped += 1
            print(f"WMS index skipped on {coll} {keys}: {e}")
    print(f"WMS indexes ensured ({created} ok, {skipped} skipped).")

    # Seed the box-sequence counter once, from the current highest seq_num, so the
    # atomic generator (_reserve_box_seqs) never collides with existing BOX-ids.
    try:
        if not await db.counters.find_one({"_id": "wms_box_seq"}):
            last = await db.wms_boxes.find_one(sort=[("seq_num", -1)], projection={"seq_num": 1})
            max_seq = int((last or {}).get("seq_num", 0) or 0)
            await db.counters.update_one(
                {"_id": "wms_box_seq"}, {"$setOnInsert": {"seq": max_seq}}, upsert=True
            )
            print(f"Seeded wms_box_seq counter at {max_seq}.")
    except Exception as e:
        print(f"Could not seed wms_box_seq counter: {e}")


# Core (non-WMS) indexes. These were previously created only by main() (a manual
# script), so on a fresh deploy the hot queries ran as full collection scans:
#  • user_sessions/users → hit on EVERY authenticated request (deps.get_current_user)
#  • orders → dashboard listing + sort by created_at + lookups by order_id/number
#  • qc_records → /qc/stats and the QC record listing (had ZERO indexes)
# Same (collection, keys, options) shape as WMS_INDEXES; every create is wrapped so
# a pre-existing duplicate can't block boot.
CORE_INDEXES = [
    # Auth — every authenticated request does these two find_ones.
    ("user_sessions", "session_token", {"unique": True}),
    ("users", "user_id", {"unique": True}),
    # Orders — dashboard listing/sort/lookup.
    ("orders", "board", {}),
    ("orders", "order_number", {}),
    ("orders", "status", {}),
    ("orders", "order_id", {}),
    ("orders", [("created_at", -1)], {}),
    # Defense-in-depth against duplicate Printavo imports: no two auto-synced orders
    # may share an order_number. Partial (source=printavo_auto only) so manual orders
    # and the trash+recreate flow are unaffected. Custom name to avoid colliding with
    # the plain order_number_1 index above. Skips silently if legacy duplicates exist
    # (run dedupe_printavo_orders.py --apply first, then it builds on next boot).
    ("orders", "order_number", {"unique": True, "name": "uniq_printavo_order_number",
                                "partialFilterExpression": {"source": "printavo_auto"}}),
    # Notifications / activity / production.
    ("notifications", [("user_id", 1), ("created_at", -1)], {}),
    ("activity_logs", [("timestamp", -1)], {}),
    ("activity_logs", [("timestamp", -1), ("action", 1)], {}),
    ("production_logs", "created_at", {}),
    ("production_logs", "order_id", {}),
    # QC — /qc/stats ($facet) + record listing sorted by created_at.
    ("qc_records", [("result", 1), ("severity", 1)], {}),
    ("qc_records", [("created_at", -1)], {}),
]


async def ensure_core_indexes(db):
    """Create the core (non-WMS) indexes if missing. Idempotent and boot-safe:
    a unique index that can't be built (existing duplicates) is logged and skipped
    rather than crashing startup."""
    created, skipped = 0, 0
    for coll, keys, opts in CORE_INDEXES:
        try:
            await db[coll].create_index(keys, **opts)
            created += 1
        except Exception as e:
            skipped += 1
            print(f"Core index skipped on {coll} {keys}: {e}")
    print(f"Core indexes ensured ({created} ok, {skipped} skipped).")


async def main():
    load_dotenv(Path(__file__).parent / '.env')
    mongo_url = os.environ.get('MONGO_URL') or os.environ.get('MONGODB_URI') or os.environ.get('MONGODB_URL')
    if not mongo_url:
        print("No Mongo URL found")
        return
    
    client = AsyncIOMotorClient(mongo_url)
    db_name = os.environ.get('DB_NAME', 'mos-system')
    db = client[db_name]
    
    print(f"Checking core indexes for {db_name}...")
    await ensure_core_indexes(db)

    try:
        from datetime import datetime, timedelta, timezone
        cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        result = await db.notifications.delete_many({"created_at": {"$lt": cutoff}})
        if result.deleted_count > 0:
            print(f"Cleaned up {result.deleted_count} old notifications")

        # Cleanup old activity logs (keep 30 days)
        log_cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        log_result = await db.activity_logs.delete_many({"timestamp": {"$lt": log_cutoff}})
        if log_result.deleted_count > 0:
            print(f"Cleaned up {log_result.deleted_count} old activity logs")

        # Cleanup expired sessions (keep 30 days)
        session_cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        session_result = await db.user_sessions.delete_many({"expires_at": {"$lt": session_cutoff}})
        if session_result.deleted_count > 0:
            print(f"Cleaned up {session_result.deleted_count} expired sessions")

        # Cleanup password resets (keep 7 days)
        reset_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        reset_result = await db.password_resets.delete_many({"expires_at": {"$lt": reset_cutoff}})
        if reset_result.deleted_count > 0:
            print(f"Cleaned up {reset_result.deleted_count} old password resets")
    except Exception as e:
        print(f"Error during cleanup: {e}")

    # WMS-009: ensure WMS collection indexes when run as a standalone script too.
    try:
        await ensure_wms_indexes(db)
    except Exception as e:
        print(f"Error ensuring WMS indexes: {e}")

    print("Optimization finished.")

if __name__ == "__main__":
    asyncio.run(main())
