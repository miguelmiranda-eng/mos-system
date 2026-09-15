import { createContext, useContext, useState, useCallback, useEffect } from "react";

const LANG_KEY = "app_language";

// Los diccionarios se cargan BAJO DEMANDA, uno por idioma. Antes
// i18n/translations.js (es + en, ~140 KB gz) se importaba estáticamente y era
// el 46 % del bundle inicial: la PDA de surtido lo descargaba entero para una
// pantalla de 12 KB. Ahora main.js no trae ningún diccionario; el del idioma
// activo (y ES como respaldo) se piden al arrancar y quedan en la caché HTTP
// (/static/ es immutable) para los arranques siguientes.
const DICT_LOADERS = {
  es: () => import(/* webpackChunkName: "i18n-es" */ "../i18n/es"),
  en: () => import(/* webpackChunkName: "i18n-en" */ "../i18n/en"),
};
const translations = {};   // { es: {...}, en: {...} } — se llena al cargar
const loadDict = async (l) => {
  const code = DICT_LOADERS[l] ? l : "es";
  if (!translations[code]) translations[code] = (await DICT_LOADERS[code]()).default;
  return translations[code];
};

const LanguageContext = createContext();

export const LanguageProvider = ({ children }) => {
  const [lang, setLang] = useState(() => localStorage.getItem(LANG_KEY) || "es");
  // `version` sube cada vez que un diccionario termina de cargar: así `t`
  // cambia de identidad y todo lo que dependa de él se vuelve a pintar.
  const [version, setVersion] = useState(0);
  const ready = !!translations[lang] || !!translations.es;

  useEffect(() => {
    let alive = true;
    // ES siempre (es el respaldo de t) + el idioma activo si es otro.
    Promise.all([loadDict("es"), lang !== "es" ? loadDict(lang) : null])
      .then(() => { if (alive) setVersion(v => v + 1); })
      .catch((e) => console.error("[i18n] no se pudo cargar el diccionario", lang, e));
    return () => { alive = false; };
  }, [lang]);

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
  }, [lang, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // tName(value): alias de VISUALIZACIÓN para valores que son datos (nombres de
  // tablero, etc.). El valor no se toca — sigue siendo la llave en la base —,
  // solo cambia cómo se muestra. Busca la clave alias_<slug> y devuelve null si
  // no hay alias, para que el llamador caiga a su formato de siempre.
  const tName = useCallback((value) => {
    if (!value) return null;
    const slug = String(value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return translations[lang]?.["alias_" + slug] || null;
  }, [lang, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hasta que exista al menos ES no se pinta nada: pintar claves crudas
  // ("wms_scan_dest") un instante se ve peor que un fondo vacío ~100 ms.
  if (!ready) return <div style={{ minHeight: "100vh", background: "hsl(var(--background, 0 0% 100%))" }} />;

  return (
    <LanguageContext.Provider value={{ lang, toggleLang, t, tName }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLang = () => useContext(LanguageContext);
