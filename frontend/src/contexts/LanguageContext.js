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

  return (
    <LanguageContext.Provider value={{ lang, toggleLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLang = () => useContext(LanguageContext);
