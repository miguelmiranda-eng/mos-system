import { getStatusColor } from "../../lib/constants";

// Converts a hex color to rgba with given opacity
const hexToRgba = (hex, opacity) => {
  if (!hex || !hex.startsWith('#')) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
};

export const ColoredBadge = ({ value, isDark }) => {
  const color = getStatusColor(value);
  if (!value) return <span className="text-muted-foreground/40">—</span>;

  if (color) {
    const bg = hexToRgba(color.bg, isDark ? 0.18 : 0.12);
    const border = hexToRgba(color.bg, isDark ? 0.45 : 0.35);
    const text = color.bg; // use the original color as text for glass effect

    return (
      <span
        className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap tracking-wide border"
        style={{
          backgroundColor: bg,
          borderColor: border,
          color: isDark ? lightenHex(color.bg, 0.75) : darkenHex(color.bg, 0.15),
        }}
      >
        {value}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap border tracking-wide ${isDark ? 'bg-zinc-800/60 border-zinc-700/60 text-zinc-300' : 'bg-gray-100/80 border-gray-300/60 text-gray-600'}`}>
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
