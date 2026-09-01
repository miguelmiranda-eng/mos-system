import { useState } from "react";

// Lógica de @menciones para el textarea del composer. Detecta "@fragmento"
// justo antes del cursor, filtra usuarios por nombre/email y ofrece navegación
// con flechas + Enter/Tab para insertar. El render del dropdown vive en el
// composer; este hook solo maneja el estado y las transformaciones de texto.
export function useMentions(value, setValue, users, textareaRef) {
  const [query, setQuery] = useState(null);
  const [index, setIndex] = useState(0);

  const filtered =
    query !== null
      ? users
          .filter((u) => {
            const name = (u.name || "").toLowerCase();
            const email = (u.email || "").toLowerCase();
            return name.includes(query) || email.includes(query);
          })
          .slice(0, 6)
      : [];

  const reset = () => setQuery(null);

  const handleChange = (e) => {
    const val = e.target.value;
    setValue(val);
    const cursorPos = e.target.selectionStart;
    const before = val.substring(0, cursorPos);
    const atMatch = before.match(/@(\w*)$/);
    if (atMatch) {
      setQuery(atMatch[1].toLowerCase());
      setIndex(0);
    } else {
      setQuery(null);
    }
  };

  const insert = (user) => {
    const cursorPos = textareaRef.current?.selectionStart ?? value.length;
    const before = value.substring(0, cursorPos);
    const after = value.substring(cursorPos);
    const atIdx = before.lastIndexOf("@");
    const mentionName = user.name || user.email.split("@")[0];
    setValue(before.substring(0, atIdx) + `@${mentionName} ` + after);
    setQuery(null);
    textareaRef.current?.focus();
  };

  // Devuelve true si consumió la tecla (para que el composer no haga lo suyo).
  const handleKeyDown = (e) => {
    if (query === null || filtered.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insert(filtered[index]);
      return true;
    }
    if (e.key === "Escape") {
      setQuery(null);
      return true;
    }
    return false;
  };

  return { query, filtered, index, handleChange, handleKeyDown, insert, reset };
}
