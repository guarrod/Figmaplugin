# CLAUDE.md — Heap Event Tracker (Figma Plugin)

## Project overview

This is a Figma Design plugin that converts `[HEAP]` comments into persistent visual annotations on the canvas. It solves the problem that Figma comments don't survive branch merges, while canvas objects (frames, vectors) do.

## Architecture decisions (and why)

### Why a Plugin and not a Widget?
- Widgets require `can edit` to interact AND only work well in FigJam, not Design files
- A Plugin creates native Figma frames (not widget instances), so annotations persist without the plugin being installed
- Native frames survive branch merges as regular canvas objects

### Why comments as input?
- Collaborator (viewer) profiles CAN leave comments but CANNOT edit the canvas
- This lets analysts (Collab seat, no extra cost) annotate events via comments
- A designer (existing Full Seat) runs the plugin pre-merge to convert comments → visual frames
- Zero additional licensing cost

### Why REST API for comments?
- `figma.fileKey` is often unavailable in development plugins, so we store it manually
- Comments are read via `GET /v1/files/{key}/comments` with a Personal Access Token
- Comments are deleted (resolved) via `DELETE /v1/files/{key}/comments/{id}`
- Token is stored in `figma.clientStorage` (persists locally per device)

### Connector lines approach
- `figma.createConnector()` only works in FigJam, NOT in Design files — we tried and confirmed
- We use `figma.createVector()` with `vectorNetwork` (vertices + segments) — this works reliably
- L-shaped paths with `cornerRadius: 10` on bend vertices for smooth corners
- Lines auto-refresh while plugin is open via `figma.on('documentchange')` with debounce
- Each dot↔card pair is linked by a unique `pairId` stored via `setPluginData()` — this prevents lines from "jumping" to the nearest card when you move things around
- The line connects to whichever of the 4 card edges (left, right, top, bottom) is closest to the dot

## Comment format

Analysts write Figma comments with this format:
```
[HEAP] AppBE-Token-Configuracion-CambiarPIN
```

The plugin extracts everything after `[HEAP] ` as the event name. Date is auto-generated at conversion time in Spanish format: `Marzo 12, 2026`.

## File structure

```
heap-event-tracker/
├── manifest.json    → Plugin manifest (api 1.0.0, editorType: figma, networkAccess: api.figma.com)
├── code.js          → Plugin sandbox code (no build step, plain JS)
├── ui.html          → Plugin UI (single HTML file with embedded CSS + JS)
├── CLAUDE.md        → This file
└── README.md        → User-facing documentation
```

## code.js architecture

### Init
- Loads token and fileKey from `clientStorage`
- Shows UI at 380×580

### Document change listener (live connector refresh)
- `figma.on('documentchange')` detects moves on nodes named `"Heap anchor"` or `"[HEAP] *"`
- Debounced at 80ms to avoid per-pixel redraws
- `isRefreshing` flag prevents infinite loops (delete connector → triggers change → refresh → delete...)
- `liveRefreshConnectors()`: deletes all "Heap connector" vectors, rebuilds from pairId lookup

### convertComments(comments, options)
- Loads Inter font (Regular, Semi Bold, Bold)
- For each comment:
  - Resolves position via `absoluteBoundingBox` + `node_offset`, falls back to absolute coords or viewport center
  - Creates annotation frame at x+120, y-20 from anchor
  - Creates anchor dot (8×8 ellipse)
  - Stores `pairId` on both dot and frame via `setPluginData`
  - Draws L-shaped dashed line via `createCurvedLine()`

### createAnnotationFrame(eventName, x, y)
- Outer frame: accent color fill (#D85A30) acts as left bar, cornerRadius 8
- Inner frame: white background, 256×85, auto-layout vertical
- Badge: "HEAP" pill with coral background
- Event name: Inter Semi Bold 13px
- Date: Inter Regular 11px, Spanish format
- Drop shadow for depth

### createCurvedLine(dotX, dotY, cardX, cardY, cardW, cardH)
- Calculates distance from dot to all 4 edge centers of the card
- Connects to the closest edge
- Horizontal connections: horizontal → bend → vertical → bend → horizontal path
- Vertical connections: vertical → bend → horizontal → bend → vertical path
- Uses `vectorNetwork` with 4 vertices and 3 segments
- Dashed stroke: #D85A30, weight 1.5, dashPattern [5, 4]

### refreshConnectors() (manual, via button)
- Same logic as liveRefresh but with notify feedback and UI message

## ui.html architecture

### Sections
1. **Token input**: collapsible, stores via plugin message → clientStorage
2. **File key input**: accepts full URL or raw key, auto-extracts key from URL via regex
3. **Scan button**: calls REST API, filters comments starting with `[HEAP]`, excludes resolved
4. **Refresh connectors button**: triggers manual line refresh
5. **User filter chips**: groups comments by author, shows count per user
6. **Comment list**: checkboxes for individual selection, select all toggle
7. **Options**: resolve comments (delete after convert), draw connectors, lock frames
8. **Convert button**: sends selected comments + options to plugin code

### State management
- `state.fileKey`, `state.token`, `state.comments[]`, `state.activeUser`
- Comments have: id, eventName, user, userImg, clientMeta, createdAt, checked

### Comment deletion
- After successful conversion, if "resolve" option is on, calls `DELETE` on each comment via REST API
- Sequential deletion with error handling per comment

## Colors
```
accent:      #D85A30 (coral)
accentLight: #FAECE7
accentText:  #993C1D
white:       #FFFFFF
textPrimary: #1A1A1A
textSecondary: #888888
```

## Required Figma token scopes
- `file_comments:read` — read [HEAP] comments
- `file_comments:write` — resolve comments after conversion
- `file_content:read` — read node positions for accurate placement

## Known limitations
- Live connector refresh only works while the plugin window is open
- `figma.fileKey` is often null in dev plugins — manual file key input is the workaround
- Connector lines are static vectors, not native connectors (those only work in FigJam)
- Old annotations created before pairId was implemented won't have pairing — delete and recreate

## Potential improvements
- Export annotations to CSV/JSON for developer handoff
- Batch import from CSV
- Color-coding by event type or status
- "Mark as implemented" state on annotations
- Auto-detection of comment format variations (typos, case insensitive [heap])
