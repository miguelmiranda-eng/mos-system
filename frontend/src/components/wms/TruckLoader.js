/* Animación de carga del WMS (2026-07, pedido del usuario): un camión de la
   empresa cruzando la pantalla — reemplaza a la barrita delgada de 2px que
   parpadeaba arriba al cambiar de módulo. El logo del cajón es el oficial
   (/prosper_logo.jpg, el mismo del login y del packing list). Los keyframes
   viven en index.css bajo el prefijo wms-truck-. */
export const TruckLoader = ({ label = "Cargando módulo…" }) => (
  <div className="wms-truck-wrap" data-testid="wms-truck-loader">
    <p className="wms-truck-label">{label}</p>
    <div className="wms-truck-scene">
      <div className="wms-truck-road" />
      <div className="wms-truck">
        <div className="wms-truck-box">
          <img src="/prosper_logo.jpg" alt="Prosper MFG" />
        </div>
        <div className="wms-truck-cab"><div className="wms-truck-win" /></div>
        <div className="wms-truck-wh wms-truck-w1" />
        <div className="wms-truck-wh wms-truck-w2" />
        <div className="wms-truck-wh wms-truck-w3" />
      </div>
    </div>
    <div className="wms-truck-bar"><span /></div>
  </div>
);
