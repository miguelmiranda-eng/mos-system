import { getStatusColor } from "../../lib/constants";

// Minimalista (2026-08-11): solo la letra lleva el color — sin fondo, sin
// borde, sin sombra. En oscuro se aclara poco (0.35) para que el color siga
// reconocible sobre el azulado; en claro se oscurece para contraste en blanco.
export const ColoredBadge = ({ value, isDark }) => {
  const color = getStatusColor(value);
  if (!value) return <span className="text-muted-foreground/40">—</span>;

  if (color) {
    return (
      <span
        className="inline-flex items-center text-[10px] font-black uppercase whitespace-nowrap tracking-wider"
        style={{ color: isDark ? lightenHex(color.bg, 0.35) : darkenHex(color.bg, 0.2) }}
      >
        {value}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center text-[10px] font-black uppercase whitespace-nowrap tracking-wider ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
      {value}
    </span>
  );
};

// Lighten a hex color by blending toward white
function lightenHex(hex, amount) {
  if (!hex || !hex.startsWith('#')) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const nr = Math.round(r + (255 - r) * amount);
  const ng = Math.round(g + (255 - g) * amount);
  const nb = Math.round(b + (255 - b) * amount);
  return `rgb(${nr}, ${ng}, ${nb})`;
}

// Darken a hex color by blending toward black
function darkenHex(hex, amount) {
  if (!hex || !hex.startsWith('#')) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const nr = Math.round(r * (1 - amount));
  const ng = Math.round(g * (1 - amount));
  const nb = Math.round(b * (1 - amount));
  return `rgb(${nr}, ${ng}, ${nb})`;
}
