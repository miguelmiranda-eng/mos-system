/* Ilustraciones del WMS — línea monotrazo, objetos de almacén.

   POR QUÉ ASÍ Y NO PLANAS A COLOR: una ilustración plana de varios colores
   pelearía con la paleta de Prosper y con la densidad de datos de los módulos.
   Estas son de trazo, y el trazo toma el color del tema vía `currentColor`: la
   estructura sale de `text-muted-foreground` y los remates —código de barras,
   palomitas, haz del escáner— del acento azul. Encajan en cualquier piel.

   ⚠️ NADA DE COMPONENTES DENTRO DEL <svg>. Esto se ve feo pero es obligatorio:
   el plugin de edición visual (plugins/visual-edits/babel-metadata-plugin.js)
   envuelve cada USO DE COMPONENTE en <span style="display:contents"> para
   poder ubicarlo en el código. Un <span> dentro de un <svg> no es un elemento
   de dibujo: el navegador reserva la caja del <svg> y NO pinta la geometría,
   sin lanzar un solo error. Se diagnostica con getBBox() → 0×0.
   La primera versión tenía <Frame>, <Base> y <Accent> y desaparecía en
   silencio. Los elementos intrínsecos (<g>, <path>, <circle>) el plugin sólo
   los marca con atributos, no los envuelve — por eso aquí va todo aplanado.

   El lienzo es 220×150 en todas, para intercambiarlas sin que salte el layout.
   La estructura va a opacidad PLENA: al 55% componía a #6B717A sobre el fondo
   del tema (3.33:1) y no se leía. */

export const ArtScan = ({ className }) => (
  <svg
    viewBox="0 0 220 150"
    className={className}
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    role="presentation"
    aria-hidden="true"
  >
    <g stroke="currentColor" strokeWidth="2.4" className="text-muted-foreground">
      <circle cx="45" cy="36" r="9" />
      <path d="M35.5,37 C33,23 57,21 54,33" />
      <path d="M36,33 C27,40 28,54 34,60" />
      <path d="M37,47 L53,47 L56,81 L38,81 Z" />
      <path d="M53,53 L67,50 L79,57" />
      <path d="M41,81 L36,109" />
      <path d="M51,81 L57,107" />
      <path d="M36,109 L27,111" />
      <path d="M57,107 L66,109" />
      <rect x="79" y="50" width="20" height="12" rx="3" />
      <path d="M85,62 L83,71 L92,71 L90,62" />
      <path d="M132,46 L146,34 L200,34 L186,46 Z" />
      <path d="M132,46 L186,46 L186,104 L132,104 Z" />
      <path d="M186,46 L200,34 L200,92 L186,104 Z" />
      <path d="M155,46 L169,34" />
      <path d="M163,46 L177,34" />
    </g>
    <g stroke="currentColor" strokeWidth="1.7" className="text-primary">
      <path d="M101,54 L129,45" />
      <path d="M101,59 L129,68" />
      <path d="M112,50 Q116,56 112,62" />
      <path d="M121,47 Q126,56 121,66" />
    </g>
    <g stroke="currentColor" strokeWidth="2.4" className="text-primary">
      <path d="M143,63 L143,88 M148,63 L148,88 M152,63 L152,88 M158,63 L158,88 M162,63 L162,88 M168,63 L168,88 M173,63 L173,88 M178,63 L178,88" />
    </g>
  </svg>
);

export const ArtBoxes = ({ className }) => (
  <svg
    viewBox="0 0 220 150"
    className={className}
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    role="presentation"
    aria-hidden="true"
  >
    <g stroke="currentColor" strokeWidth="2.4" className="text-muted-foreground">
      <path d="M62,58 L80,44 L146,44 L128,58 Z" />
      <path d="M62,58 L128,58 L128,116 L62,116 Z" />
      <path d="M128,58 L146,44 L146,102 L128,116 Z" />
      <path d="M88,58 L106,44" />
      <path d="M97,58 L115,44" />
      <path d="M146,86 L157,78 L196,78 L185,86 Z" />
      <path d="M146,86 L185,86 L185,116 L146,116 Z" />
      <path d="M185,86 L196,78 L196,108 L185,116 Z" />
      <path d="M40,128 L200,128" />
    </g>
    <g stroke="currentColor" strokeWidth="2.4" className="text-primary">
      <path d="M82,74 L82,96 M87,74 L87,96 M91,74 L91,96 M97,74 L97,96 M101,74 L101,96 M107,74 L107,96" />
      <path d="M160,96 L160,108 M164,96 L164,108 M168,96 L168,108 M173,96 L173,108" />
    </g>
  </svg>
);

export const ArtRack = ({ className }) => (
  <svg
    viewBox="0 0 220 150"
    className={className}
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    role="presentation"
    aria-hidden="true"
  >
    <g stroke="currentColor" strokeWidth="2.4" className="text-muted-foreground">
      <path d="M46,26 L46,128 M174,26 L174,128" />
      <path d="M46,26 L174,26 M46,64 L174,64 M46,102 L174,102 M46,128 L174,128" />
      <path d="M62,34 L62,64 L92,64 L92,34 Z" />
      <path d="M104,40 L104,64 L128,64 L128,40 Z" />
      <path d="M62,74 L62,102 L88,102 L88,74 Z" />
      <path d="M132,78 L132,102 L160,102 L160,78 Z" />
      <path d="M36,128 L184,128" />
    </g>
    <g stroke="currentColor" strokeWidth="2.4" className="text-primary">
      <path d="M104,74 L104,102 L128,102 L128,74 Z" />
      <path d="M110,82 L110,94 M114,82 L114,94 M118,82 L118,94 M123,82 L123,94" />
    </g>
  </svg>
);

export const ArtClipboard = ({ className }) => (
  <svg
    viewBox="0 0 220 150"
    className={className}
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    role="presentation"
    aria-hidden="true"
  >
    <g stroke="currentColor" strokeWidth="2.4" className="text-muted-foreground">
      <rect x="52" y="26" width="86" height="106" rx="7" />
      <rect x="78" y="18" width="34" height="17" rx="5" />
      <path d="M84,86 L124,86 M84,102 L118,102" />
      <path d="M140,72 L154,62 L196,62 L182,72 Z" />
      <path d="M140,72 L182,72 L182,116 L140,116 Z" />
      <path d="M182,72 L196,62 L196,106 L182,116 Z" />
    </g>
    <g stroke="currentColor" strokeWidth="2.4" className="text-primary">
      <path d="M66,58 L72,64 L82,52" />
      <path d="M66,86 L72,92 L82,80" />
      <path d="M84,58 L124,58" />
      <path d="M154,86 L154,102 M159,86 L159,102 M163,86 L163,102 M168,86 L168,102" />
    </g>
  </svg>
);

export const ArtDone = ({ className }) => (
  <svg
    viewBox="0 0 220 150"
    className={className}
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    role="presentation"
    aria-hidden="true"
  >
    <g stroke="currentColor" strokeWidth="2.4" className="text-muted-foreground">
      <path d="M58,60 L76,44 L148,44 L130,60 Z" />
      <path d="M58,60 L130,60 L130,122 L58,122 Z" />
      <path d="M130,60 L148,44 L148,106 L130,122 Z" />
      <path d="M86,60 L104,44" />
      <path d="M95,60 L113,44" />
      <path d="M40,132 L188,132" />
    </g>
    <g stroke="currentColor" strokeWidth="2.4" className="text-primary">
      <circle cx="160" cy="96" r="24" />
      <path d="M149,96 L157,104 L172,87" />
    </g>
  </svg>
);

export const WMS_ART = {
  scan: ArtScan,
  boxes: ArtBoxes,
  rack: ArtRack,
  clipboard: ArtClipboard,
  done: ArtDone,
};

/* Selector por nombre: `<WmsArt name="rack" />`. Un nombre desconocido cae en
   cajas en vez de romper la pantalla. */
export const WmsArt = ({ name = "boxes", className = "" }) => {
  const Art = WMS_ART[name] || WMS_ART.boxes;
  return <Art className={className} />;
};

export default WmsArt;
