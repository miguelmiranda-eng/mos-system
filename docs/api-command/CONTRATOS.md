# Contratos de la API externa MOS ↔ Command

Fuente de verdad: `backend/contracts.py` (modelos Pydantic). Este documento es
su lectura humana y **el único contrato**: lo que no está aquí no es contrato.
Los cambios siguen la **Política de cambios** (última sección).

## Guía rápida para Command

1. **Autenticación:** header `X-API-Key: <llave>` (llave por cliente emitida
   por MOS — RESPUESTAS.md 2.3.a). Nunca por query param.
2. **Cliente:** manda SIEMPRE `?customer=<cliente>` — también en
   POST/PUT/DELETE. Sin él → `403`.
3. **Listados:** manda siempre `skip` y `limit` → recibes el sobre
   `{total, skip, limit, items}`.
4. **Registrar envíos:** `POST /api/shipping` siempre con `strict=true`.
5. **Superficie cerrada:** todo lo que no está en la tabla "Superficie
   permitida" responde `403`. Si Command necesita algo más, se pacta como
   cambio aditivo del contrato.
6. **Tolerancia:** ignora campos que no conozcas y tolera códigos nuevos en
   catálogos cerrados — así los cambios aditivos nunca te rompen.

```bash
curl -H "X-API-Key: $LLAVE" \
  "https://<backend>/api/orders/available-to-ship?customer=SPEKTRUM&skip=0&limit=50"
```

> El OpenAPI generado por FastAPI vive en `/docs` y `/openapi.json` del
> backend (Tarea 7.1) e incluye TODA la API, interna incluida. Sirve para ver
> formas y probar; el contrato exigible es únicamente lo que este documento
> define.

## Reglas generales

| Regla | Detalle |
|---|---|
| Autenticación externa | Header `X-API-Key` con una llave por cliente (ver RESPUESTAS.md 2.3.a). Nunca por query param. |
| Aislamiento | Con llave de API, `customer` es **obligatorio en toda la superficie** (query param, también en POST/PUT/DELETE) → `403` si falta o está fuera del alcance de la llave. |
| Superficie cerrada | **Default-deny (Tarea 2.3):** una llave de API solo puede tocar los endpoints de la tabla "Superficie permitida"; cualquier otra ruta responde `403` antes de llegar al endpoint. |
| Nombres | **snake_case siempre.** No hay camelCase en esta superficie. |
| Listas paginadas | Sobre `{total, skip, limit, items}`. En los endpoints históricos que regresan lista completa, el sobre se pide con `skip` (ver "Paginación bajo demanda"). |
| Fechas | Strings ISO 8601; fechas sin hora como `YYYY-MM-DD`. |
| Errores | `{"detail": "<motivo legible>"}` + código HTTP: 400 parámetro faltante/ inválido, 401 sin autenticar, 403 sin permiso o sin `customer`, 404 no existe. |

## Superficie permitida para llaves de API (Tarea 2.3)

Todo lo que NO está en esta tabla responde `403` para una llave de API. Los
usuarios internos con sesión no pasan por este candado.

| Método y ruta | Aislamiento aplicado |
|---|---|
| `GET /api/packing-list` | La orden debe ser del cliente (1.2) |
| `GET /api/orders` · `/board-counts` · `/shipped` · `/available-to-ship` | Filtro server-side por cliente (2.1) |
| `GET /api/orders/{order}` | La orden debe ser del cliente → `403` (2.3) |
| `GET /api/wms/inventory/history` | Triple candado por cliente (2.2) |
| `GET /api/wms/pick-tickets` | Solo tickets con `customer` del cliente. Tickets viejos sin campo `customer` NO salen (conservador) y los pre-tickets virtuales (concepto de la UI) no se sintetizan. |
| `GET /api/wms/allocations` | El cliente se hereda de la orden referida; lo no resoluble NO sale. |
| `GET /api/wms/shipments` | Ídem (por `order_id`/`order_number`). |
| `GET /api/shipping` (+ `/delay-codes`) | Un registro es visible solo si TODAS sus órdenes resolubles son del cliente y al menos una resuelve; registros mixtos o irresolubles NO salen. `delay-codes` es catálogo estático (sin `customer`). |
| `POST /api/shipping` | `strict` **forzado** + todas las órdenes deben ser del cliente → `400`/`403`. |
| `PUT /api/shipping/{id}` | El registro debe ser visible para el cliente (regla del GET). |
| `GET/POST /api/scheduled-shipments`, `PUT/DELETE /api/scheduled-shipments/{id}` | Solo programaciones cuya orden es del cliente; verificado antes de escribir. `weeks` (config del calendario, sin datos de cliente) viaja completo. |

> Los generadores de documentos de packing (`POST /api/packing/export|preview|
> pallet_label`) son de uso interno: la ruta oficial para Command es
> `GET /api/packing-list`. Producción y el resto del WMS no son superficie de
> API. Si Command necesita un endpoint fuera de esta tabla, es una
> conversación de contrato (aditiva), no un hueco a explotar.

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

## Política de cambios del contrato (Tarea 7.3)

**La fuente de verdad es este documento + `backend/contracts.py`.** La forma
de cualquier otra ruta (uso interno) puede cambiar sin aviso.

### Cambios ADITIVOS — libres, sin aviso previo

- Campos nuevos en respuestas existentes (por eso Command debe ignorar campos
  que no conoce).
- Endpoints nuevos en la superficie permitida.
- Valores nuevos en catálogos cerrados (p. ej. `delay_code`) — Command debe
  tolerar códigos que no conoce.
- Modos opt-in nuevos (como el sobre por `skip`): jamás cambian la respuesta
  de quien no los pide.

### Cambios de RUPTURA — aviso + período de gracia

Renombrar o quitar campos, endpoints o parámetros; cambiar tipos o semántica
de un campo publicado; endurecer un default (p. ej. volver `strict`
obligatorio); retirar mecanismos de compatibilidad (la `MASTER_API_KEY`).

Proceso: **(1)** se anuncia en este documento y en RESPUESTAS.md; **(2)**
corre un período de gracia de **30 días naturales** en el que conviven la
forma vieja y la nueva (o corre el aviso del apagado); **(3)** se ejecuta.
Excepción única: un hueco de seguridad activo se corrige de inmediato, con
aviso directo a Command en paralelo.

### Compromisos de estabilidad (cambiarlos ES ruptura)

- `snake_case`; sobre `{total, skip, limit, items}`; errores
  `{"detail": "..."}` con su código HTTP; fechas ISO 8601 (UTC al guardar,
  `YYYY-MM-DD` sin hora).
- Los campos ya publicados conservan nombre, tipo y semántica.

### Rupturas ya anunciadas (en espera de su disparador)

| Cambio | Disparador |
|---|---|
| Retiro de `MASTER_API_KEY` + bypass `?api_key=` de producción | Command confirma que usa su llave por cliente |
| `strict` obligatorio en `POST /api/shipping` para todos | Command confirma que ya lo manda |
| Validación runtime (`response_model`) en endpoints vivos | Pruebas E2E del plan |

### Historial del contrato

El historial vive en RESPUESTAS.md (una sección por tarea, con su porqué y
sus decisiones) y en el log de git de `docs/api-command/`.
