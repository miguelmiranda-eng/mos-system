# Contratos de la API externa MOS ↔ Command

Fuente de verdad: `backend/contracts.py` (modelos Pydantic). Este documento es
su lectura humana. Cambios a estos contratos siguen la política de la tarea 7.x
(aditivos libres; renombrar o quitar campos exige aviso y período de gracia).

## Reglas generales

| Regla | Detalle |
|---|---|
| Autenticación externa | Header `X-API-Key` con una llave por cliente (ver RESPUESTAS.md 2.3.a). Nunca por query param. |
| Aislamiento | Con llave de API, `customer` es **obligatorio** donde aplica → `403` si falta o está fuera del alcance de la llave. |
| Nombres | **snake_case siempre.** No hay camelCase en esta superficie. |
| Listas paginadas | Sobre `{total, skip, limit, items}`. |
| Fechas | Strings ISO 8601; fechas sin hora como `YYYY-MM-DD`. |
| Errores | `{"detail": "<motivo legible>"}` + código HTTP: 400 parámetro faltante/ inválido, 401 sin autenticar, 403 sin permiso o sin `customer`, 404 no existe. |

## 1. `GET /api/packing-list` — la ruta ÚNICA del packing list (Tarea 1.2)

Command no debe intentar ninguna otra ruta para obtener el packing list.

**Parámetros:** `order` (número de orden, obligatorio) · `customer`
(obligatorio con llave de API; la orden debe pertenecer a ese cliente → 403).

**Respuesta** (`PackingListInfo`):

```json
{
  "order_number": "2911",
  "client": "Goodie Two Sleeves LLC",
  "customer_po": "22359",
  "qty_ordered": 480,
  "packing_list": {
    "url": "https://docs.google.com/spreadsheets/d/…",
    "label": "PL-2911",
    "updated_at": "2026-08-12T18:03:22+00:00"
  },
  "source": "comment"
}
```

- `packing_list` es `null` cuando la orden aún no tiene packing cargado.
- `source`: `"order"` (campo de la orden) o `"comment"` (sembrado en
  comentarios); la resolución es la misma que usa el programador de envíos —
  **el más fresco gana**.
- Hoy el packing list es un documento enlazado (Google Sheets). Si Command
  necesita el CONTENIDO estructurado (renglones/cajas), es una iteración
  siguiente sobre esta misma ruta — requiere resolver con qué credencial de
  Google lee el servidor (anotado en RESPUESTAS.md).

## 2. `GET /api/orders/available-to-ship` (`PaginaOrdenesEmbarcables`)

`skip`/`limit` (tope 5000) · `search` opcional · `customer` obligatorio con
llave de API. Sobre paginado; `items[]`: `order_number, client, customer_po,
branding, quantity, cancel_date, ship_by, production_status, board`.

> `ship_by` (Tarea 3.1) es la **fecha límite de envío**, independiente de
> `cancel_date` (fecha de cancelación del cliente). Puede venir `null` mientras
> la orden no la tenga capturada.

## 3. `GET /api/orders/shipped` (`PaginaOrdenesEmbarcadas`)

Órdenes con packing cargado. Sobre paginado; `items[]`: `order_number, client,
style, color, quantity, customer_po, board, due_date, packing_link,
packing_link_label, packing_link_at`.

## 4. Shipping — `GET /api/shipping`, `POST /api/shipping`, `PUT /api/shipping/{shipping_id}`

`GET` con filtro `?date=YYYY-MM-DD`. Lista simple (histórico; se documenta tal
cual — migrar al sobre paginado rompería a los consumidores actuales y se hará
junto con las pruebas E2E). Cada `RegistroEnvio`: `shipping_id,
order_numbers[], notes, evidence[] {id, filename, url, type}, packed_at,
dispatched_at, delivered_at, created_by, created_by_name, created_at`.

**Timestamps (Tareas 3.2-3.4)** — reglas:

| Campo | Regla |
|---|---|
| Formato | ISO 8601 **con zona horaria** (`2026-08-28T15:30:00-07:00` o `…Z`). Sin zona → `400`. Se normalizan a UTC al guardar. |
| `dispatched_at` | Registrar el envío ES el despacho: el `POST` lo sella con el momento actual, salvo que venga explícito. |
| `packed_at` | Opcional en el `POST`; no se inventa. |
| `delivered_at` | Casi siempre llega días después: se captura con `PUT /api/shipping/{shipping_id}` mandando `{"delivered_at": "…"}` (acepta cualquiera de los tres campos; solo toca los que vienen). |
| Registros históricos | Anteriores a esta versión traen los tres en `null`: usar `created_at` como aproximación del despacho. |

> Nota (tareas 6.x pendientes): `order_numbers` sigue siendo texto capturado
> sin validar contra órdenes, y `delay_code` no existe aún. Ese endurecimiento
> es la tarea 6.1-6.3.

## 5. `GET /api/scheduled-shipments` (`{items: EnvioProgramado[], weeks: […]}`)

`items[]` con el envío programado unido a los datos vivos de la orden:
`shipment_id, order_number, scheduled_year, scheduled_month (1-12),
scheduled_week (1-5), shipment_no, scheduled_export_date, delivery_to,
pl_export, pl_number, pl_url, status, customer_po, design_num, cancel_date,
ship_by, client, branding, quantity, production_status, board, notes,
packing_link, packing_link_label, days_com, order_exists, created_at,
updated_at`.

> `days_com` = días de hoy a la **fecha límite de envío**: `ship_by` cuando la
> orden lo tiene (Tarea 3.1), con fallback a `cancel_date` mientras no
> (negativo = vencida). Ambas fechas viajan por separado para que Command no
> tenga que adivinar cuál se usó.

## Adopción y validación en runtime

Los modelos se aplican como `response_model` en los endpoints **nuevos**
(`/api/packing-list` ya valida su salida). En los endpoints vivos la validación
en runtime se activará endpoint por endpoint junto con las pruebas E2E (los
datos históricos traen tipos sucios y una activación ciega rompería respuestas
que hoy funcionan — regla 0.1).
