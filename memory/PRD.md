# PRD - MOS SYSTEM (CRM + WMS de Gestion de Produccion)

## Problema Original
Migrar CRM desde Google Apps Script a FastAPI + React. Expandido con WMS completo y Modulo de Operador.

## Arquitectura
- **Backend**: FastAPI + MongoDB (motor) + Pydantic
- **Frontend**: React.js + Tailwind CSS + shadcn/ui
- **Auth**: Google OAuth + Email/Contrasena (bcrypt)
- **Roles**: admin, user, operator

## WMS - /wms (Admin)

### Pick Ticket Flow (actualizado)
1. Seleccionar PO/Orden -> auto-llena Customer y Quantity
2. Manufacturer -> dropdown filtrado por Customer (dedup case-insensitive)
3. Style -> dropdown filtrado por Customer + Manufacturer
4. Color -> dropdown filtrado por Customer + Style
5. Al seleccionar Color -> auto-lookup de ubicaciones por Style+Color
6. **Asignar Operador** -> dropdown con lista de operadores disponibles
7. Ingresar cantidades por size -> ver ubicaciones disponibles
8. Crear -> se guardan size_locations + assigned_to automaticamente
9. Imprimir -> etiqueta con barcode + grilla Size/Qty/Location

### Operator Module (NEW - Implemented 2026-03-18)
- Ruta: /operator (solo accesible por usuarios con role='operator')
- Vista simplificada: sidebar con tickets asignados + interfaz de picking
- Categorias: "En Progreso" y "Asignados"
- Cada ticket muestra: orden, cliente, manufacturer, style, color, sizes
- Operador ingresa cantidades recogidas por size
- Boton "Marcar completo" por size individual
- Guardar progreso parcial o completar surtido
- Barra de progreso visual por ticket
- Ubicaciones de inventario expandibles por size

## Key API Endpoints
- `GET /api/wms/generate-sku?style=X&color=Y&size=Z` - Previsualizar SKU auto-generado
- `POST /api/wms/cycle-counts` - Crear sesion de conteo ciclico
- `GET /api/wms/cycle-counts` - Listar conteos ciclicos
- `GET /api/wms/cycle-counts/{id}` - Detalle de conteo con lineas
- `PUT /api/wms/cycle-counts/{id}/count` - Guardar progreso de conteo
- `PUT /api/wms/cycle-counts/{id}/approve` - Aprobar conteo y ajustar inventario
- `GET /api/wms/inventory/options?customer=X&manufacturer=Y&style=Z`
- `GET /api/wms/inventory/locations-lookup?style=X&color=Y`
- `POST /api/wms/pick-tickets` - Crea ticket con auto-attach size_locations y assigned_to
- `PUT /api/wms/pick-tickets/{id}/assign` - Admin asigna ticket a operador
- `GET /api/wms/operators` - Lista usuarios con rol operador
- `GET /api/wms/operator/my-tickets` - Tickets pendientes del operador
- `GET /api/wms/operator/completed-tickets` - Tickets completados del operador
- `PUT /api/wms/pick-tickets/{id}/pick-progress` - Guardar progreso de picking
- `POST /api/wms/import/inventory` - Importar Excel
- `GET /api/wms/inventory/filters` - Filtros unicos para Inventory view

### 10 Modulos WMS
1. Receiving (campos alineados con inventario, SKU auto-generado, impresion etiquetas)
2. Putaway
3. Inventory (19K+ registros, filtros, import/export)
4. Orders (solo BLANKS + PARTIAL)
5. Picking (dropdowns cascading + locations + asignar operador + dashboard productividad)
6. Production (mover estados)
7. Finished Goods
8. Shipping
9. Movements (audit log)
10. Conteo Ciclico (crear sesiones de conteo, filtros, conteo por linea, aprobacion con ajuste de inventario)

## Roles de Usuario
- `admin`: Acceso completo (CRM + WMS + gestion de usuarios)
- `user`: Acceso al CRM con permisos por tablero
- `picker`: Acceso solo a vista de operador (/operator) para surtido de pedidos

## Gestion de Usuarios (InviteUsersModal)
- Invitar via Google o crear con email/contrasena
- Roles disponibles: Usuario, Admin, Picker
- Permisos por tablero (editar/ver/sin acceso)
- Editar perfil y cambiar contrasena
- `users`: { user_id, email, name, role: 'admin'|'user'|'picker', auth_type, password_hash }
- `wms_pick_tickets`: { ticket_id, order_number, customer, style, color, sizes, size_locations, assigned_to, assigned_to_name, picking_status: 'unassigned'|'assigned'|'in_progress'|'completed', picked_sizes, status }
- `wms_inventory`: { customer, style, color, size, inv_location, on_hand, allocated, available, ... }

## Test Credentials
- Admin (email): admin@test.com / admin123
- Operator: operador1@test.com / operador123
- Admin (Google): miguel.miranda@prosper-mfg.com

## Tareas Pendientes
- P1: Migracion a MongoDB Atlas
- P1: Espejo tablero MASTER
- P2: Alertas bajo stock
- P2: Activar integraciones Resend/Slack
- P3: Toggle idioma Landing
- P3: Refactorizacion WMS.js (monolito de +1700 lineas -> dividir en modulos separados)
- P3: Refactorizacion Dashboard.js (+1000 lineas -> componentizar FilterBar, SchedulingViews, MasterView)

## Historial de Cambios Recientes
- 2026-03-23: Interfaz completamente responsive para iPad y moviles. Header colapsable, barra de tablero apilable, filtros adaptivos, modales responsivos, landing page mobile-friendly
- 2026-03-23: Exportacion completa de ordenes (con comentarios e imagenes) + Importacion. Botones en modal de acciones en lote: Excel, Completo, Papelera, Importar
- 2026-03-23: Endpoints admin para exportar/importar imagenes entre deploys (file_uploads collection)
- 2026-03-20: Imagenes de comentarios migradas a MongoDB (coleccion file_uploads). Ya no se pierden entre deploys. 274 archivos migrados del disco a la BD.
- 2026-03-20: Filtro por tablero en MASTER mejorado: movido a primera posicion con color naranja distintivo, multi-seleccion de tableros
- 2026-03-20: Calendario Planner ultra-compacto: bloques de una línea (solo PO), clic abre modal con detalles configurables, ordenes sin scheduled_date en HOY, alerta visual scheduled > cancel, mover entre tableros desde modal
- 2026-03-20: Calendario "Ready To Scheduled" en SCHEDULING: vista calendario para ordenes del tablero READY TO SCHEDULED, mismo formato que Planner, mover entre tableros, ordenes sin fecha en Hoy
- 2026-03-19: Campo PO/Orden mejorado en Pick Ticket (SearchableSelect con valor manual)
- 2026-03-18: SKU auto-generado en Receiving (STYLE-COLOR-SIZE en mayusculas, campo read-only)
- 2026-03-18: Modulo de Inventario Ciclico (Cycle Count) implementado
- 2026-03-18: Notificaciones push en tiempo real para operadores via WebSocket
- 2026-03-18: Receiving: Description, Country, Fabric son dropdowns con busqueda/autocompletado + opcion agregar nuevos
- 2026-03-18: Componente reutilizable SearchableSelect.js creado
- 2026-03-18: Endpoint GET /api/wms/inventory/field-options para opciones unicas de inventario
- 2026-03-18: Receiving con dropdowns en cascada (Customer->Manufacturer->Style->Color)
- 2026-03-18: Orders CRM muestra columna Operador/Picking con badges y barra de progreso
- 2026-03-18: Picking tiene 3 tabs: Pendientes, Completadas (con filtro por operador), Dashboard (productividad)
- 2026-03-18: Edicion de pick tickets existentes (boton lapiz en tickets pendientes)
- 2026-03-18: Correccion error Movements (undefined.substring)
- 2026-03-18: Rediseno Receiving: sin PO, con Dozens/Pieces/Units/SKU/Lot/Size
- 2026-03-18: Eliminada barra de scanner en Picking
- 2026-03-18: Rol "Picker" agregado a gestion de usuarios
- 2026-03-18: Modulo de Operador implementado (backend + frontend)
