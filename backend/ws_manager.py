"""WebSocket connection manager for real-time updates."""
from fastapi import WebSocket
from typing import List
import asyncio, logging, json

logger = logging.getLogger(__name__)

# Un solo cliente con el socket colgado (WiFi de almacen, PDA que se suspende,
# roaming entre APs) no debe congelar el broadcast para TODOS los demas: el
# backend corre en un solo hilo (event loop de asyncio), y un await sin timeout
# aqui bloqueaba CADA request del backend -- no solo websockets -- hasta que ese
# envio se resolviera. broadcast() se llama ~33 veces en el router de WMS
# (cada cierre de ubicacion del conteo, cada recibo, cada pick...).
SEND_TIMEOUT_SECONDS = 2.0


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WS connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"WS disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, event_type: str, data: dict = None):
        message = json.dumps({"type": event_type, "data": data or {}})
        # Snapshot: evita pelear con connect()/disconnect() mutando la lista
        # real mientras el envio esta en vuelo.
        connections = list(self.active_connections)
        if not connections:
            return

        async def _send(connection):
            try:
                await asyncio.wait_for(connection.send_text(message), timeout=SEND_TIMEOUT_SECONDS)
                return None
            except Exception:
                return connection  # murio o se colgo -> se desconecta abajo

        # EN PARALELO, no secuencial: una conexion lenta ya no retrasa a las
        # demas, y el timeout acota el peor caso a SEND_TIMEOUT_SECONDS en vez
        # de indefinido.
        results = await asyncio.gather(*(_send(c) for c in connections))
        for conn in results:
            if conn is not None:
                self.disconnect(conn)


ws_manager = ConnectionManager()
