import { useState, useEffect, useCallback } from 'react';
import { API } from '../lib/constants';
import { DEFAULT_SECTORS } from '../lib/boardSectors';

/**
 * Pertenencia de cada tablero a un sector del menú lateral.
 *
 * La lee cualquier usuario (el menú se dibuja con esto); guardarla es cosa de
 * supersu y lo vuelve a comprobar el backend. Si la petición falla se queda el
 * reparto por defecto: un menú desordenado es molesto, un menú vacío deja a la
 * gente sin poder entrar a sus tableros.
 */
export const useBoardSectors = () => {
  const [sectors, setSectors] = useState(DEFAULT_SECTORS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = await fetch(`${API}/config/board-sectors`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (!cancelado && data?.sectors && Object.keys(data.sectors).length > 0) {
            setSectors(data.sectors);
          }
        }
      } catch { /* silencioso: nos quedamos con DEFAULT_SECTORS */ }
      if (!cancelado) setIsLoaded(true);
    })();
    return () => { cancelado = true; };
  }, []);

  const saveSectors = useCallback(async (next) => {
    let previo;
    setSectors(prev => { previo = prev; return next; }); // optimista: el menú se reordena al instante
    try {
      const res = await fetch(`${API}/config/board-sectors`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sectors: next }),
      });
      if (!res.ok) {
        const detalle = await res.json().catch(() => ({}));
        throw new Error(detalle.detail || `Error ${res.status}`);
      }
      return { ok: true };
    } catch (err) {
      setSectors(previo); // no se guardó: no dejamos el menú mintiendo
      return { ok: false, error: err.message };
    }
  }, []);

  return { sectors, saveSectors, isLoaded };
};
