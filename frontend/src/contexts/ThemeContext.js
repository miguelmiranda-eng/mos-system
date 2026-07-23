import React, { createContext, useContext, useEffect } from 'react';

const ThemeContext = createContext();

/* TEMA ÚNICO (rediseño 2026-07, pedido del usuario): un solo tema azulado
   semi-oscuro con detalles claros — se retiró el switch claro/oscuro.

   La paleta vive en index.css bajo la clase `dark`, que aquí se fija SIEMPRE:
   así todos los pares Tailwind `x dark:y` del código resuelven a su variante
   sobre fondo oscuro y no hay dos temas que mantener. `toggleTheme`/`setTheme`
   se conservan como no-ops para no romper llamadores viejos. */
export const ThemeProvider = ({ children }) => {
  const theme = 'dark';

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'light-theme');
    root.classList.add('dark');
    // Se pisa cualquier preferencia guardada de la era de dos temas.
    localStorage.setItem('mos_theme', 'dark');
    localStorage.setItem('theme', 'dark');
  }, []);

  const toggleTheme = () => {};
  const setTheme = () => {};

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};
