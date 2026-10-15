# heap-api

Proxy OAuth entre el plugin Heap Event Tracker y la REST API de Figma. Guarda el refresh token de **una** cuenta de Figma y renueva el access token solo, así el equipo no maneja tokens.

## Endpoints
- `GET /auth/login?key=ADMIN_KEY` → inicia la autorización (una sola vez).
- `GET /auth/callback` → redirect URI de Figma.
- `GET /status`, `GET /files/:fileKey/comments`, `DELETE /files/:fileKey/comments/:id` → exigen header `X-Heap-Key: PLUGIN_KEY`.

El DELETE responde 200 con `{deleted: bool}`; Figma solo deja borrar comentarios de la cuenta autorizada.

## Puesta en marcha
1. `cp .env.example .env` y completar (client id/secret de la app OAuth, `PLUGIN_KEY` y `ADMIN_KEY` aleatorias, p. ej. `openssl rand -hex 24`).
2. `npm install && npm start` (puerto 3050 por defecto).
3. Abrir `https://guarrod.com/heap-api/auth/login?key=<ADMIN_KEY>` y aceptar en Figma.
4. Poner la misma `PLUGIN_KEY` en `API_KEY` de `ui.html`.

## nginx (en `/etc/nginx/sites-enabled/default`, no en sites-available)
```
location /heap-api/ {
    proxy_pass http://127.0.0.1:3050/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
