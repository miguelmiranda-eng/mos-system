// COMPAT: los diccionarios viven en ./es.js y ./en.js y se cargan bajo demanda
// (ver contexts/LanguageContext.js). Este módulo se conserva solo para código
// o herramientas que importen translations.js; NO lo importes desde la app —
// volvería a meter los dos idiomas en el bundle inicial.
import es from "./es";
import en from "./en";

const translations = { es, en };
export default translations;
