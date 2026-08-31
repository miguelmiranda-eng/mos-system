# Respuestas al plan de tareas — API MOS ↔ Command

Documento vivo: cada tarea del plan se responde aquí con lo que se hizo, lo que
se encontró y las decisiones tomadas. Se actualiza tarea por tarea.

## Estado

| Tarea | Descripción corta | Estado |
|---|---|---|
| 0.1 | Auditoría técnica previa | ✅ Completa |
| 1.1 | Esquemas JSON tipados | ✅ Completa (ver nota de adopción) |
| 1.2 | Ruta única de Packing List | ✅ Completa |
| 2.1 | `customer` obligatorio en búsqueda de órdenes | ✅ Completa |
| 2.2 | Contexto de cliente en historial de inventario | ✅ Completa |
| 2.3 | Auditoría multi-tenant global | ✅ Completa (retiro de llave maestra pendiente de Command) |
| 3.1 | `ship_by` separado de `cancel_date` | ✅ Completa |
| 3.2 | `dispatched_at` ISO 8601 | ✅ Completa |
| 3.3/3.4 | `packed_at`, `delivered_at` + doc | ✅ Completa |
| 4.1 | `qty_ordered` vs `qty_shipped` | ✅ Completa |
| 4.2 | Pulls → Hold/Allocation | ⬜ Pendiente |
| 4.3 | Múltiples pick tickets por orden | ⬜ Pendiente |
| 5.1-5.3 | Paginación estandarizada | ✅ Completa |
| 5.4 | Enum de estados de orden | ⬜ Pendiente |
| 6.1-6.3 | Shipping estructurado + `delay_code` | ✅ Completa |
| 7.1-7.3 | Documentación de API | ✅ Completa |
| Pruebas | E2E con Command + regresión | 🔄 Batería A verde en producción (28/28); B espera llave de prueba |

---

## Tarea 0.1 — Auditoría técnica previa a modificaciones

**Regla que gobierna todo el plan: prohibido romper la operación de piso.**
Esta auditoría es 100 % lectura; no se modificó nada.

### 0.1.a — Mapa de routers del backend

El backend (FastAPI, `backend/server.py`) registra ~30 routers. Los relevantes
para el plan:

| Área | Router | Prefijo | Tamaño |
|---|---|---|---|
| Órdenes (incluye available-to-ship) | `routers/orders.py` | `/api/orders` | grande |
| WMS (receiving, inventory, picking, putaway, allocation) | `routers/wms.py` | `/api/wms` | ~13,000 líneas |
| Shipping (registro de envíos con evidencia) | `routers/shipping.py` | `/api/shipping` | 74 líneas |
| Packing (genera el Excel/HTML del packing list) | `routers/packing.py` | `/api/packing` | 741 líneas |
| Envíos programados | `routers/scheduled_shipments.py` | `/api/scheduled-shipments` | 335 líneas |
| Reportes WMS | `routers/wms_reports.py` | — | — |
| Devoluciones WMS | `routers/wms_returns.py` | — | — |

### 0.1.b — La superficie que consume Command (estado actual)

- **`GET/POST /api/shipping`** — registro plano de envíos: `order_numbers` en
  **texto libre** (separado por comas/espacios), `notes` texto libre, archivos de
  evidencia. Sin validación contra órdenes reales, sin timestamps estructurados
  de despacho. *Esto confirma la motivación de las tareas 6.1-6.3.*
- **`GET/POST/PUT/DELETE /api/scheduled-shipments`** — programador de envíos.
  Une su colección propia con datos vivos de la orden. **"Days Com." se calcula
  contra `cancel_date`** — la ambigüedad que la tarea 3.1 quiere eliminar está
  codificada aquí y comentada en el propio archivo.
- **`GET /api/orders/available-to-ship`** — paginado (skip/limit/total), busca
  por `order_number`/`client`/`customer_po` **sin exigir cliente**.
- **`POST /api/packing/export|preview|pallet_label`** — genera el packing list
  (Excel/HTML) desde un payload que arma el frontend. **No existe un
  `GET /api/packing-list`** que devuelva datos estructurados: por eso Command
  "intenta rutas múltiples" (tarea 1.2). Hoy el packing list como *dato* vive en
  los comentarios de la orden como link de Google Sheets (`packing_link` +
  comentarios `packing_link_seed`).

### 0.1.c — Modelo de autenticación (crítico para 2.x)

Tres formas de entrar (`backend/deps.py`):

1. **Cookie de sesión** — usuarios internos de MOS (frontend). Roles:
   operador / admin nivel 1-5 / supersu.
2. **`INTERNAL_SYNC_TOKEN`** (Bearer) — procesos internos; equivale a admin.
3. **`MASTER_API_KEY`** (header `X-API-Key` o query `api_key`) — integraciones
   externas. **Devuelve un usuario admin SIN amarre a ningún cliente.**

> ⚠️ **Hallazgo principal de la auditoría:** aunque se implemente la tarea 2.1
> (parámetro `customer` obligatorio), un consumidor externo con la
> `MASTER_API_KEY` puede pedir el cliente que quiera: la llave es única y global.
> El aislamiento multi-tenant real exige **llaves por cliente** (cada llave
> amarrada a su tenant y validada server-side), como parte de la tarea 2.3.
> Además, la llave se acepta por **query param** (`?api_key=`), lo que la deja
> expuesta en logs de proxys; debe quedar solo en header.
>
> ⚠️ **Hallazgo agravante (precisado):** la validación de la llave vive dentro
> de `get_current_user()` y devolvía rol `admin`, así que además de todo lo
> `require_auth` pasaba **`require_admin`** (vía `SUPER_ROLES`), **`require_role`
> completo** (bypass explícito para admin) y los candados de admin nivel 1.
> No pasaba `require_supersu` (ese exige rol `supersu` estricto) ni niveles 2+.
> Aun así: una sola llave externa, sin amarre a cliente, con poderes de admin
> operativo en todo el sistema. *(Corregido el 2026-08-28: una versión previa de
> este documento afirmaba que también pasaba supersu; no era exacto.)*

### 0.1.d — Confirmaciones puntuales de lo que el plan asume

| Suposición del plan | Verificación en código |
|---|---|
| La búsqueda de órdenes no exige cliente (2.1) | Confirmado: `GET /api/orders?search=` busca global contra cualquier campo (`orders.py:144`) |
| Un solo pick ticket por orden obliga a sub-órdenes (4.3) | Confirmado: candado "Ya existe un pick ticket activo para la orden" (`wms.py:5415` y `wms.py:6930`) |
| `cancel_date` se usa como fecha de envío (3.1) | Confirmado: `scheduled_shipments.py` calcula "Days Com." contra `cancel_date` |
| KPIs de envío en notas de texto libre (6.x) | Confirmado: `shipping.py` guarda `notes` y `order_numbers` como texto libre |
| Estados de orden = texto libre de Boards (5.4) | Confirmado: no existe enum; `board` y `production_status` son strings libres; las **automatizaciones se disparan por cambio de estatus** |

### 0.1.e — Procesos de piso y consumidores por área

Barrido completo de `frontend/src` (PC + PDA) contra las rutas del backend.

**La superficie del PISO (PDA) es chica y precisa — 3 archivos:**

| Área | Endpoints que usa el piso (PDA) |
|---|---|
| Picking (`PdaPicker.js`) | `GET /api/wms/operator/my-tickets`, `PUT /pick-tickets/{id}/pick-size`, `PUT /pick-tickets/{id}/pick-progress`, `POST /pick-tickets/{id}/scan-box`, `POST /quarantine/report`, `GET /boxes/{code}`, `GET/PUT /api/orders/{id}` |
| Reconciliación (`PdaRecon.js`) | `GET /recon/location/{loc}`, `POST /recon/resolve-scan`, `POST /recon/bind-lpn`, `POST /recon/commit` |
| Foto inventario (`PdaPhoto.js`) | `GET/POST/DELETE /recon/photo/archive` |

**Ninguna ruta de Receiving, ASN, Putaway/Transit, Allocation, Packing,
Shipping ni Scheduled Shipments es tocada por el PDA.** Traducción operativa de
la regla 0.1: los cambios del plan en Shipping/Packing/Scheduled/Orders **no
tocan al piso**; cualquier cambio en la tabla de arriba (picking/recon) **sí**
y exige regresión con PDA en mano.

**Consumidores PC por área (resumen):**

| Área | Componentes que la consumen |
|---|---|
| Shipping + Scheduled + available-to-ship + shipped | Prácticamente **solo `ShippingModule.js`** (+`Dashboard.js` lee scheduled) — superficie compartida con Command, ideal para tiparla (1.1) sin tocar nada más |
| Packing (export/preview/pallet) | Solo `PackingList.js` |
| Receiving / ASN | `wms/Receiving.js`, `wms/Asn.js`, `wms/ReturnReceiving.js` |
| Inventory | `wms/Inventory.js`, `Aging.js`, `Locations.js`, `Mover.js`, `BulkInventoryAdjust.js`, `InventoryDashboard.js` |
| Picking / Allocation | `wms/Picking.js`, `Allocation.js`, `DirectedWork.js`, `CycleCount.js`, `Incidents.js` + PDA |
| Putaway / Transit | `wms/Transit.js`, `PutawayWizard.js` (Putaway 1.0 está **oculto de la navegación** — legado) |

**Endpoints sin ningún consumidor en el frontend** (candidatos a superficie
exclusiva de Command, o código muerto — decidir antes de tipar contratos en 1.1):

- Candidatos externos: `GET /api/wms/shipments`, `POST /api/wms/movements`,
  `POST /api/wms/production/move`, `GET /api/wms/orders-with-tickets`,
  `GET /api/wms/generate-sku`.
- Huérfanos/legado (candidatos a retirar): los alias `stocktakes`/`move-stock`
  (4 rutas), `GET /operator/completed-tickets`, `POST /pick-tickets/{id}/bind-box`
  (sin UI que lo dispare), `POST /quarantine/resolve`, y 6 rutas `recon/photo/*`
  y `recon/label-*` sin consumidor.
- No hay en el repo ningún cliente con `X-API-Key`: el consumidor externo
  (Command) vive fuera del repo. Las pruebas E2E del plan deberán simularlo.

### 0.1.f — Conclusiones y orden de ejecución recomendado

1. **Seguridad primero (2.x)**: llaves por cliente + `customer` obligatorio
   **solo en la superficie externa** — el frontend interno llama estos endpoints
   sin `customer` en todos lados; aplicar el 403 global tumbaría el dashboard.
2. **Contratos (1.x)**: tipar con Pydantic las respuestas de la superficie de
   Command; el OpenAPI (7.x) sale casi gratis de ahí.
3. **Campos nuevos (3.x, 4.1, 6.x)**: aditivos, riesgo bajo, con backfill donde
   aplique.
4. **Los dos de cirugía mayor al final**: 4.3 (múltiples tickets: rediseña el
   descuento de inventario y toca Final Bill) y 5.4 (enum de estados: debe ser
   **capa de mapeo** board/estatus → estado canónico, nunca un reemplazo,
   o se rompen las automatizaciones y el piso).

---

## Tarea 2.3.a — Llaves de API por cliente (primera parte de la 2.3)

**Qué se hizo** (commit correspondiente en `main`):

1. **Llaves por cliente** (`backend/deps.py` + `backend/routers/auth.py`):
   - Nueva colección `api_keys`: cada llave se guarda **hasheada** (SHA-256,
     nunca el texto), amarrada a una **lista explícita de clientes**, con
     nombre, prefijo identificador, `active`, quién la creó y último uso.
   - Autentican **solo por header `X-API-Key`** (nunca query param, que queda
     escrito en logs de proxys).
   - Entran al sistema con rol **`external_api`**: pasan `require_auth` pero
     **ningún candado de admin** (`require_admin`, `require_role`,
     `require_admin_level`, supersu — todos rechazan).
2. **Llave maestra degradada** (`deps.py`): la `MASTER_API_KEY` **sigue
   autenticando** (para no romper a Command mientras migra) pero perdió el rol
   `admin`: ahora es `external_api` con alcance `["*"]`. Ya no pasa
   `require_admin` ni `require_role`.
3. **Gestión (solo supersu)**: `POST /api/auth/api-keys` (crea; devuelve el
   texto de la llave UNA sola vez), `GET /api/auth/api-keys` (lista sin hashes),
   `DELETE /api/auth/api-keys/{key_id}` (revoca). Todo queda en el log de
   actividad.
4. **Gancho para las tareas 2.1/2.2**: `deps.api_customer_scope(user)` devuelve
   el alcance de clientes del solicitante (None = usuario interno; lista = lo
   que la llave puede ver). Los endpoints de las tareas 2.x filtrarán con esto.

**Cómo emitir la llave de Command** (supersu, desde la consola del navegador
con sesión en MOS):

```js
fetch('/api/auth/api-keys', { method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Command', customers: ['SPEKTRUM'] })
}).then(r => r.json()).then(console.log)
```

Guardar el `api_key` devuelto en ese momento (no se puede volver a ver) y
entregarlo a Command para que lo mande en el header `X-API-Key`.

**Plan de retiro de la llave maestra**: cuando Command confirme que usa su
llave nueva → borrar `MASTER_API_KEY` del entorno del backend en EasyPanel.
*(Nota: `deps._llave_obligatoria` exige que la variable exista; al retirarla de
verdad habrá que relajar esa exigencia — un cambio de una línea que se hará en
ese momento.)*

**Qué NO cambió** (a propósito): los bypass explícitos por query param en
`GET /api/orders` y `production.py` siguen comparando contra la llave maestra
tal cual — se retirarán junto con ella. El comportamiento de usuarios internos
(sesión) no se tocó en absoluto.

**Riesgo asumido**: si Command hoy llamara algún endpoint con candado de admin,
dejará de poder (403) — la auditoría 0.1 indica que su superficie es
`require_auth` puro, y un 403 es visible y reversible en un redeploy.

---

## Tarea 2.1 — Parámetro `customer` obligatorio en búsquedas de órdenes

**Decisión de diseño (motivada por la auditoría 0.1):** la exigencia aplica a
los **consumidores de API** (llaves externas: Command). Los usuarios internos
con sesión no cambian — el dashboard y los tableros llaman estos endpoints sin
`customer` en todos lados, y un 403 global los tumbaría (violando la regla 0.1
de no romper la operación).

**Qué se hizo** (`backend/deps.py` + `backend/routers/orders.py`):

1. **`deps.require_api_customer(user, request, campo)`** — el guard reusable de
   las tareas 2.x: para llaves de API exige `?customer=` (**HTTP 403** si
   falta), valida que esté **dentro del alcance de la llave** (403 si no) y
   devuelve el filtro Mongo que el endpoint aplica server-side (regex exacta,
   case-insensitive). Para sesiones internas devuelve None (sin cambio).
2. Aplicado a los **cuatro endpoints de listado de órdenes**:
   - `GET /api/orders` (con o sin `search`) — además, para llaves de API se
     **omite la caché global** (mezclaría clientes) y se eliminó el viejo
     bypass explícito por `?api_key=` (redundante: la llave ya autentica por
     `get_current_user`, ahora con alcance).
   - `GET /api/orders/board-counts` — conteos solo del cliente de la llave
     (`$match` en el pipeline), sin caché global.
   - `GET /api/orders/shipped`
   - `GET /api/orders/available-to-ship`
3. El campo filtrado en `orders` es **`client`** (así se llama ahí; en las
   colecciones del WMS es `customer` — el guard acepta el nombre de campo por
   parámetro para la tarea 2.2).

**Contrato para Command:** `GET /api/orders?customer=SPEKTRUM&search=...` con
header `X-API-Key`. Sin `customer` → `403 {"detail": "Falta el parámetro
obligatorio customer..."}`. Cliente fuera del alcance de la llave → 403.

**Qué NO cubre esta tarea** (va en la 2.3): `GET /api/orders/{order_id}` (una
orden puntual), los endpoints del WMS y de producción. El guard ya está listo
para aplicarse ahí.

---

## Tarea 2.2 — Contexto obligatorio de cliente en Historial de Inventario

**Endpoint:** `GET /api/wms/inventory/history` (historial de movimientos por
SKU: style + color/talla opcionales). Misma política que la 2.1: la exigencia
aplica a **llaves de API**; los usuarios internos con sesión no cambian.

**Qué se hizo** (`backend/routers/wms.py`), con **tres candados** encadenados
para el consumidor externo:

1. **`customer` obligatorio** → HTTP 403 si falta, y 403 si el cliente está
   fuera del alcance de la llave (mismo guard `require_api_customer`, con
   `campo="customer"` — así se llama en las colecciones del WMS).
2. **Pertenencia del SKU**: el estilo consultado debe existir en cajas o
   inventario DE ese cliente. Si existe pero es de otro cliente → 403; si no
   existe en ningún lado → historial vacío (sin revelar si el estilo existe).
3. **Filtro de movimientos**: los movimientos traen formas heterogéneas y no
   todos llevan cliente en sus detalles — los que sí lo traen y es OTRO
   cliente, se descartan de la respuesta.

**Contrato para Command:**
`GET /api/wms/inventory/history?style=CORE&color=BLACK&customer=SPEKTRUM`
con header `X-API-Key`.

**Limitación honesta (anotada para la 2.3):** si dos clientes usaran el MISMO
nombre de estilo, los movimientos antiguos sin cliente en sus detalles no son
distinguibles al 100 %. El candado de pertenencia (paso 2) reduce el caso a
estilos con nombre duplicado entre clientes; hoy el catálogo curado del WMS
scopea styles por cliente, lo que hace ese choque improbable hacia adelante.

---

## Tarea 1.1 — Esquemas JSON tipados y estandarizados

**Qué se hizo:**

1. **`backend/contracts.py`** — la definición única de los contratos de la
   superficie externa, como modelos Pydantic: `PackingListInfo`,
   `PaginaOrdenesEmbarcables`, `PaginaOrdenesEmbarcadas`, `RegistroEnvio`,
   `EnvioProgramado` (+ submodelos). Reglas fijadas: **snake_case siempre**,
   sobre `{total, skip, limit, items}` para listas paginadas, fechas ISO 8601,
   errores `{"detail": ...}`.
2. **`docs/api-command/CONTRATOS.md`** — la lectura humana de esos contratos,
   campo por campo, con ejemplos y las notas de evolución (qué cambiará cuando
   lleguen 3.1 y 6.x). Es el documento que se le entrega a Command.

**Nota de adopción (regla 0.1):** los modelos se aplican como `response_model`
en los endpoints nuevos (la ruta de la 1.2 ya valida su salida). En los
endpoints vivos NO se activó la validación en runtime todavía: los datos
históricos traen tipos sucios (cantidades como texto, fechas heterogéneas) y
un `ValidationError` tumbaría respuestas que hoy funcionan. La activación va
endpoint por endpoint junto con las pruebas E2E del plan.

---

## Tarea 1.2 — Ruta única para Packing List

**Nueva ruta oficial: `GET /api/packing-list?order=<numero>`** (en
`backend/routers/packing.py`, router propio incluido en `server.py`). Command
no debe intentar ninguna otra ruta.

- Devuelve `PackingListInfo` **validado por contrato** (`response_model`):
  orden, cliente, `customer_po`, `qty_ordered`, y `packing_list {url, label,
  updated_at}` o `null` si aún no hay packing.
- **Misma resolución que el programador de envíos** (cero lógica nueva
  inventada): campo `packing_link` de la orden o el comentario
  `packing_link_seed` más fresco — el más nuevo gana; `source` dice cuál fue.
- Aislamiento heredado de la serie 2.x: con llave de API, `customer` es
  obligatorio y la orden debe pertenecer a ese cliente (403 si no).
- `qty_ordered` ya sale aquí (adelanto de la 4.1).

**Límite documentado:** hoy el packing list es un documento enlazado (Google
Sheets); esta ruta entrega su metadato. Si Command necesita el CONTENIDO
(renglones/cajas), es la siguiente iteración sobre esta misma ruta y requiere
decidir con qué credencial de Google lee el servidor.

---

## Tarea 3.1 — `ship_by` separado de `cancel_date`

**Qué se hizo:**

1. **`ship_by` como campo de primera clase de la orden** (`deps.py`:
   `OrderCreate` y `OrderUpdate`): fecha límite de ENVÍO, formato `YYYY-MM-DD`,
   independiente de `cancel_date` (que vuelve a significar solo la fecha de
   cancelación del cliente). Entra por los mismos endpoints de crear/editar
   orden que cualquier otro campo.
2. **Semántica de despliegue sin ruptura (fallback):** todos los cálculos de
   envío usan `ship_by` **cuando existe** y caen a `cancel_date` mientras no.
   Con las órdenes actuales (todas sin `ship_by`) el comportamiento es
   idéntico al de hoy; en cuanto se capture en una orden, `ship_by` gana en
   esa orden. No hay backfill: no se inventa una fecha que nadie capturó.
3. **Cableado donde se consumía la ambigüedad:**
   - `scheduled_shipments.py`: "Days Com." ahora se calcula contra
     `ship_by || cancel_date`, y la fila expone **ambas fechas por separado**.
   - `GET /api/orders/available-to-ship`: expone `ship_by` en cada item.
   - Contratos (`contracts.py` + `CONTRATOS.md`) actualizados: `ship_by` en
     `OrdenEmbarcable` y `EnvioProgramado`, con la semántica de `days_com`
     documentada para que Command no adivine qué fecha se usó.

**Captura en UI:** los modelos de orden aceptan `ship_by` desde ya (los forms
dinámicos pueden mandarlo). Agregar la columna/campo visible en el modal de
edición y en el programador de envíos es iteración de UI aparte — el dato y su
semántica ya están definidos y publicados en el contrato.

---

## Tareas 3.2, 3.3 y 3.4 — Timestamps del envío (`dispatched_at`, `packed_at`, `delivered_at`)

**Qué se hizo** (`backend/routers/shipping.py`):

1. **Tres hitos estructurados** en el registro de envío, todos **ISO 8601 con
   zona horaria obligatoria** (sin zona → 400 con mensaje claro) y
   **normalizados a UTC** al guardar.
2. **Semántica por campo** (no se inventan datos):
   - `dispatched_at` — registrar el envío ES el despacho: el `POST` lo sella
     con el momento actual salvo valor explícito. *(Tarea 3.2)*
   - `packed_at` — opcional en el `POST`; null hasta que se capture. *(3.3)*
   - `delivered_at` — la entrega ocurre días después: se captura con el nuevo
     **`PUT /api/shipping/{shipping_id}`** (acepta cualquiera de los tres
     campos, solo toca los que vienen, queda auditado en el log). *(3.3)*
3. **Contratos y documentación** *(3.4)*: `RegistroEnvio` actualizado en
   `contracts.py` y la sección 4 de `CONTRATOS.md` reescrita con la tabla de
   reglas — incluida la de registros históricos (traen null; usar `created_at`
   como aproximación del despacho, no se backfillea historia).

**Sin ruptura:** el `POST` actual del frontend (ShippingModule) sigue
funcionando sin cambios — simplemente sus registros nuevos nacen con
`dispatched_at` sellado. La captura de `packed_at`/`delivered_at` desde la UI
es iteración aparte; el dato y el contrato ya existen.

---

## Tarea 4.1 — `qty_ordered` vs `qty_shipped` en la superficie de embarque

**Decisión central: `qty_shipped` NO es un campo nuevo — se DERIVA al leer.**
La lección del sistema ("la caja manda") es que un contador paralelo se
desincroniza en silencio; aquí la fuente es la bitácora del WMS. La derivación
vive en un solo lugar, `backend/services/qty_embarcada.py`, y suma dos fuentes
sin doble conteo:

1. **`wms_movements` tipo `pick_deduction`** — cada descuento de pick registra
   `details.order_number` + `details.qty` (unidades que salieron del
   inventario hacia esa orden, cajas + saldo sin caja). Se verificó que no
   existe movimiento inverso de un pick: el neto es la suma directa.
2. **`wms_shipments.total_units`** — el embarque directo
   (`POST /api/wms/movements`) descuenta ahí mismo el inventario de las cajas
   que NO pasaron por pick. Las cajas ya pickeadas llegan al embarque en 0
   unidades, así que no aportan doble.

Detalles defensivos (datos históricos sucios): las sumas usan
`$convert(onError=0)`; los números de orden se buscan como string **y** como
int; `wms_shipments.order_id` a veces guarda el `order_number` y a veces el
`order_id` interno (el propio endpoint actualiza la orden con `$or` de ambos),
así que se casan los dos. El servicio crea perezosamente los índices
`wms_movements(type, details.order_number)` y `wms_shipments(order_id)` —
sin ellos cada lectura barrería la bitácora completa.

**Dónde viaja el par** (todo aditivo; `quantity` crudo se conserva donde ya
existía para no mover a los consumidores actuales):

| Endpoint | Qué se agregó |
|---|---|
| `GET /api/packing-list` | `qty_shipped` (ya traía `qty_ordered` desde la 1.2) |
| `GET /api/orders/available-to-ship` | `qty_ordered` (lectura numérica de `quantity`) + `qty_shipped` por item |
| `GET /api/orders/shipped` | ídem |
| `GET /api/shipping` y respuesta del `PUT` | `orders_detail[] {order_number, qty_ordered, qty_shipped}` — espejo de `order_numbers`; número sin orden viva → `qty_ordered: null` (adelanto honesto de la 6.1, sin rechazar nada todavía) |
| `GET /api/scheduled-shipments` (+ respuestas de POST/PUT) | `qty_ordered` + `qty_shipped` por fila |

Contratos actualizados en `contracts.py` (`DetalleOrdenEnvio` nuevo; el par en
`PackingListInfo`, `OrdenEmbarcable`, `OrdenEmbarcada`, `RegistroEnvio`,
`EnvioProgramado`) y `CONTRATOS.md` (sección general "Cantidades" + cada
endpoint).

**Límites honestos:** `qty_shipped` refleja lo que el WMS registró — salidas de
la era Excel (anteriores al WMS) no están en la bitácora y no se inventan.
`GET /api/shipping` sigue sin guard multi-tenant (eso es la 2.3 restante; el
enriquecimiento no revela órdenes que el endpoint no mostrara ya).

---

## Tareas 5.1-5.3 — Paginación estandarizada bajo demanda

**La restricción que definió el diseño:** los tres endpoints que regresaban
lista completa tienen consumidores vivos (frontend interno y Command) que
esperan la forma actual — cambiarla a secas violaría la regla 0.1. La
paginación entra entonces **por opt-in**: mandar **`skip`** (aunque sea `0`)
activa el sobre estándar `{total, skip, limit, items}`; sin `skip`, la
respuesta es byte a byte la de siempre. `limit` funciona en ambos modos (sin
sobre, solo recorta la lista plana).

| Tarea | Endpoint | Sin `skip` (intacto) | Con `skip` |
|---|---|---|---|
| 5.1 | `GET /api/orders` | Lista plana, `limit` default 1000, caché global | Sobre; `limit` tope 5000; **sin caché global** (mismo criterio que las búsquedas: cada página es consulta directa). En búsquedas, `total` = lo que sobrevivió al filtro en Python (el ranking se hace en memoria y un count de Mongo mentiría). |
| 5.2 | `GET /api/shipping` | Lista plana, tope histórico 100 | Sobre `PaginaRegistrosEnvio`; permite recorrer TODO el histórico (antes el tope 100 era un muro); cada página sale enriquecida con `orders_detail` (4.1) |
| 5.3 | `GET /api/scheduled-shipments` | `{items, weeks}` completo | `{total, skip, limit, items, weeks}` (`PaginaEnviosProgramados`); la paginación corta ANTES del join, así que una página chica también paga menos joins |

**Ya paginados, quedan como están** (regla del plan): `available-to-ship` y
`shipped` ya usaban el sobre desde antes.

**Fuera a propósito:** `GET /api/wms/inventory/history` — es una vista acotada
de movimientos recientes con filtro posterior en Python; un `total` ahí sería
mentiroso. Documentado en CONTRATOS.md; si Command necesita recorrer historia
completa de movimientos, es conversación aparte.

Contratos: `PaginaRegistrosEnvio` y `PaginaEnviosProgramados` nuevos en
`contracts.py`; CONTRATOS.md ganó la sección "Paginación bajo demanda" con la
recomendación para Command: mandar **siempre** `skip` y `limit`.

---

## Tareas 6.1-6.3 — Shipping estructurado: validación de órdenes + `delay_code`

**Tarea 6.1 — `order_numbers` validado contra órdenes reales.** El plan daba
dos opciones (rechazar o avisar); se implementaron las dos, escalonadas para
no romper a nadie (regla 0.1):

- **Default (aviso):** el `POST /api/shipping` valida cada número contra las
  órdenes vivas (fuera de papelera), guarda igual y devuelve
  `unknown_orders[]` — que también queda como **foto** en el registro (lo que
  no era orden viva AL registrar; no se recalcula sobre historia). El
  frontend actual no cambia en nada.
- **`strict=true` (muro):** rechaza con 400 si algún número no es orden viva
  o si no viene ninguno. **Command debe mandarlo siempre** (documentado en
  CONTRATOS.md); cuando confirme que lo manda, subir el default para llaves
  de API es un cambio de una línea.

La 4.1 ya hacía visible el problema en la lectura (`orders_detail` con
`qty_ordered: null`); la 6.1 lo ataca en la escritura.

**Tareas 6.2-6.3 — `delay_code` de catálogo cerrado.** Causa de retraso del
envío, sin texto libre:

- Catálogo CERRADO de 7 causas (`customer_request`, `production_delay`,
  `materials_shortage`, `carrier_issue`, `documentation`, `weather`,
  `other`) definido en `shipping.py` y enumerable en
  **`GET /api/shipping/delay-codes`** (para que UI y Command pinten opciones
  sin hardcodear). Fuera de catálogo → 400. `null` = sin retraso declarado
  (no se inventa).
- Entra por el `POST` (opcional) y se captura/corrige después por el
  `PUT /api/shipping/{shipping_id}` (`{"delay_code": ...}`; `null` lo
  limpia) — mismo canal auditado de los timestamps 3.2-3.4.
- **Regla del jefe respetada (no-TMS):** un código de causa por registro y el
  detalle libre en `notes`. Sin carriers, sin tracking por paquete, sin
  eventos de ruta. Agregar una causa = cambio aditivo del dict (contrato
  aditivo), no texto libre.

**Sin ruptura:** POST del frontend intacto (campos nuevos opcionales, aviso en
vez de muro por default); registros históricos sin `delay_code` ni
`unknown_orders` se leen como `null`/ausente (documentado). Contratos
actualizados en `contracts.py` (`RegistroEnvio` + `unknown_orders` +
`delay_code`) y CONTRATOS.md sección 4 reescrita (la nota "6.x pendientes"
quedó saldada).

**Captura en UI:** el selector de `delay_code` en ShippingModule es iteración
de UI aparte — el dato, el catálogo consultable y el contrato ya existen.

---

## Tarea 2.3.b — Auditoría multi-tenant: default-deny + guards por endpoint

Cierre de la 2.3 (la 2.3.a dejó las llaves por cliente). Dos capas:

### Capa 1 — Default-deny central (la decisión de arquitectura)

La auditoría reveló que enumerar endpoint por endpoint era una carrera
perdida: el WMS tiene ~150 rutas `require_auth` que una llave `external_api`
podía tocar (pick-progress, putaway, receiving, movimientos, recon…). En vez
de perseguirlas, se invirtió la carga:

- **`deps.API_SURFACE_PERMITIDA`** — la lista explícita de lo que una llave
  de API puede tocar (espejo de la tabla "Superficie permitida" de
  CONTRATOS.md).
- **Middleware `candado_superficie_api`** (`server.py`) — una petición con
  header `X-API-Key` fuera de esa lista recibe **403 antes de llegar al
  endpoint**. Para sesiones internas y el `INTERNAL_SYNC_TOKEN` (que no traen
  ese header) el middleware es un no-op literal: el frontend y el piso no
  cambian en absoluto.
- Los bypass legados por query param (`?api_key=` en `production.py`:
  production-summary/neck-summary/capacity-plan/production-analytics) NO
  pasan por el candado y quedan como estaban — se retiran junto con la
  `MASTER_API_KEY`, como quedó acordado en 2.3.a.
- Probado en frío: 34 casos método+ruta (permitidos y bloqueados) contra
  `deps.api_surface_permitida` — todos correctos.

### Capa 2 — Guard por cliente en cada endpoint permitido

Todo con el mismo `require_api_customer` (customer obligatorio por query
param, validado contra el alcance de la llave, filtro server-side):

| Endpoint | Qué se aplicó |
|---|---|
| `GET /api/orders/{order}` | Pertenencia de la orden puntual (el hueco que la 2.1 dejó anotado) → 403 |
| `GET /api/wms/pick-tickets` | Filtro `customer` en el query; tickets viejos sin campo NO salen (no se muestra lo que no se puede probar de quién es); pre-tickets virtuales (concepto de UI) no se sintetizan para llaves |
| `GET /api/wms/allocations` y `GET /api/wms/shipments` | Estas colecciones no traen cliente propio: se hereda resolviendo su orden (`_solo_ordenes_del_cliente`); lo no resoluble NO sale |
| `GET /api/shipping` | El registro hereda el cliente de sus órdenes: visible solo si TODAS las resolubles son del cliente y ≥1 resuelve; mixtos/irresolubles ocultos; paginación corta después del filtro |
| `POST /api/shipping` | `strict` (6.1) **forzado** + todas las órdenes deben ser del cliente (403 con la lista de ajenas) |
| `PUT /api/shipping/{id}` | Visibilidad del registro verificada ANTES de escribir |
| `GET/POST/PUT/DELETE /api/scheduled-shipments` | Filtro por la orden unida; en escrituras se verifica pertenencia antes de tocar nada; `weeks` (calendario, sin datos de cliente) viaja completo |

### Lo que queda de la 2.3 (fuera del código, esperando a Command)

1. **Retirar `MASTER_API_KEY`** del entorno cuando Command confirme que usa
   su llave por cliente (+ relajar `deps._llave_obligatoria`, una línea).
2. **Retirar los bypass `?api_key=`** de `production.py` en ese mismo momento.

**Riesgo asumido** (mismo criterio que 2.3.a): si Command hoy llamara algo
fuera de la superficie documentada (p.ej. `POST /api/packing/export` o un
endpoint del WMS), recibirá 403 visible y reversible — la lista permitida se
amplía con un cambio aditivo si resulta necesario.

---

## Tareas 7.1-7.3 — Documentación final de la API

**7.1 — OpenAPI.** FastAPI ya genera `/docs` (Swagger) y `/openapi.json`; lo
que faltaba era identidad: el app ahora declara título, versión y una
descripción que remite al contrato real (CONTRATOS.md + `contracts.py`) y
aclara que el resto de rutas es uso interno.

> ✅ **Hallazgo resuelto (decisión de Miguel, 2026-08-31):** `/docs` y
> `/openapi.json` eran públicos y enumeraban todas las rutas internas.
> Quedaron **restringidos a sesión interna de MOS**: sin sesión → 401; con
> llave de API → 403 del middleware (no están en la superficie permitida);
> para un usuario logueado en MOS, `/docs` se ve igual que siempre (la
> cookie viaja sola). `/redoc` se desmontó (nadie lo usaba). La batería A
> del E2E verifica los tres casos.

**7.2 — CONTRATOS.md consolidado.** El documento quedó como el contrato único
y navegable: **Guía rápida para Command** (6 reglas + ejemplo curl), reglas
generales, tabla de **Superficie permitida** (2.3), secciones transversales
(cantidades 4.1, paginación 5.x) y la referencia endpoint por endpoint. Cada
tarea del plan lo fue actualizando en su momento — esta pasada agregó la guía
y la costura, no reescribió contratos.

**7.3 — Política de cambios.** Sección formal al final de CONTRATOS.md:

- **Aditivo = libre** (campos, endpoints, valores de catálogo, modos opt-in);
  la contraparte es que Command ignora lo que no conoce.
- **Ruptura = aviso + 30 días naturales de gracia** (renombrar/quitar,
  cambiar tipo o semántica, endurecer defaults, retirar compatibilidades);
  única excepción: hueco de seguridad activo, que se corrige de inmediato
  con aviso directo.
- **Compromisos de estabilidad** explícitos (snake_case, sobre de
  paginación, formato de error, ISO 8601).
- **Rupturas ya anunciadas** con su disparador: retiro de `MASTER_API_KEY`,
  `strict` obligatorio global, y validación runtime con las E2E.

Con esto el plan queda completo salvo: **Pruebas E2E** (última fila de la
tabla) y las **cirugías mayores 4.2 / 4.3 / 5.4**, que esperan aprobación
explícita.

---

## Pruebas — E2E de la superficie externa + regresión

**El script: `backend/tests/e2e_command_api.py`** — simula a Command contra
un backend real (default: producción). Regla de oro: **no persiste nada** —
las pruebas de escritura usan solo caminos que el backend debe rechazar
(strict forzado con orden inexistente → 400, `delay_code` fuera de catálogo
→ 400, registros inexistentes → 404). El POST feliz queda para la
integración real de Command.

### Batería A — compuertas y default-deny (sin llave real) ✅

Corrida contra **producción** el 2026-08-31: **28/28 OK.**

- Sin llave: 401 en toda la superficie (packing-list, shipping, delay-codes,
  scheduled, orders).
- Con llave FALSA (el middleware dispara con la sola presencia del header,
  por eso una llave falsa basta para probarlo): 14 rutas fuera de la
  superficie documentada respondieron **403 "superficie documentada"** antes
  de llegar al endpoint (WMS boxes/movements/inventory/audit, producción,
  packing/export, comments de órdenes, POST/DELETE de órdenes,
  week-config...), y las 8 rutas permitidas respondieron **401** (el
  middleware las deja pasar y la llave falsa muere en la autenticación —
  nunca un 403 de superficie).
- Confirmado también el hallazgo 7.1: `GET /docs` responde 200 sin sesión
  (decisión pendiente de Miguel).

### Batería B — superficie completa con llave real (lista, espera llave)

Cubre: `customer` obligatorio y fuera-de-alcance (403), sobres de
paginación, aislamiento por cliente en orders/scheduled/pick-tickets,
contrato de packing-list, par `qty_ordered`/`qty_shipped`, `orders_detail`,
catálogo de 7 `delay_codes`, y los rechazos de escritura. Para correrla,
emitir una llave de PRUEBA (supersu, ver 2.3.a) y:

```powershell
$env:MOS_API_KEY = '<llave de prueba>'
$env:MOS_API_CUSTOMER = '<cliente de la llave>'
backend\venv\Scripts\python.exe backend\tests\e2e_command_api.py
```

Revocar la llave de prueba al terminar (`DELETE /api/auth/api-keys/{id}`).

### Regresión de lo interno

- **El frontend no se tocó en todo el plan** (cero commits en `frontend/`):
  no hay regresión que correr ahí; todos los campos nuevos son aditivos y
  los sobres de paginación son opt-in (el frontend no manda `skip`).
- **El piso (PDA)**: ninguna de sus rutas (0.1.e) fue modificada; el
  middleware es un no-op literal para sesiones (solo mira el header
  `X-API-Key`, que el PDA no manda).
- Los 401 de la batería A confirman que las compuertas de sesión internas
  siguen exactamente como antes.
