# Respuestas al plan de tareas — API MOS ↔ Command

Documento vivo: cada tarea del plan se responde aquí con lo que se hizo, lo que
se encontró y las decisiones tomadas. Se actualiza tarea por tarea.

## Estado

| Tarea | Descripción corta | Estado |
|---|---|---|
| 0.1 | Auditoría técnica previa | ✅ Completa |
| 1.1 | Esquemas JSON tipados | ⬜ Pendiente |
| 1.2 | Ruta única de Packing List | ⬜ Pendiente |
| 2.1 | `customer` obligatorio en búsqueda de órdenes | ⬜ Pendiente |
| 2.2 | Contexto de cliente en historial de inventario | ⬜ Pendiente |
| 2.3 | Auditoría multi-tenant global | ⬜ Pendiente |
| 3.1 | `ship_by` separado de `cancel_date` | ⬜ Pendiente |
| 3.2 | `dispatched_at` ISO 8601 | ⬜ Pendiente |
| 3.3/3.4 | `packed_at`, `delivered_at` + doc | ⬜ Pendiente |
| 4.1 | `qty_ordered` vs `qty_shipped` | ⬜ Pendiente |
| 4.2 | Pulls → Hold/Allocation | ⬜ Pendiente |
| 4.3 | Múltiples pick tickets por orden | ⬜ Pendiente |
| 5.1-5.3 | Paginación estandarizada | ⬜ Pendiente |
| 5.4 | Enum de estados de orden | ⬜ Pendiente |
| 6.1-6.3 | Shipping estructurado + `delay_code` | ⬜ Pendiente |
| 7.1-7.3 | Documentación de API | ⬜ Pendiente |
| Pruebas | E2E con Command + regresión | ⬜ Pendiente |

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
> ⚠️ **Hallazgo agravante:** la validación de la llave vive dentro de
> `get_current_user()`, del que cuelgan TODOS los guards (`require_auth`,
> `require_admin_level`, **incluso `require_supersu`**, porque
> `SUPER_ROLES = {"admin","supersu"}` en `deps.py:526` y la llave devuelve rol
> `admin`). Es decir: **la MASTER_API_KEY alcanza el 100 % de los endpoints del
> sistema, incluidos los de solo-supersu** (conciliación, borrado, accesos).
> No es una llave de integración: es una llave maestra literal. Su reemplazo
> por llaves por cliente con alcance limitado debe ser lo primero del plan.

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
