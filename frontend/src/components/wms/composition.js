// Lectura de composiciones en el cliente (espejo de services/part_number.py:
// parse_fibers + composition_code). Orientativa: el servidor es quien valida.
// La usan la configuración de Entradas (vista previa) y el recibo (elegir la
// tela del catálogo que compone IGUAL que la línea de la entrada).
// Vista previa del código de composición (58% ALGODON 42% POLIESTER → 58C42P)
// con las fibras de la config. Solo orientativa: el servidor es quien valida.
export const previewComposition = (text, fibers) => {
  const pairs = [];
  const unknown = [];
  const norm = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  // Mismo criterio que parse_fibers: la fibra se busca DENTRO del segmento
  // hasta el siguiente % ("20% RECYCLED POLYESTER") y la repetida se suma.
  for (const m of norm(text).matchAll(/(\d{1,3})\s*%\s*([^%\d]*)/g)) {
    const words = (m[2].match(/[A-Z]+/g) || []).filter(w => w !== "DE");
    let code = null;
    for (const word of words) {
      const f = (fibers || []).find(x => (x.keywords || []).some(k => word.startsWith(norm(k)) || norm(k).startsWith(word)));
      if (f) { code = String(f.code).toUpperCase(); break; }
    }
    if (code) pairs.push([parseInt(m[1], 10), code]); else if (words.length) unknown.push(words.join(" "));
  }
  const merged = new Map();
  for (const [p, c] of pairs) merged.set(c, (merged.get(c) || 0) + p);
  pairs.length = 0;
  for (const [c, p] of merged) pairs.push([p, c]);
  pairs.sort((a, b) => b[0] - a[0]);
  const total = pairs.reduce((s, [p]) => s + p, 0);
  const code = pairs.map(([p, c]) => (p < 100 ? String(p).padStart(2, "0") : String(p)) + c).join("");
  return { code, total, unknown, ok: pairs.length > 0 && !unknown.length && total === 100 };
};
