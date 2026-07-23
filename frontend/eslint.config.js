import globals from "globals";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        process: "readonly"
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks
    },
    settings: {
      react: {
        version: "detect"
      }
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      // Una const usada antes de declararse compila pero revienta en runtime (TDZ)
      // si la referencia se evalúa de inmediato en el cuerpo del componente; los
      // avisos dentro de callbacks/handlers son diferidos e inofensivos.
      "no-use-before-define": ["warn", { "functions": false, "classes": false, "variables": true }]
    }
  },
  {
    ignores: ["node_modules/", "build/", "dist/"]
  }
];
