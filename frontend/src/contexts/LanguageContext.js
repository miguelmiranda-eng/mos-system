import { createContext, useContext, useState, useCallback } from "react";
import translations from "../i18n/translations";

const LANG_KEY = "app_language";

const LanguageContext = createContext();

export const LanguageProvider = ({ children }) => {
  const [lang, setLang] = useState(() => localStorage.getItem(LANG_KEY) || "es");

  const toggleLang = useCallback(() => {
    setLang(prev => {
      const next = prev === "es" ? "en" : "es";
      localStorage.setItem(LANG_KEY, next);
      return next;
    });
  }, []);

  // t(key, params?): busca en el idioma activo, cae a ES y por último a la clave.
  // `params` interpola placeholders {nombre} del diccionario (p.ej.
  // "Caja {boxId} ubicada en {location}"). Antes el segundo argumento se
  // ignoraba y la UI mostraba el literal "{count}". Sin params, idéntico a antes.
  const t = useCallback((key, params) => {
    const raw = translations[lang]?.[key] || translations["es"]?.[key] || key;
    if (!params || typeof raw !== "string") return raw;
    return raw.replace(/\{(\w+)\}/g, (m, name) =>
      params[name] === undefined || params[name] === null ? m : String(params[name])
    );
  }, [lang]);

  // tName(value): alias de VISUALIZACIÓN para valores que son datos (nombres de
  // tablero, etc.). El valor no se toca — sigue siendo la llave en la base —,
  // solo cambia cómo se muestra. Busca la clave alias_<slug> y devuelve null si
  // no hay alias, para que el llamador caiga a su formato de siempre.
  const tName = useCallback((value) => {
    if (!value) return null;
    const slug = String(value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return translations[lang]?.["alias_" + slug] || null;
  }, [lang]);

  return (
    <LanguageContext.Provider value={{ lang, toggleLang, t, tName }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLang = () => useContext(LanguageContext);
