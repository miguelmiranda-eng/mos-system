"""Contratos de respuesta de la superficie externa de MOS (Tarea 1.1 del plan
API MOS↔Command).

REGLAS DEL CONTRATO (documentadas también en docs/api-command/CONTRATOS.md):
  - Nombres SIEMPRE en snake_case. Nada de camelCase.
  - Listas paginadas usan el sobre {total, skip, limit, items}.
  - Fechas/horas como string ISO 8601; las fechas sin hora como "YYYY-MM-DD".
  - Errores: {"detail": "<motivo legible>"} con el código HTTP correcto
    (401 sin autenticar, 403 sin permiso/cliente, 404 no existe).

NOTA DE ADOPCIÓN (regla 0.1: no romper la operación): estos modelos son LA
definición del contrato y se aplican como response_model en los endpoints
NUEVOS (p.ej. GET /api/packing-list). En los endpoints ya vivos no se activan
como validación en runtime todavía: los datos históricos traen tipos sucios
(cantidades como texto, fechas heterogéneas) y un ValidationError tumbaría
respuestas que hoy funcionan. La activación va acompañada de las pruebas E2E
del plan (tarea de Pruebas), endpoint por endpoint.
"""
from typing import List, Optional
from pydantic import BaseModel


# ── Packing list (Tarea 1.2) ─────────────────────────────────────────────────

class PackingLink(BaseModel):
    """El packing list de una orden como dato: hoy es un documento enlazado
    (Google Sheets) con etiqueta y fecha de carga."""
    url: str
    label: Optional[str] = None
    updated_at: Optional[str] = None


class PackingListInfo(BaseModel):
    order_number: str
    client: Optional[str] = None
    customer_po: Optional[str] = None
    qty_ordered: Optional[int] = None
    # None = la orden aún no tiene packing list cargado.
    packing_list: Optional[PackingLink] = None
    # "order" = campo packing_link de la orden; "comment" = sembrado en
    # comentarios (packing_link_seed); None = sin packing.
    source: Optional[str] = None


# ── Órdenes: embarcables y embarcadas ────────────────────────────────────────

class OrdenEmbarcable(BaseModel):
    order_number: Optional[str] = None
    client: Optional[str] = None
    customer_po: Optional[str] = None
    branding: Optional[str] = None
    quantity: Optional[int] = None
    cancel_date: Optional[str] = None
    # Fecha limite de ENVIO (Tarea 3.1), independiente de cancel_date.
    # Puede venir null mientras la orden no la tenga capturada.
    ship_by: Optional[str] = None
    production_status: Optional[str] = None
    board: Optional[str] = None


class PaginaOrdenesEmbarcables(BaseModel):
    total: int
    skip: int
    limit: int
    items: List[OrdenEmbarcable]


class OrdenEmbarcada(BaseModel):
    order_number: Optional[str] = None
    client: Optional[str] = None
    style: Optional[str] = None
    color: Optional[str] = None
    quantity: Optional[int] = None
    customer_po: Optional[str] = None
    board: Optional[str] = None
    due_date: Optional[str] = None
    packing_link: Optional[str] = None
    packing_link_label: Optional[str] = None
    packing_link_at: Optional[str] = None


class PaginaOrdenesEmbarcadas(BaseModel):
    total: int
    skip: int
    limit: int
    items: List[OrdenEmbarcada]


# ── Shipping (registro de envíos con evidencia) ──────────────────────────────

class EvidenciaEnvio(BaseModel):
    id: str
    filename: Optional[str] = None
    url: Optional[str] = None
    type: Optional[str] = None


class RegistroEnvio(BaseModel):
    shipping_id: str
    order_numbers: List[str]
    notes: Optional[str] = None
    evidence: List[EvidenciaEnvio] = []
    # Hitos del envio (Tareas 3.2-3.4): ISO 8601 normalizado a UTC.
    # dispatched_at se sella al registrar el envio (o el valor explicito que
    # venga); packed_at/delivered_at son null hasta que se capturen (la entrega
    # se completa despues via PUT /api/shipping/{shipping_id}). En registros
    # anteriores a esta version los tres pueden venir null: usar created_at
    # como aproximacion del despacho historico.
    packed_at: Optional[str] = None
    dispatched_at: Optional[str] = None
    delivered_at: Optional[str] = None
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: Optional[str] = None


# ── Envíos programados ───────────────────────────────────────────────────────

class EnvioProgramado(BaseModel):
    shipment_id: Optional[str] = None
    order_number: Optional[str] = None
    scheduled_year: Optional[int] = None
    scheduled_month: Optional[int] = None      # 1..12
    scheduled_week: Optional[int] = None       # 1..5 (semana del mes)
    shipment_no: Optional[int] = None          # envío (grupo) dentro de la semana
    scheduled_export_date: Optional[str] = None
    delivery_to: Optional[str] = None
    pl_export: Optional[str] = None
    pl_number: Optional[str] = None
    pl_url: Optional[str] = None
    status: Optional[str] = None
    customer_po: Optional[str] = None
    design_num: Optional[str] = None
    cancel_date: Optional[str] = None
    ship_by: Optional[str] = None              # limite de envio; days_com lo usa si existe
    client: Optional[str] = None
    branding: Optional[str] = None
    quantity: Optional[int] = None
    production_status: Optional[str] = None
    board: Optional[str] = None
    notes: Optional[str] = None
    packing_link: Optional[str] = None
    packing_link_label: Optional[str] = None
    days_com: Optional[int] = None             # días a cancel_date; negativo = vencida
    order_exists: Optional[bool] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
