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
| Listas paginadas | Sobre `{total, skip, limit, items}`. En los endpoints históricos que regresan lista completa, el sobre se pide con `skip` (ver "Paginación bajo demanda"). |
| Fechas | Strings ISO 8601; fechas sin hora como `YYYY-MM-DD`. |
| Errores | `{"detail": "<motivo legible>"}` + código HTTP: 400 parámetro faltante/ inválido, 401 sin autenticar, 403 sin permiso o sin `customer`, 404 no existe. |

## Cantidades: `qty_ordered` vs `qty_shipped` (Tarea 4.1)

El par viaja en toda la superficie de embarque (packing-list,
available-to-ship, shipped, shipping, scheduled-shipments):

| Campo | Semántica |
|---|---|
| `qty_ordered` | Lo pedido: lectura numérica de `orders.quantity`. `null` cuando la orden no existe o su cantidad histórica no es un número. Donde también viaja `quantity`, ese es el valor crudo histórico (los consumidores viejos lo siguen recibiendo tal cual). |
| `qty_shipped` | Lo embarcado: entero ≥ 0, **derivado al leer** de la bitácora del WMS — descuentos de pick (`pick_deduction`) + embarques directos de cajas sin pick. NO es un contador guardado: no puede desincronizarse del inventario. `0` = sin salidas registradas en el WMS. |

> Nota honesta: `qty_shipped` refleja lo que el WMS registró. Salidas
> anteriores al WMS (era Excel) no están en la bitácora y no se inventan.

## Paginación bajo demanda (Tareas 5.1-5.3)

Los endpoints que ya nacían paginados (`available-to-ship`, `shipped`) no
cambian. Los históricos que regresan lista completa ahora aceptan el sobre
**por opt-in**, sin mover a ningún consumidor actual:

**La regla:** mandar **`skip`** (aunque sea `0`) activa el sobre
`{total, skip, limit, items}`. Sin `skip`, la respuesta tiene exactamente la
forma de siempre; `limit` funciona en ambos modos (sin sobre solo recorta la
lista). Recomendación para Command: mandar **siempre** `skip` y `limit`.

| Endpoint | Sin `skip` (histórico, intacto) | Con `skip` |
|---|---|---|
| `GET /api/orders` | Lista plana (tope `limit`, default 1000; con caché global) | Sobre; `limit` tope 5000; sin caché global (cada página es consulta directa). `total` de una búsqueda = lo que sobrevivió al filtro. |
| `GET /api/shipping` | Lista plana (default 100) | Sobre (`PaginaRegistrosEnvio`); `limit` tope 5000 |
| `GET /api/scheduled-shipments` | `{items, weeks}` (todo) | `{total, skip, limit, items, weeks}` (`PaginaEnviosProgramados`) |

> `GET /api/wms/inventory/history` queda fuera a propósito: es una vista
> acotada de movimientos recientes (knob `limit`, filtro posterior en Python);
> un `total` ahí sería mentiroso. Si Command necesita recorrer historia
> completa de movimientos, es una conversación aparte.

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
  "qty_shipped": 336,
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
branding, quantity, qty_ordered, qty_shipped, cancel_date, ship_by,
production_status, board` (el par de cantidades: Tarea 4.1, ver arriba).

> `ship_by` (Tarea 3.1) es la **fecha límite de envío**, independiente de
> `cancel_date` (fecha de cancelación del cliente). Puede venir `null` mientras
> la orden no la tenga capturada.

## 3. `GET /api/orders/shipped` (`PaginaOrdenesEmbarcadas`)

Órdenes con packing cargado. Sobre paginado; `items[]`: `order_number, client,
style, color, quantity, qty_ordered, qty_shipped, customer_po, board, due_date,
packing_link, packing_link_label, packing_link_at` (el par de cantidades:
Tarea 4.1, ver arriba).

## 4. Shipping — `GET /api/shipping`, `POST /api/shipping`, `PUT /api/shipping/{shipping_id}`

`GET` con filtro `?date=YYYY-MM-DD`. Lista simple por default; con `skip`
responde el sobre paginado (ver "Paginación bajo demanda" — Tarea 5.2). Cada
`RegistroEnvio`: `shipping_id,
order_numbers[], orders_detail[], unknown_orders[], delay_code, notes,
evidence[] {id, filename, url, type}, packed_at, dispatched_at, delivered_at,
created_by, created_by_name, created_at`.

**`orders_detail[]` (Tarea 4.1)** — espejo de `order_numbers` con el par de
cantidades por orden: `{order_number, qty_ordered, qty_shipped}`. Un número
que no corresponde a una orden viva trae `qty_ordered: null`; `qty_shipped` se
deriva de la bitácora del WMS por número, exista o no la orden. El `PUT`
devuelve el registro ya enriquecido con `orders_detail`.

**Validación de `order_numbers` (Tarea 6.1)** — el `POST` valida cada número
contra las órdenes vivas (fuera de papelera):

| Modo | Comportamiento |
|---|---|
| Default | Guarda igual y **avisa**: la respuesta del `POST` y el registro traen `unknown_orders[]` (foto al momento de registrar; no se recalcula sobre historia). |
| `strict=true` (campo de form) | **Rechaza con `400`** si algún número no es orden viva o si no viene ningún número. **Command debe mandar siempre `strict=true`** — el modo aviso existe para no romper a los consumidores mientras adoptan la validación. |

**`delay_code` (Tareas 6.2-6.3)** — causa de retraso, catálogo **CERRADO**
(fuera de catálogo → `400`; el detalle libre va en `notes`; `null` = sin
retraso declarado). Opcional en el `POST`; se captura o corrige después con
`PUT /api/shipping/{shipping_id}` (`{"delay_code": "carrier_issue"}`; `null`
lo limpia). El catálogo se enumera en **`GET /api/shipping/delay-codes`** →
`{delay_codes: [{code, label}]}`:

| `code` | Significado |
|---|---|
| `customer_request` | El cliente pidió mover la fecha |
| `production_delay` | Producción no llegó a tiempo |
| `materials_shortage` | Faltó material o insumo |
| `carrier_issue` | Problema con el transportista |
| `documentation` | Documentación (aduana, permisos, papeles) |
| `weather` | Clima u otra fuerza mayor |
| `other` | Otra causa (detallar en `notes`) |

> Alcance fijado por regla del jefe: esto NO es un TMS. No hay carriers,
> tracking por paquete ni eventos de ruta — un código de causa por registro y
> el detalle en `notes`. Agregar una causa nueva es cambio aditivo del
> catálogo, no texto libre.

**Timestamps (Tareas 3.2-3.4)** — reglas:

| Campo | Regla |
|---|---|
| Formato | ISO 8601 **con zona horaria** (`2026-08-28T15:30:00-07:00` o `…Z`). Sin zona → `400`. Se normalizan a UTC al guardar. |
| `dispatched_at` | Registrar el envío ES el despacho: el `POST` lo sella con el momento actual, salvo que venga explícito. |
| `packed_at` | Opcional en el `POST`; no se inventa. |
| `delivered_at` | Casi siempre llega días después: se captura con `PUT /api/shipping/{shipping_id}` mandando `{"delivered_at": "…"}` (acepta los tres hitos y `delay_code`; solo toca los que vienen). |
| Registros históricos | Anteriores a esta versión traen los tres en `null`: usar `created_at` como aproximación del despacho. |

## 5. `GET /api/scheduled-shipments` (`{items: EnvioProgramado[], weeks: […]}`)

Con `skip` responde el sobre paginado `{total, skip, limit, items, weeks}`
(ver "Paginación bajo demanda" — Tarea 5.3).
`items[]` con el envío programado unido a los datos vivos de la orden:
`shipment_id, order_number, scheduled_year, scheduled_month (1-12),
scheduled_week (1-5), shipment_no, scheduled_export_date, delivery_to,
pl_export, pl_number, pl_url, status, customer_po, design_num, cancel_date,
ship_by, client, branding, quantity, qty_ordered, qty_shipped,
production_status, board, notes, packing_link, packing_link_label, days_com,
order_exists, created_at, updated_at` (el par de cantidades: Tarea 4.1, ver
arriba).

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
