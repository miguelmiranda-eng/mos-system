# MOS System — API Reference

Base URL (local): `http://localhost:8000`  
Base URL (production): `https://mosdatabase-backend.k9pirj.easypanel.host`

All protected endpoints require a valid session token sent as:
- Cookie: `session_token=<token>`
- Header: `Authorization: Bearer <token>`

**Auth levels:**
- `public` — no token needed
- `auth` — any authenticated user
- `admin` — role must be `admin`

---

## Auth `/api/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/google` | public | Redirect to Google OAuth login |
| GET | `/api/auth/google/callback` | public | OAuth callback, sets session cookie |
| POST | `/api/auth/login` | public | Email + password login |
| POST | `/api/auth/logout` | auth | Destroy session |
| GET | `/api/auth/me` | auth | Get current user |
| POST | `/api/auth/create-user` | admin | Create user with email/password |
| POST | `/api/auth/forgot-password` | public | Send password reset email |
| POST | `/api/auth/reset-password` | public | Reset password with token |

### POST `/api/auth/login`
```json
{ "email": "user@example.com", "password": "secret" }
```
Returns user object + sets `session_token` cookie (7 days).

### POST `/api/auth/create-user` (admin)
```json
{
  "email": "operator@prosper-mfg.com",
  "password": "secret123",
  "name": "John Doe",
  "role": "user",
  "associated_customer": ""
}
```

---

## Invoices `/api/invoices`

One invoice = one order. They are the same entity.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/invoices` | auth | List invoices |
| GET | `/api/invoices/{invoice_id}` | auth | Get single invoice |
| GET | `/api/invoices/public/{invoice_id}` | public | Public view (no auth) |
| POST | `/api/invoices` | auth | Create invoice → auto-creates work order + MOS order |
| PUT | `/api/invoices/{invoice_id}` | auth | Update invoice |
| DELETE | `/api/invoices/{invoice_id}` | auth | Delete invoice |
| POST | `/api/invoices/{invoice_id}/approve` | public | Approve invoice (customer-facing) |
| POST | `/api/invoices/{invoice_id}/payment-intent` | auth | Create Stripe payment intent |

### GET `/api/invoices` — Query params
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by status: `draft`, `sent`, `paid`, `overdue`, `cancelled` |
| `type` | string | `quote` or `invoice` |
| `search` | string | Search by invoice_id, order_number, client, customer_po |

### POST `/api/invoices` — Body (InvoiceModel)
Creating an invoice automatically:
1. Assigns sequential ID (`M-01`, `M-02`, …)
2. Creates a linked Work Order (`WO-XXXXXXXX`)
3. Syncs a MOS production order to the `orders` collection

```json
{
  "type": "quote",
  "status": "draft",
  "client": "LOVE IN FAITH",
  "customer_po": "PO-123",
  "store_po": "",
  "design_num": "",
  "cancel_date": "2026-06-01",
  "sample": "EJEMPLO APROBADO",
  "style": "",
  "branding": "LIF Regular",
  "priority": "PRIORITY 2",
  "blank_status": "PENDIENTE",
  "production_status": "EN ESPERA",
  "artwork_status": "NEW",
  "color": "",
  "production_notes": "",
  "art_links": ["https://drive.google.com/..."],
  "dates": { "created": "2026-05-05", "due": "2026-05-12" },
  "terms": "Net 7",
  "amounts": { "subtotal": 1000, "tax": 0, "total": 1000 },
  "items": [
    {
      "description": "Screen Print — Front",
      "quantity": 100,
      "price": 10.00,
      "amount": 1000.00,
      "sizes": { "S": 20, "M": 40, "L": 30, "XL": 10 }
    }
  ],
  "billing_address": {},
  "shipping_address": {}
}
```

---

## Work Orders `/api/work-orders`

Work orders are the production side of an invoice. One invoice → one work order.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/work-orders` | auth | List work orders |
| GET | `/api/work-orders/{work_order_id}` | auth | Get single work order |
| POST | `/api/work-orders` | auth | Create work order manually |
| PUT | `/api/work-orders/{work_order_id}` | auth | Update work order |
| DELETE | `/api/work-orders/{work_order_id}` | auth | Delete work order |
| POST | `/api/work-orders/{work_order_id}/assign` | auth | Assign operator |

### GET `/api/work-orders` — Query params
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by production_status |
| `operator_id` | string | Filter by assigned_operator |
| `search` | string | Search work_order_id, source_invoice_id, production_notes |

### Production status values
`artwork_pending` → `artwork_approved` → `production` → `quality_check` → `completed`

### POST `/api/work-orders` — Body (WorkOrderModel)
```json
{
  "work_order_id": "WO-AUTO",
  "source_invoice_id": "M-01",
  "production_status": "artwork_pending",
  "art_links": ["https://..."],
  "production_notes": "Rush order",
  "packing_details": { "bags": "individual", "labels": "hanging", "boxes": "master" },
  "assigned_operator": "operator@prosper-mfg.com",
  "scheduled_date": "2026-05-10"
}
```

### POST `/api/work-orders/{id}/assign`
```json
{ "operator_id": "operator@prosper-mfg.com" }
```

---

## Orders (MOS Board) `/api/orders`

Production board orders — the operational view used in the MOS frontend.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orders` | auth | List orders (filterable by board) |
| GET | `/api/orders/{order_id}` | auth | Get single order |
| POST | `/api/orders` | auth | Create order |
| PUT | `/api/orders/{order_id}` | auth | Update order |
| DELETE | `/api/orders/{order_id}` | admin | Delete order |
| POST | `/api/orders/{order_id}/move` | auth | Move to a different board |
| POST | `/api/orders/{order_id}/duplicate` | auth | Duplicate order |
| GET | `/api/orders/{order_id}/comments` | auth | Get comments |
| POST | `/api/orders/{order_id}/comments` | auth | Add comment |
| PUT | `/api/orders/{order_id}/comments/{comment_id}` | auth | Edit comment |
| DELETE | `/api/orders/{order_id}/comments/{comment_id}` | auth | Delete comment |
| POST | `/api/orders/{order_id}/images` | auth | Upload image |
| DELETE | `/api/orders/{order_id}/images/{image_id}` | auth | Delete image |
| POST | `/api/orders/bulk-move` | auth | Move multiple orders |
| GET | `/api/orders/export/excel` | auth | Export to Excel |
| GET | `/api/orders/export/pdf` | auth | Export to PDF |

### GET `/api/orders` — Query params
| Param | Type | Description |
|-------|------|-------------|
| `board` | string | Board name (e.g. `MAQUINA1`, `SCHEDULING`, `MASTER`) |
| `search` | string | Free text search |

### Available boards
`MASTER`, `SCHEDULING`, `READY TO SCHEDULED`, `BLANKS`, `SCREENS`, `NECK`, `EJEMPLOS`, `COMPLETOS`, `EDI`, `MAQUINA1`–`MAQUINA14`, `FINAL BILL`, `CONTROL DE CALIDAD`

---

## Production Analytics `/api/production-analytics`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/production-analytics` | auth | Get production stats |

### Query params
| Param | Type | Description |
|-------|------|-------------|
| `preset` | string | `today`, `week`, `month` |
| `date_from` | string | ISO date `YYYY-MM-DD` |
| `date_to` | string | ISO date `YYYY-MM-DD` |

### Response fields
- `total_produced` — units produced in period
- `efficiency` — % efficiency
- `trend_data` — array of `{ label, produced }`
- `by_machine` — breakdown per machine
- `by_client` — breakdown per client

---

## Capacity Plan `/api/capacity-plan`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/capacity-plan` | auth | Machine load and queue status |

### Response
```json
{
  "machines": [
    {
      "machine": "MAQUINA1",
      "order_count": 3,
      "avg_daily_production": 450,
      "estimated_days": 2,
      "load_status": "green",
      "remaining_pieces": 900,
      "orders_in_progress": [...]
    }
  ],
  "total_completed": 1200,
  "in_production": 5,
  "total_pieces_system": 4500
}
```

**load_status values:** `idle` | `green` (0–65%) | `yellow` (66–85%) | `red` (86–100%+)

---

## Automations `/api/automations`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/automations` | auth | List all automations |
| POST | `/api/automations` | auth | Create automation |
| PUT | `/api/automations/{automation_id}` | auth | Update automation |
| DELETE | `/api/automations/{automation_id}` | auth | Delete automation |

### POST `/api/automations` — Body
```json
{
  "name": "Move to Production on Art Approval",
  "trigger_type": "status_change",
  "trigger_conditions": { "artwork_status": "SEPS DONE" },
  "action_type": "move_board",
  "action_params": { "board": "MAQUINA1" },
  "is_active": true,
  "boards": ["SCHEDULING"]
}
```

**trigger_type values:** `create`, `move`, `update`, `status_change`  
**action_type values:** `send_email`, `move_board`, `assign_field`, `notify_slack`

---

## Users `/api/users`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/users` | admin | List all users |
| PUT | `/api/users/{user_id}` | admin | Update user role/info |
| DELETE | `/api/users/{user_id}` | admin | Delete user |

---

## Config `/api/config`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/config/options` | auth | Get all dropdown options |
| PUT | `/api/config/options` | admin | Update a dropdown option list |
| GET | `/api/config/boards` | auth | Get active board list |
| PUT | `/api/config/boards` | admin | Update board list |

---

## WebSocket `/api/ws`

Real-time updates broadcast to all connected clients.

**Connection:** `ws://localhost:8000/api/ws`

### Event types received
| Event | Payload | Trigger |
|-------|---------|---------|
| `order_change` | `{ action, order_id }` | Any order CRUD |
| `invoice_change` | `{ action, invoice_id }` | Any invoice CRUD |
| `work_order_change` | `{ action, work_order_id }` | Any work order CRUD |

**action values:** `create`, `update`, `delete`, `move`, `approve`

---

## Error Responses

All errors follow the same shape:

```json
{ "detail": "Human-readable error message" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request / validation error |
| 401 | Not authenticated |
| 403 | Admin access required |
| 404 | Resource not found |
| 500 | Internal server error |
| 502 | Could not reach MOS backend (proxy error) |

---

## CEO Dashboard Proxy

The ceo-dashboard proxies all MOS requests through `/api/mos?endpoint=<path>`.

```
GET  /api/mos?endpoint=invoices&search=M-01
POST /api/mos?endpoint=invoices           (body forwarded)
PUT  /api/mos?endpoint=invoices/M-01      (body forwarded)
DEL  /api/mos?endpoint=invoices/M-01
DEL  /api/mos?endpoint=work-orders/WO-ABC123
```

The proxy handles auth automatically using `MOS_SERVICE_EMAIL` + `MOS_SERVICE_PASSWORD` from `.env.local`.
