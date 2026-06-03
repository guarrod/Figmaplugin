# Heap Event Tracker — Figma Plugin

Plugin para convertir comentarios de Figma en anotaciones visuales persistentes en el canvas.

## El problema que resuelve

Los comentarios de Figma no sobreviven a los merges de branches. Este plugin permite que analistas (con perfil Collaborator) dejen sus eventos de Heap como comentarios, y que un diseñador (Full Seat) los convierta en frames visuales antes del merge, asegurando que persistan.

## Flujo de trabajo

```
1. Analista (Collab) → Comenta: AppBE-Token-Configuracion-CambiarPIN
2. Diseñador (Full Seat) → Ejecuta el plugin antes del merge
3. Plugin → Convierte comentarios en tarjetas visuales con conectores
4. Merge → Las tarjetas viajan como frames nativos ✓
```

## Formato de comentarios

El analista escribe un comentario de Figma con el nombre del evento:

```
AppBE-Token-Configuracion-CambiarPIN
AppFE-Home-VerPromociones
WebBE-Checkout-ConfirmarPago
```

El comentario debe colocarse sobre o cerca del elemento que dispara el evento.

## Instalación

### 1. Descargar los archivos

Coloca estos 3 archivos en una carpeta local:
- `manifest.json`
- `code.js`
- `ui.html`

### 2. Importar en Figma

1. Abre Figma Desktop (no funciona en el navegador para plugins de desarrollo)
2. Ve a **Menu → Plugins → Development → Import plugin from manifest...**
3. Selecciona el archivo `manifest.json` de la carpeta
4. El plugin aparecerá en tu menú de desarrollo

### 3. Obtener un Personal Access Token

1. Ve a [figma.com/settings](https://www.figma.com/settings)
2. Baja hasta **Personal access tokens**
3. Crea un nuevo token con permisos de lectura de archivos
4. Copia el token (empieza con `figd_`)

## Uso

### Primera vez
1. Abre el archivo de Figma que tiene los comentarios
2. Ejecuta el plugin: **Plugins → Development → Heap Event Tracker**
3. Pega tu Personal Access Token y haz clic en **Save**

### Cada vez
1. Ejecuta el plugin
2. Haz clic en **Escanear comentarios**
3. Filtra por usuario si lo necesitas
4. Selecciona/deselecciona los comentarios que quieras convertir
5. Configura las opciones:
   - **Resolve comments**: Elimina los comentarios originales después de convertir
   - **Draw connector lines**: Traza líneas punteadas del elemento a la tarjeta
   - **Lock generated frames**: Bloquea las tarjetas para evitar edición accidental
6. Haz clic en **Convert**

### Resultado

El plugin genera por cada comentario:
- Una **tarjeta visual** con badge "HEAP", nombre del evento, y fecha
- Una **línea conectora** curvada y punteada (opcional)
- Un **punto de anclaje** sobre el elemento original

Todas las anotaciones se agrupan en un grupo llamado `Heap Annotations — [fecha]`.

## Estructura del proyecto

```
heap-event-tracker/
├── manifest.json    → Configuración del plugin
├── code.js          → Lógica del plugin (sandbox de Figma)
├── ui.html          → Interfaz de usuario del plugin
└── README.md        → Este archivo
```

## Notas técnicas

- El plugin usa la **Figma REST API** para leer comentarios (requiere token)
- Las anotaciones son **frames nativos** de Figma, no widgets
- El token se almacena en `clientStorage` (local, por dispositivo)
- No requiere build step — son archivos planos JS/HTML
- Las coordenadas de los comentarios se resuelven vía `node_id` + `node_offset` o coordenadas absolutas

## Permisos requeridos

| Rol | Puede comentar | Puede ejecutar plugin | Costo adicional |
|-----|:-:|:-:|:-:|
| Collaborator (Viewer) | ✓ | ✗ | Ninguno |
| Full Seat (Editor) | ✓ | ✓ | Ya incluido |

## Licencia

Uso interno. Modifica libremente según las necesidades de tu equipo.
