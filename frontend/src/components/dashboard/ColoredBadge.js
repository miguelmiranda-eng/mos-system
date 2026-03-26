import { getStatusColor } from "../../lib/constants";

export const ColoredBadge = ({ value, isDark }) => {
  const color = getStatusColor(value);
  if (!value) return <span className="text-muted-foreground">-</span>;
  if (color) {
    return (
      <span className="px-2 py-1 rounded text-xs font-medium whitespace-nowrap" style={{ backgroundColor: color.bg, color: color.text }}>
        {value}
      </span>
    );
  }
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${isDark ? 'bg-zinc-700 text-zinc-200' : 'bg-gray-200 text-gray-700'}`}>
      {value}
    </span>
  );
};
