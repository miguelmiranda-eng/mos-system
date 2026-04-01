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
    const bg = hexToRgba(color.bg, isDark ? 0.12 : 0.08);
    const border = hexToRgba(color.bg, isDark ? 0.35 : 0.25);

    return (
      <span
        className="inline-flex items-center px-3 py-0.5 rounded-md text-[10px] font-black uppercase whitespace-nowrap tracking-wider border shadow-sm transition-all duration-300"
        style={{
          backgroundColor: bg,
          borderColor: border,
          color: isDark ? lightenHex(color.bg, 0.7) : darkenHex(color.bg, 0.2),
          textShadow: isDark ? `0 0 10px ${hexToRgba(color.bg, 0.4)}` : 'none'
        }}
      >
        {value}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center px-3 py-0.5 rounded-md text-[10px] font-black uppercase whitespace-nowrap border tracking-wider shadow-sm ${isDark ? 'bg-zinc-800/40 border-zinc-700/50 text-zinc-400' : 'bg-gray-100/60 border-gray-300/50 text-gray-500'}`}>
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
