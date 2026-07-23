/* Animación de carga del WMS: tres gotas de agua botando (pedido del usuario
   2026-07-23, reemplaza al camión que reemplazó a la barrita de 2px).
   Los keyframes viven en index.css bajo el prefijo wms-drop-. */
export const DropsLoader = ({ label = "Cargando módulo…" }) => (
  <div className="wms-drops-wrap" data-testid="wms-drops-loader">
    <div className="wms-drops">
      <span className="wms-drop" />
      <span className="wms-drop" />
      <span className="wms-drop" />
    </div>
    <p className="wms-drops-label">{label}</p>
  </div>
);
