# Etapa 1: Build de React
FROM node:18-alpine AS build

WORKDIR /app

# Instalar dependencias
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

# Evitar errores de memoria o advertencias bloqueantes de eslint
ENV CI=false

# Copiar código fuente y construir
COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# Etapa 2: Servidor Nginx para archivos estáticos
FROM nginx:alpine

# Copiar build de React
COPY --from=build /app/build /usr/share/nginx/html

# Configuración personalizada para React Router
COPY ./nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
