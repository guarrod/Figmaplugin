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
2. Opcional — **Solo formato de evento**: Ignora comentarios conversacionales; solo incluye los que siguen el formato `Modulo-Seccion-Accion` (sin espacios, con guiones)
3. Encuadra en el canvas el área que te interesa y haz clic en **Escanear comentarios en vista actual** (el escaneo siempre se limita al viewport visible, para mantenerlo rápido en archivos grandes)
4. Filtra por usuario si lo necesitas
5. Selecciona/deselecciona los comentarios que quieras convertir (los ya convertidos aparecen marcados con "✓ ya convertida" y no se pueden volver a seleccionar)
6. Opción **Eliminar comentarios originales al convertir**: Borra los comentarios vía API tras crear las tarjetas. ⚠️ Figma solo permite eliminar comentarios propios — si conviertes comentarios de otra persona, el plugin avisará cuáles no pudo eliminar
7. Haz clic en **Convertir**

### Resultado

El plugin genera por cada comentario:
- Una **tarjeta visual** con badge "HEAP", nombre del evento, y fecha
- Una **línea conectora** punteada que une el anclaje con la tarjeta
- Un **punto de anclaje** sobre el elemento original

Cada anotación queda en su propio grupo (con el nombre del evento). El punto de anclaje y la línea quedan **sueltos a propósito**: así puedes reubicar la tarjeta sin arrastrar el anclaje, y la línea se redibuja sola.

Comportamiento en vivo (mientras el plugin está abierto):
- Si mueves la **tarjeta**, la línea se redibuja hacia su nueva posición
- Si mueves el **elemento comentado**, el punto de anclaje lo sigue (mantiene su offset)
- Si arrastras el **punto de anclaje**, se re-ancla en la nueva posición relativa al elemento
- Si las tarjetas se encimarían, el plugin las apila verticalmente al crearlas

El botón **Actualizar líneas de conexión** redibuja todos los conectores y reubica los anclajes sobre sus elementos (útil después de un merge o si moviste cosas con el plugin cerrado).

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
- El token se almacena en `clientStorage` (local, por dispositivo); puedes cambiarlo desde el enlace "Cambiar token" al pie del plugin
- No requiere build step — son archivos planos JS/HTML
- Las coordenadas de los comentarios se resuelven vía `node_id` + `node_offset` o coordenadas absolutas
- Tarjeta, punto y conector se relacionan por un `pairId` guardado en `pluginData`; la tarjeta además guarda el `commentId` para detectar comentarios ya convertidos
- El punto de anclaje guarda el `id` del elemento comentado y su offset, para seguirlo cuando se mueve
- Las respuestas dentro de un hilo de comentarios se ignoran (solo se convierte el comentario principal)
- Por rendimiento, el plugin nunca recorre la página completa: busca sus nodos solo en el nivel superior de la página (y dentro de grupos/secciones). Mantén las tarjetas, puntos y líneas en el nivel superior — si arrastras una tarjeta *dentro* de un frame de diseño, el plugin dejará de detectarla
- Solo el autor de un comentario puede eliminarlo vía API; los fallos de eliminación se reportan en la UI

## Permisos requeridos

| Rol | Puede comentar | Puede ejecutar plugin | Costo adicional |
|-----|:-:|:-:|:-:|
| Collaborator (Viewer) | ✓ | ✗ | Ninguno |
| Full Seat (Editor) | ✓ | ✓ | Ya incluido |

## Requisitos y cosas a tener en cuenta

Apunte para el futuro: qué hace falta para que funcione y qué decisiones de implementación **no conviene revertir**.

### Para que funcione "a la primera"

1. **Instalado como plugin de desarrollo o privado de la organización.** Usa la API privada (`enablePrivatePluginApi`) para autodetectar el archivo abierto, así que solo funciona importado desde manifest (Development) o publicado como plugin **privado** de tu org. No es un plugin público; cada persona del equipo debe importarlo en su Figma.
2. **Token, una sola vez por dispositivo.** La primera vez en una máquina hay que pegar el Personal Access Token. Se guarda en `clientStorage` (local), así que es una vez — no por archivo. Scopes necesarios: `file_comments:read`, `file_comments:write`, `file_content:read`.
3. **El token debe tener acceso al archivo.** Los comentarios se leen por REST API con tu cuenta; si no tienes acceso al archivo → error 403/404. Funciona en cualquier archivo **que tú puedas ver**, no en uno arbitrario.
4. **Corre en el editor de diseño de Figma** (`editorType: "figma"`). No en modo Presentación/prototipo reproducido, ni en Dev Mode, ni en FigJam.
5. **Fuente Inter disponible** (Regular / Semi Bold / Bold). Es la fuente por defecto de Figma; si tu org la restringe, la conversión falla con aviso de fuente.

### Limitaciones / gotchas

- **Los comentarios solo se leen por REST API.** La Plugin API de Figma no expone comentarios, por eso son obligatorios el token + el fileKey. No existe forma de "leer lo que está en pantalla" directamente: se traen todos los comentarios del archivo y se filtran al viewport.
- **Si algún día se publica como plugin público**, `figma.fileKey` pasa a ser `undefined` y reaparece el fallback de pegar la URL del archivo → dejaría de ser automático.
- **Branches:** se asume que `figma.fileKey` devuelve la key de la branch y que la REST API lee los comentarios de esa branch. Es lo esperado, pero conviene confirmarlo en una branch real (la doc oficial no lo especifica).
- **Los comentarios fuera del viewport no se listan a propósito** (el escaneo es solo de lo visible). Acércate a la zona y vuelve a escanear.
- Solo el **autor** de un comentario puede eliminarlo vía API (al usar "Eliminar comentarios originales al convertir").

### Decisiones técnicas que NO hay que revertir

- **`manifest.json` → `"enablePrivatePluginApi": true`** habilita `figma.fileKey`. Sin esto, el plugin cae en pedir la URL del archivo y termina escaneando un archivo fijo (p. ej. main) en vez del que estás viendo.
- **Posición de comentarios con `figma.getNodeByIdAsync()`, nunca `findOne()`.** `findOne` recorre todo el árbol de la página por cada comentario y en archivos grandes tarda minutos; el lookup por ID es casi instantáneo.
- **`figma.skipInvisibleInstanceChildren = true`** acelera el escaneo del viewport saltando hijos invisibles de instancias.
- **En el listener `nodechange`, `geoChanged` incluye `relativeTransform` además de `x/y`.** Mover una tarjeta (que es un GROUP) Figma lo reporta como `relativeTransform`; sin esto, la línea conectora no se redibuja al reubicar la tarjeta.
- **El escaneo se limita siempre al viewport** (`figma.viewport.bounds`): solo lista comentarios visibles en la pantalla actual, del archivo/branch abierto. No escanea páginas completas ni otros archivos.

> Versión actual: **v0.67** (ver el pie del plugin).

## Licencia

Uso interno. Modifica libremente según las necesidades de tu equipo.
