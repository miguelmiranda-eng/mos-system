/* Primitivas visuales del rediseño minimalista del WMS (2026-07).

   REGLA DEL REDISEÑO: la mecánica no se toca — estas piezas son SOLO
   presentación. Un módulo se "refactoriza" cambiando sus clases neón
   (font-black, MAYÚSCULAS, glows, chips saturados) por estas primitivas o sus
   recetas. Todo usa tokens de tema (bg-card, border-border, text-muted-…), así
   el modo oscuro sale gratis del mismo markup.

   Receta base:
   · Tipografía: normal-case; títulos font-bold tracking-tight; etiquetas
     text-xs font-medium text-muted-foreground; números tabular-nums.
   · Superficies: bg-card + border border-border + rounded-lg. Sin glows.
   · Color: neutro por default; el color solo comunica estado (éxito/alerta/
     error) en tonos suaves, nunca decora. */

import { WmsArt } from "./Illustrations";

export const cls = {
  // input de texto estándar
  input: "w-full px-3 py-2 text-sm bg-card border border-input rounded-md " +
         "placeholder:text-muted-foreground/60 focus:outline-none " +
         "focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors",
  // celda de encabezado / celda normal (para tablas que no usan <Th>)
  th: "px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap",
  td: "px-3 py-2 align-middle",
};

export const Card = ({ className = "", children, ...rest }) => (
  <div className={`bg-card border border-border rounded-lg ${className}`} {...rest}>
    {children}
  </div>
);

/* Barra de acciones del módulo. NO lleva título: el nombre y la descripción
   los pinta el encabezado del shell (WMS.js), y tenerlos en los dos lados
   costaba ~150px verticales en cada pantalla del almacén — el módulo se
   presentaba dos veces antes de enseñar un solo dato.

   `context` + `hint` son para lo que el shell NO puede saber: el sub-modo
   activo dentro del módulo (Mover: "Ajuste Masivo") o la instrucción del paso
   de un asistente. Eso no es duplicado, es estado, y se pinta subordinado al
   título del shell, no compitiendo con él.

   Sin nada que mostrar no pinta ningún nodo, para no dejar un hueco del
   `space-y` del contenedor. */
export const ModuleToolbar = ({ context, hint, right, children }) => {
  const acciones = right ?? children;
  if (!context && !hint && !acciones) return null;
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      {(context || hint) && (
        <div className="min-w-0">
          {context && <div className="text-sm font-semibold">{context}</div>}
          {hint && <div className="text-sm text-muted-foreground mt-0.5">{hint}</div>}
        </div>
      )}
      {acciones && <div className="flex items-center gap-2 ml-auto">{acciones}</div>}
    </div>
  );
};

export const StatCard = ({ label, value, sub, className = "", ...rest }) => (
  <Card className={`px-5 py-4 ${className}`} {...rest}>
    <div className="text-xs font-medium text-muted-foreground">{label}</div>
    <div className="text-2xl font-semibold tracking-tight tabular-nums mt-1">{value}</div>
    {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
  </Card>
);

/* Aviso suave con barra de acento — el único lugar donde el color "grita" un
   poco, porque su trabajo es avisar. tone: warning | danger | info | success */
const ALERT_TONES = {
  warning: "bg-amber-50 border-amber-200/70 border-l-amber-500 dark:bg-amber-500/10 dark:border-amber-500/25 dark:border-l-amber-500",
  danger:  "bg-red-50 border-red-200/70 border-l-red-500 dark:bg-red-500/10 dark:border-red-500/25 dark:border-l-red-500",
  info:    "bg-blue-50 border-blue-200/70 border-l-blue-500 dark:bg-blue-500/10 dark:border-blue-500/25 dark:border-l-blue-500",
  success: "bg-emerald-50 border-emerald-200/70 border-l-emerald-500 dark:bg-emerald-500/10 dark:border-emerald-500/25 dark:border-l-emerald-500",
};

export const SoftAlert = ({ tone = "warning", title, children, action, className = "" }) => (
  <div className={`border border-l-4 rounded-lg px-4 py-3 flex items-center justify-between gap-4 ${ALERT_TONES[tone] || ALERT_TONES.warning} ${className}`}>
    <div className="min-w-0">
      {title && <div className="text-sm font-semibold">{title}</div>}
      {children && <div className="text-sm text-muted-foreground mt-0.5">{children}</div>}
    </div>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);

const BTN_VARIANTS = {
  default: "bg-card border-border text-foreground hover:bg-muted",
  primary: "bg-primary border-transparent text-primary-foreground hover:opacity-90",
  ghost:   "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted",
  danger:  "bg-card border-border text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10",
};

export const Btn = ({ variant = "default", className = "", children, ...rest }) => (
  <button
    className={`inline-flex items-center justify-center gap-1.5 text-sm font-medium rounded-md px-3 py-1.5 border transition-colors disabled:opacity-50 disabled:pointer-events-none ${BTN_VARIANTS[variant] || BTN_VARIANTS.default} ${className}`}
    {...rest}
  >
    {children}
  </button>
);

export const Th = ({ children, right, className = "" }) => (
  <th className={`${cls.th} ${right ? "text-right" : ""} ${className}`}>{children}</th>
);

/* Estado en texto pequeño — reemplaza los chips neón. El color es tenue y el
   texto va en normal-case. tone: neutral | success | warning | danger | info */
const CHIP_TONES = {
  neutral: "bg-muted text-foreground/70 border-border",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25",
  warning: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25",
  danger:  "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25",
  info:    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25",
};

export const Chip = ({ tone = "neutral", className = "", children }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap ${CHIP_TONES[tone] || CHIP_TONES.neutral} ${className}`}>
    {children}
  </span>
);

/* `art` elige la escena de ./Illustrations.js. Con `art={false}` no se dibuja
   nada — para estados vacíos que viven dentro de un panel chico, donde la
   ilustración estorbaría. */
export const EmptyState = ({ title, hint, art = "boxes", children }) => (
  <div className="py-12 text-center">
    {art !== false && (
      <WmsArt name={art} className="w-56 sm:w-64 h-auto mx-auto mb-5" />
    )}
    <div className="text-sm font-semibold text-foreground/80">{title}</div>
    {hint && <div className="text-sm text-muted-foreground mt-1">{hint}</div>}
    {children}
  </div>
);

/* Envoltorio de tabla estándar: encabezado gris tenue, filas con divisor sutil.
   Uso: <TableShell><thead>…<tbody>…</TableShell> — el caller pone su contenido. */
export const TableShell = ({ className = "", maxH = "", children }) => (
  <div className={`overflow-x-auto ${maxH ? `${maxH} overflow-y-auto` : ""} ${className}`}>
    <table className="w-full text-sm">
      {children}
    </table>
  </div>
);

/* Clases sueltas para thead/filas cuando el módulo arma su propia tabla. */
export const tableCls = {
  thead: "bg-muted/50 border-b border-border sticky top-0 z-10",
  row: "border-b border-border/60 hover:bg-muted/40 transition-colors",
};
