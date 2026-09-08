# Módulo de Automatizaciones (MOS)

Motor de reglas **When → If → Then** (inspirado en las recetas de Monday.com) que
reacciona a eventos de las órdenes, más una capa de **guardas** que bloquean
cambios y un **scheduler** para reglas por tiempo/SLA.

> Toda la UI de construcción vive en `frontend/src/components/AutomationCenter.js`
> (página completa, wizard de 3 pasos). El modal del Dashboard
> (`components/dashboard/AutomationsModal.js`) es una variante reducida que solo
> crea reglas de `status_change` — **no** hace guardas ni reglas de tiempo.

---

## 1. Dónde vive cada cosa

| Pieza | Archivo |
|---|---|
| Motor + evaluadores + endpoints CRUD | `routers/automations.py` |
| Scheduler de reglas por tiempo (SLA) | `routers/automation_scheduler.py` |
| Puntos de disparo (create/move/update/status) y guardas | `routers/orders.py` |
| Registro del scheduler | `server.py` (`start_automation_scheduler`) |
| UI (constructor completo) | `frontend/src/components/AutomationCenter.js` |
| Catálogo de badges como condición | `frontend/src/lib/constants.js` (`FLAG_CONDITION_FIELDS`) |
| Smokes | `tests/smoke_automations_{operators,actions,guards,time}.py` |

### Colecciones de Mongo
- `automations` — las reglas.
- `automation_fires` — claim de idempotencia de las reglas de tiempo (`_id = "{automation_id}:{order_id}"`).
- `automation_scheduler` — config del motor SLA (`config_id: "automation_sla"`).
- `activity_logs` — historial (`action: "automation_triggered"`).
- Colaterales que escriben las acciones: `orders`, `comments`.

---

## 2. Modelo de una regla (`db.automations`)

```jsonc
{
  "automation_id": "auto_xxx",
  "name": "…",
  "is_active": true,
  "boards": ["MAQUINA1", …],        // scope; vacío = todos los tableros
  "trigger_type": "create | move | update | status_change | guard | time",
  "trigger_conditions": { … },      // ver §4
  "action_type": "…",               // ver §5 (para guard: "require")
  "action_params": { … }
}
```

El evaluador compara contra **cualquier campo** de la orden (`order.get(field)`),
así que los flags de los badges se usan como condición con solo exponerlos.

---

## 3. Tipos de regla y cuándo disparan

| `trigger_type` | Evento | Punto de evaluación |
|---|---|---|
| `create` | Se crea una orden | `internal_create_order` |
| `move` | Cambia de tablero | `update_order` / `move_order` / `bulk_move` |
| `update` | Cambia un campo (no board) | `update_order` |
| `status_change` | Cambia un campo de estado | `update_order` |
| **`guard`** | *Intento* de cambiar status o mover — **BLOQUEA antes de aplicar** | `update_order`, `move_order`, `bulk_move` |
| **`time`** | El paso del tiempo (SLA) | Scheduler (`automation_scheduler.py`) |

Los 4 primeros son *fire-and-forget*: la acción corre **después** del cambio
(`run_automations`). Las **guardas** corren **antes** y pueden rechazar
(`check_guards` → `HTTP 422`). Las de **tiempo** las barre el scheduler.

---

## 4. Condiciones (`trigger_conditions`)

### 4.1 Filtro plano (igualdad)
Cualquier clave `{campo: valor}` es un filtro AND por igualdad. Ej:
`{"sample_printavo": "SI", "priority": "RUSH"}`.
⚠️ En el motor normal, un campo **ausente** pasa el filtro (no lo descarta). En
guardas y tiempo el filtro es **estricto** (ausente = no casa).

### 4.2 Campo observado (solo update/status_change)
`watch_field` + `watch_value`. Valores especiales: `date_updated` (cambió),
`is_empty`, `not_empty`. La regla solo dispara si `watch_field` estuvo entre los
campos que cambiaron en ese request.

### 4.3 Condiciones avanzadas (operadores) — `advanced`
Lista `[{field, op, value}]` (AND). Operadores (`_compare`):

| op | Significado |
|---|---|
| `eq` / `ne` | igual / distinto |
| `gt` `gte` `lt` `lte` | comparación numérica |
| `contains` | subcadena (case-insensitive) |
| `in` | en una lista separada por comas |
| `is_set` / `not_set` | tiene valor / está vacío |

Aquí un campo ausente con `eq` **NO** casa (estricto).

### 4.4 Badges como condición
`FLAG_CONDITION_FIELDS`: `sample_printavo` (SI/NO), `art_neck_status`,
`art_sep_status`, `screens`, `is_preorder` (true/false), `twin_order_number`,
`packing_link` (vacío/lleno).

---

## 5. Acciones (`action_type` / `action_params`)

| `action_type` | `action_params` | Efecto |
|---|---|---|
| `move_board` | `{target_board}` | Mueve la orden (registra el salto). |
| `assign_field` / `change_status` | `{field, value}` | Escribe un campo (sella `production_status_at` si aplica). |
| `add_comment` | `{content}` | Comenta la orden (`db.comments`). Plantilla `{order_number}`. |
| `set_date` | `{field, mode:"today"\|"offset", days}` | Fija una fecha = hoy / hoy+N. |
| `notify_push` | `{title, message}` | Web-push (mismo canal del WMS). |
| `send_email` | `{to_email, subject, html_content}` | Correo (Resend). |
| `notify_slack` | `{webhook_url, message}` | Mensaje a Slack. |
| **`multi`** | `{actions: [{action_type, action_params}, …]}` | Varias acciones en orden (sin anidar). |

Plantillas: `{order_number}`, `{client}`, … con `_fmt` (tolerante a campos faltantes).

---

## 6. Guardas (validaciones que bloquean)

`trigger_type: "guard"`, `action_type: "require"`.

```jsonc
"trigger_conditions": {
  "on": "status_change | move",
  "to_status": "LISTO PARA ENVIO",   // opcional (status_change)
  "to_board": "COMPLETOS",           // opcional (move)
  "<flag>": "<valor>", "advanced": [ … ]   // condiciones (ESTRICTAS)
},
"action_params": {
  // requisito único…
  "requirement": "photo | field | flag | role",
  "field": "…", "value": "…", "roles": ["supersu", …],
  "message": "texto que ve el usuario al ser bloqueado",
  // …o múltiples (AND):
  "requirements": [ { "requirement": "photo", "message": "…" }, { "requirement": "field", "field": "final_bill" } ]
}
```

Requisitos: `photo` (≥1 imagen adjunta), `field` (campo lleno), `flag` (otro badge
en estado X), `role` (rol autorizado). Se evalúan sobre `{existing + update_data}`
(llenar el campo en el mismo request satisface). `bulk_move` mueve las permitidas
y reporta las bloqueadas en `guard_blocked`.

---

## 7. Reglas por tiempo / SLA

`trigger_type: "time"`. Las barre `automation_scheduler.py` cada N min.

```jsonc
"trigger_conditions": {
  "basis": "production_status_at | updated_at | created_at | cancel_date | due_date | final_bill | ship_by",
  "amount": 3, "unit": "days | hours",
  "direction": "before | after",     // solo para bases de fecha
  "<flag>": "…", "advanced": [ … ]   // condiciones (estrictas)
}
```
- Bases *elapsed* (status_at/updated/created): dispara cuando `ahora − marca ≥ umbral`.
- Bases de fecha: `before` = `ahora ≥ fecha − umbral` (se acerca); `after` = `ahora ≥ fecha + umbral` (vencida).

**Idempotencia**: cada `(regla, orden)` dispara **una vez** (claim en
`automation_fires`). No re-dispara si la orden re-entra a la condición.
`POST /api/automation-sla/run-now` con `{"reset_automation_id":"auto_…"}` limpia
los claims de una regla para re-probar.

El motor **arranca apagado**. Se prende con el banner de la UI o
`PUT /api/automation-sla {"enabled": true}`.

---

## 8. Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| GET/POST | `/api/automations` | Listar / crear reglas |
| PUT/DELETE | `/api/automations/{id}` | Editar / borrar |
| GET | `/api/automations/history?limit=N` | Historial de disparos |
| POST | `/api/automations/dry-run` | Probar una regla contra las órdenes actuales (no ejecuta) |
| GET/PUT | `/api/automation-sla` | Config del motor de tiempo (enabled, poll_minutes) |
| POST | `/api/automation-sla/run-now` | Correr una pasada YA (opcional `reset_automation_id`) |

---

## 9. Gobierno / UX

- **Dry-run**: botón "Probar" en el review del wizard → cuántas órdenes pegaría + muestra.
- **Historial**: botón "Historial" → modal con los disparos recientes.
- **Plantillas**: recetas de un clic (requiere foto / SLA 3 días / aviso inventario).

---

## 10. Cómo extender

- **Nueva acción**: agrega un `elif action_type == "…"` en `execute_action`
  (`automations.py`), su bloque de config en el Paso 2 de `AutomationCenter.js`, y
  su etiqueta en `ACTION_LABELS`. Añádela también a `_extra`/multi si aplica.
- **Nuevo operador**: agrégalo a `_compare` (backend) y a `ADV_OPS` (frontend).
- **Nuevo requisito de guarda**: `_requirement_met_one` (backend) + un bloque en el
  Paso 2 de guarda (frontend) + `REQUIREMENT_LABELS`.
- **Nueva base de tiempo**: `TIME_BASES` (frontend) y — si es fecha — `_DATE_BASES`
  (backend) + `TIME_DATE_BASES` (frontend).

---

## 11. Límites y decisiones de alcance

- **Anti-bucles**: no hay salvaguarda porque **no hay cascada** — las acciones
  escriben en la orden pero NO re-invocan el motor. Si algún día una acción
  re-dispara automatizaciones, habría que añadir un tope de profundidad.
- **Motor normal**: una condición plana sobre un campo **ausente** no filtra
  (comportamiento histórico). Usa `advanced` (estricto) o guardas para exigir el campo.
- **Dos UIs**: el modal del Dashboard sigue divergente (solo `status_change`). La
  consolidación quedó diferida.
- **SLA**: barre las órdenes por regla (paginado, sin columnas pesadas); pensado
  para cadencias lentas (~15 min), no para reglas de segundos.

---

## 12. Pruebas (smokes offline, sin Mongo)

```bash
backend/venv/Scripts/python.exe backend/tests/smoke_automations_operators.py   # 25
backend/venv/Scripts/python.exe backend/tests/smoke_automations_actions.py     # 12
backend/venv/Scripts/python.exe backend/tests/smoke_automations_guards.py      # 20
backend/venv/Scripts/python.exe backend/tests/smoke_automations_time.py        # 17
```
