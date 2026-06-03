// Heap Event Tracker - Plugin Code (sandbox)
// Converts [HEAP] comments into visual annotation frames on the canvas
// Uses native Figma connectors that auto-adjust when nodes are moved

figma.showUI(__html__, { width: 380, height: 580, themeColors: true });

// ─── Init ────────────────────────────────────────────────────────────
(async () => {
  const token = (await figma.clientStorage.getAsync("heap-token")) || "";
  // File key: try auto-detect, then check if saved on the file itself
  const rootFileKey = figma.root.getPluginData("fileKey") || "";
  const fileKey = figma.fileKey || rootFileKey || "";
  figma.ui.postMessage({
    type: "init",
    fileKey: fileKey,
    token: token,
  });
})();

// ─── Live connector refresh on node move ─────────────────────────────
var isRefreshing = false;
var refreshTimeout = null;

// Must load all pages before registering documentchange in incremental mode
figma.loadAllPagesAsync().then(function () {
  figma.on("documentchange", function (event) {
    if (isRefreshing) return;

    var heapMoved = false;
    for (var i = 0; i < event.documentChanges.length; i++) {
      var change = event.documentChanges[i];
      if (change.type === "PROPERTY_CHANGE" && change.node) {
        var name = "";
        try { name = change.node.name || ""; } catch (e) { continue; }
        if (name === "Heap anchor" || name.indexOf("[HEAP] ") === 0) {
          heapMoved = true;
          break;
        }
      }
    }

    if (!heapMoved) return;

    if (refreshTimeout) clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(function () {
      liveRefreshConnectors();
    }, 80);
  });
});

async function liveRefreshConnectors() {
  isRefreshing = true;

  var page = figma.currentPage;
  var dots = page.findAll(function (n) { return n.name === "Heap anchor"; });
  var connectors = page.findAll(function (n) { return n.name === "Heap connector"; });
  var annotations = page.findAll(function (n) { return n.name.indexOf("[HEAP] ") === 0 && n.type === "FRAME"; });

  if (dots.length === 0 || annotations.length === 0) {
    isRefreshing = false;
    return;
  }

  for (var i = 0; i < connectors.length; i++) {
    connectors[i].remove();
  }

  var annByPair = {};
  for (var a = 0; a < annotations.length; a++) {
    var pid = annotations[a].getPluginData("pairId");
    if (pid) annByPair[pid] = annotations[a];
  }

  for (var d = 0; d < dots.length; d++) {
    var dot = dots[d];
    var dotPairId = dot.getPluginData("pairId");
    var paired = dotPairId ? annByPair[dotPairId] : null;

    if (!paired) continue;

    var dotCenterX = dot.x + dot.width / 2;
    var dotCenterY = dot.y + dot.height / 2;

    try {
      await createCurvedLine(dotCenterX, dotCenterY, paired.x, paired.y, paired.width, paired.height);
    } catch (e) {}
  }

  isRefreshing = false;
}

// ─── Message handler ─────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "save-token":
      await figma.clientStorage.setAsync("heap-token", msg.token);
      figma.ui.postMessage({ type: "token-saved" });
      break;

    case "save-filekey":
      figma.root.setPluginData("fileKey", msg.fileKey);
      figma.ui.postMessage({ type: "filekey-saved" });
      break;

    case "get-filekey":
      // Try every possible way to get the file key
      var detectedKey = "";
      try { detectedKey = figma.fileKey || ""; } catch (e) {}
      if (!detectedKey) {
        try { detectedKey = figma.root.getPluginData("fileKey") || ""; } catch (e) {}
      }
      figma.ui.postMessage({ type: "filekey-result", fileKey: detectedKey });
      break;

    case "convert":
      await convertComments(msg.comments, msg.options);
      break;

    case "refresh-connectors":
      refreshConnectors();
      break;

    case "get-viewport":
      var vb = figma.viewport.bounds;
      figma.ui.postMessage({
        type: "viewport-bounds",
        bounds: { x: vb.x, y: vb.y, width: vb.width, height: vb.height },
      });
      break;

    case "check-page-nodes":
      // Build node ID set and bbox map for the current page
      var allPageNodes = figma.currentPage.findAll();
      var nodeIdSet = {};
      var nodeBBoxMap = {};
      nodeIdSet[figma.currentPage.id] = true;
      for (var ni = 0; ni < allPageNodes.length; ni++) {
        var pn = allPageNodes[ni];
        nodeIdSet[pn.id] = true;
        if (pn.absoluteBoundingBox) nodeBBoxMap[pn.id] = pn.absoluteBoundingBox;
      }

      var vb = msg.viewportBounds || null;
      var validIds = [];

      for (var pi = 0; pi < msg.items.length; pi++) {
        var item = msg.items[pi];
        var rawId = item.nodeId;
        var normalizedId = rawId ? rawId.replace(/-/g, ":") : null;
        var effectiveId = rawId && nodeIdSet[rawId] ? rawId : normalizedId;

        // ── Page filter ──────────────────────────────────────────────
        if (rawId && !nodeIdSet[rawId] && !nodeIdSet[normalizedId]) {
          continue; // comment is on a different page
        }

        // ── Viewport filter ──────────────────────────────────────────
        if (vb) {
          var px, py;
          if (effectiveId && nodeBBoxMap[effectiveId]) {
            var bbox = nodeBBoxMap[effectiveId];
            var offX = item.nodeOffset ? item.nodeOffset.x : bbox.width / 2;
            var offY = item.nodeOffset ? item.nodeOffset.y : bbox.height / 2;
            px = bbox.x + offX;
            py = bbox.y + offY;
          } else if (item.x !== null && item.y !== null) {
            px = item.x;
            py = item.y;
          }
          if (px !== undefined && (px < vb.x || px > vb.x + vb.width ||
                                   py < vb.y || py > vb.y + vb.height)) {
            continue; // outside viewport
          }
        }

        validIds.push(item.commentId);
      }
      figma.ui.postMessage({ type: "page-nodes-result", validIds: validIds });
      break;

    case "cancel":
      figma.closePlugin();
      break;
  }
};

// ─── Heap SVG logo (scaled to 41×16, original viewBox 648×256) ───────
var HEAP_SVG = '<svg width="41" height="16" viewBox="0 0 648 256" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M29.7 55.2H0V200.2H29.7V55.2ZM93.9 0H64.3V110.5H93.9V0Z" fill="black"/><path d="M93.9 144.9H64.3V255.4H93.9V144.9ZM158.1 55.2H128.5V200.2H158.1V55.2Z" fill="#31D891"/><path d="M439.5 172.1C438.1 176.4 436.1 180.5 433.4 184.2C430.7 188 427.5 191.3 423.8 194C419.9 196.9 415.6 199.1 411 200.6C405.9 202.3 400.6 203.1 395.2 203.1C388.8 203.1 382.4 201.9 376.4 199.6C370.5 197.3 365 193.9 360.5 189.4C355.8 184.7 352.1 179.1 349.7 172.9C346.9 165.8 345.5 158.2 345.7 150.6C345.6 143.4 346.9 136.2 349.6 129.4C352 123.4 355.5 117.8 359.9 113C364.2 108.5 369.3 104.8 375 102.4C380.6 99.9 386.7 98.6 392.8 98.6C399.7 98.5 406.6 99.8 413 102.4C418.7 104.7 423.8 108.3 427.9 112.9C432 117.7 435.1 123.2 437 129.2C439.2 136 440.3 143 440.2 150.2C440.2 151.4 440.2 152.6 440.1 153.7C440.1 154.6 440 155.5 439.8 156.4H365.6C365.7 160.6 366.5 164.7 368.1 168.5C369.5 172.1 371.6 175.3 374.3 178C377 180.7 380.2 182.8 383.7 184.1C387.4 185.5 391.3 186.3 395.3 186.2C403.4 186.2 409.5 184.3 413.7 180.5C417.9 176.7 421.1 171.8 422.9 166.4L439.5 172.1ZM420.1 140.8C420 134.2 417.4 127.8 412.9 122.9C408.4 118.1 401.8 115.7 393 115.6C389.2 115.5 385.5 116.3 382 117.7C378.9 119 376.1 121 373.8 123.4C371.6 125.8 369.7 128.5 368.4 131.5C367.1 134.4 366.3 137.5 366.1 140.7H420.1V140.8ZM311.1 200.2V135.8H244.6V200.2H224.5V55.2H244.6V117.2H311.1V55.2H331.2V200.2H311.1Z" fill="black"/><path d="M439.4 172.1C433.9 189.5 418.1 203.2 395.2 203.2C368.8 203.2 345.7 184 345.7 150.6C345.7 119.7 368 98.6 392.7 98.6C423 98.6 439.9 119.5 439.9 150.1C439.9 152.2 439.8 154.2 439.5 156.2H365.4C365.8 173.8 378.5 186.1 395.1 186.1C411.1 186.1 419 177.3 422.7 166.3L439.4 172.1ZM419.9 140.8C419.5 126.7 410.3 115.6 392.9 115.6C376.7 115.6 366.9 128.1 366.1 140.8H419.9ZM479.3 143.9L505.9 140C511.8 139.2 513.5 136.1 513.5 132.6C513.5 123 507.2 115 492.2 115C478.7 115 471.1 123.4 469.9 134.8L451.5 130.5C453.5 111.7 470.5 98.6 491.8 98.6C521.2 98.6 532.7 115.4 532.7 134.6V183.9C532.6 189.3 533 194.7 533.9 200.1H515.1C514.3 195.7 514 191.3 514.1 186.8C509.8 193.8 500 203.2 482.4 203.2C462.4 203.2 449.5 189.3 449.5 173.8C449.5 156.2 462.4 146.4 479.3 143.9ZM513.5 158V153.5L483.4 158C475.2 159.2 469.1 163.9 469.1 172.7C469.1 180.1 475.2 187 485.1 187C500.8 187.1 513.5 179.5 513.5 158ZM550.9 239V101.8H569.5V117.1C574.8 107.3 586.5 99.5 602.4 99.5C631.8 99.5 647.6 122.2 647.6 150.8C647.6 180 630.6 202.7 601.8 202.7C586.7 202.7 575.2 195.5 569.9 186.7V238.9H550.9V239ZM598.9 116.5C581.3 116.5 569.7 131.2 569.7 150.8C569.7 171 581.4 185.6 598.9 185.6C616.7 185.6 627.9 171.1 627.9 150.8C628 131.2 616.9 116.5 598.9 116.5Z" fill="black"/></svg>';

// ─── Helpers ─────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { r, g, b };
}

function formatDateSpanish() {
  const months = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
  ];
  const d = new Date();
  return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
}

// ─── Colors ──────────────────────────────────────────────────────────
const COLORS = {
  accent: "#31d891",
  accentLight: "#fce8f3",
  accentText: "#9a004f",
  white: "#FFFFFF",
  textPrimary: "#160f41",
  textSecondary: "#888888",
};

// ─── Resolve comment position ────────────────────────────────────────
function resolveCommentPosition(c) {
  var meta = c.clientMeta || {};

  // Method 1: Node-pinned comment — search only current page (always loaded)
  if (meta.node_id) {
    try {
      var rawId = meta.node_id;
      var normalizedId = rawId.replace(/-/g, ":");
      var node = figma.currentPage.findOne(function(n) {
        return n.id === rawId || n.id === normalizedId;
      });
      if (node && "absoluteBoundingBox" in node) {
        var box = node.absoluteBoundingBox;
        if (box) {
          var offsetX = meta.node_offset ? meta.node_offset.x : box.width / 2;
          var offsetY = meta.node_offset ? meta.node_offset.y : box.height / 2;
          return { x: box.x + offsetX, y: box.y + offsetY, anchorNode: node };
        }
      }
    } catch (e) {}
  }

  // Method 2: Floating comment — absolute canvas coordinates from REST API
  if (meta.x !== undefined && meta.y !== undefined) {
    return { x: meta.x, y: meta.y, anchorNode: null };
  }

  // Method 3: Fallback to viewport center
  var vp = figma.viewport.center;
  return { x: vp.x, y: vp.y, anchorNode: null };
}

// ─── Main conversion logic ───────────────────────────────────────────
async function convertComments(comments, options) {
  try {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
    await figma.loadFontAsync({ family: "Inter", style: "Bold" });
  } catch (e) {
    figma.notify("Error loading Inter font.", { error: true });
    figma.ui.postMessage({ type: "convert-done", count: 0, error: "Font loading failed" });
    return;
  }

  var count = 0;
  var createdNodes = [];

  for (var i = 0; i < comments.length; i++) {
    var c = comments[i];
    try {
      var pos = resolveCommentPosition(c);

      // Position annotation to the right of the anchor
      var frameX = pos.x + 120;
      var frameY = pos.y - 20;

      // Create annotation card and wrap it in a group
      var annotationFrame = createAnnotationFrame(c.eventName, c.user || "", frameX, frameY);
      var group = figma.group([annotationFrame], figma.currentPage);
      group.name = "[HEAP] " + c.eventName;

      var pairId = "heap-pair-" + Date.now() + "-" + i;
      annotationFrame.setPluginData("pairId", pairId);

      // Anchor dot at the comment position
      var dot = figma.createEllipse();
      dot.name = "Heap anchor";
      dot.resize(8, 8);
      dot.x = pos.x - 4;
      dot.y = pos.y - 4;
      dot.fills = [{ type: "SOLID", color: hexToRgb(COLORS.accent) }];
      dot.strokes = [{ type: "SOLID", color: hexToRgb(COLORS.white) }];
      dot.strokeWeight = 1.5;
      dot.setPluginData("pairId", pairId);

      // Dashed connector line
      try {
        var line = await createCurvedLine(pos.x, pos.y, frameX, frameY, annotationFrame.width, annotationFrame.height);
        createdNodes.push(line);
      } catch (lineErr) {
        console.error("Line creation failed:", lineErr);
      }

      if (options.lockFrames) {
        group.locked = true;
      }

      createdNodes.push(dot);
      createdNodes.push(group);
      count++;
    } catch (err) {
      console.error("Error creating annotation for:", c.eventName, err);
    }
  }

  if (createdNodes.length > 0) {
    figma.viewport.scrollAndZoomIntoView(createdNodes);
  }

  figma.ui.postMessage({ type: "convert-done", count: count });
  figma.notify("Done! " + count + " Heap annotations created");
}

// ─── Annotation frame builder ────────────────────────────────────────
function createAnnotationFrame(eventName, user, x, y) {
  var date = formatDateSpanish();

  var outer = figma.createFrame();
  outer.name = "[HEAP] " + eventName;
  outer.layoutMode = "HORIZONTAL";
  outer.primaryAxisSizingMode = "AUTO";
  outer.counterAxisSizingMode = "AUTO";
  outer.paddingLeft = 4;
  outer.paddingTop = 0;
  outer.paddingRight = 0;
  outer.paddingBottom = 0;
  outer.itemSpacing = 0;
  outer.fills = [{ type: "SOLID", color: hexToRgb(COLORS.accent) }];
  outer.cornerRadius = 8;
  outer.clipsContent = true;
  outer.x = x;
  outer.y = y;
  outer.effects = [
    {
      type: "DROP_SHADOW",
      color: { r: 0, g: 0, b: 0, a: 0.08 },
      offset: { x: 0, y: 1 },
      radius: 3,
      spread: 0,
      visible: true,
      blendMode: "NORMAL",
    },
  ];

  var inner = figma.createFrame();
  inner.name = "Content";
  inner.layoutMode = "VERTICAL";
  inner.primaryAxisSizingMode = "AUTO";
  inner.counterAxisSizingMode = "FIXED";
  inner.paddingLeft = 12;
  inner.paddingRight = 12;
  inner.paddingTop = 10;
  inner.paddingBottom = 10;
  inner.itemSpacing = 6;
  inner.fills = [{ type: "SOLID", color: hexToRgb(COLORS.white) }];
  inner.topLeftRadius = 0;
  inner.topRightRadius = 6;
  inner.bottomRightRadius = 6;
  inner.bottomLeftRadius = 0;
  inner.resize(256, inner.height);

  var logo = figma.createNodeFromSvg(HEAP_SVG);
  logo.name = "Heap logo";
  logo.layoutAlign = "INHERIT";

  var nameText = figma.createText();
  nameText.characters = eventName;
  nameText.fontSize = 13;
  nameText.fontName = { family: "Inter", style: "Semi Bold" };
  nameText.fills = [{ type: "SOLID", color: hexToRgb(COLORS.textPrimary) }];
  nameText.lineHeight = { value: 18, unit: "PIXELS" };
  nameText.layoutAlign = "STRETCH";
  nameText.textAutoResize = "HEIGHT";

  var dateText = figma.createText();
  dateText.characters = user ? date + "  ·  " + user : date;
  dateText.fontSize = 11;
  dateText.fontName = { family: "Inter", style: "Regular" };
  dateText.fills = [{ type: "SOLID", color: hexToRgb(COLORS.textSecondary) }];
  dateText.lineHeight = { value: 16, unit: "PIXELS" };
  dateText.textAutoResize = "HEIGHT";
  dateText.layoutAlign = "STRETCH";

  inner.appendChild(logo);
  inner.appendChild(nameText);
  inner.appendChild(dateText);
  outer.appendChild(inner);

  return outer;
}

// ─── Smart dashed line: connects to closest side of card ─────────────
async function createCurvedLine(dotX, dotY, cardX, cardY, cardW, cardH) {
  // Calculate distances from dot to each edge center
  var leftX = cardX, leftY = cardY + cardH / 2;
  var rightX = cardX + cardW, rightY = cardY + cardH / 2;
  var topX = cardX + cardW / 2, topY = cardY;
  var bottomX = cardX + cardW / 2, bottomY = cardY + cardH;

  var distLeft = Math.sqrt(Math.pow(dotX - leftX, 2) + Math.pow(dotY - leftY, 2));
  var distRight = Math.sqrt(Math.pow(dotX - rightX, 2) + Math.pow(dotY - rightY, 2));
  var distTop = Math.sqrt(Math.pow(dotX - topX, 2) + Math.pow(dotY - topY, 2));
  var distBottom = Math.sqrt(Math.pow(dotX - bottomX, 2) + Math.pow(dotY - bottomY, 2));

  // Pick the closest edge
  var minDist = Math.min(distLeft, distRight, distTop, distBottom);
  var targetX, targetY, isVertical;

  if (minDist === distLeft) {
    targetX = leftX; targetY = leftY; isVertical = false;
  } else if (minDist === distRight) {
    targetX = rightX; targetY = rightY; isVertical = false;
  } else if (minDist === distTop) {
    targetX = topX; targetY = topY; isVertical = true;
  } else {
    targetX = bottomX; targetY = bottomY; isVertical = true;
  }

  var dx = targetX - dotX;
  var dy = targetY - dotY;

  var vector = figma.createVector();
  vector.name = "Heap connector";
  vector.x = dotX;
  vector.y = dotY;
  vector.fills = [];

  // L-shaped path: bend direction depends on connection side
  var vertices, segments;

  if (isVertical) {
    // Connecting top/bottom: go vertical first, then horizontal
    var midY = dy * 0.5;
    vertices = [
      { x: 0, y: 0 },
      { x: 0, y: midY, cornerRadius: 10 },
      { x: dx, y: midY, cornerRadius: 10 },
      { x: dx, y: dy },
    ];
  } else {
    // Connecting left/right: go horizontal first, then vertical
    var midX = dx * 0.5;
    vertices = [
      { x: 0, y: 0 },
      { x: midX, y: 0, cornerRadius: 10 },
      { x: midX, y: dy, cornerRadius: 10 },
      { x: dx, y: dy },
    ];
  }

  segments = [
    { start: 0, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ];

  await vector.setVectorNetworkAsync({
    vertices: vertices,
    segments: segments,
    regions: [],
  });

  vector.strokes = [{ type: "SOLID", color: hexToRgb(COLORS.accent) }];
  vector.strokeWeight = 1.5;
  vector.dashPattern = [5, 4];

  return vector;
}

// ─── Refresh all connectors based on paired positions ────────────────
async function refreshConnectors() {
  var page = figma.currentPage;

  var dots = page.findAll(function (n) { return n.name === "Heap anchor"; });
  var connectors = page.findAll(function (n) { return n.name === "Heap connector"; });
  var annotations = page.findAll(function (n) { return n.name.indexOf("[HEAP] ") === 0 && n.type === "FRAME"; });

  if (dots.length === 0 || annotations.length === 0) {
    figma.notify("No Heap annotations found on this page.");
    figma.ui.postMessage({ type: "refresh-done", count: 0 });
    return;
  }

  // Delete old connectors
  for (var i = 0; i < connectors.length; i++) {
    connectors[i].remove();
  }

  // Build lookup: pairId → annotation
  var annByPair = {};
  for (var a = 0; a < annotations.length; a++) {
    var pid = annotations[a].getPluginData("pairId");
    if (pid) annByPair[pid] = annotations[a];
  }

  // Redraw using pair IDs
  var count = 0;
  for (var d = 0; d < dots.length; d++) {
    var dot = dots[d];
    var dotPairId = dot.getPluginData("pairId");
    var paired = dotPairId ? annByPair[dotPairId] : null;

    if (!paired) continue;

    var dotCenterX = dot.x + dot.width / 2;
    var dotCenterY = dot.y + dot.height / 2;

    try {
      await createCurvedLine(dotCenterX, dotCenterY, paired.x, paired.y, paired.width, paired.height);
      count++;
    } catch (e) {
      console.error("Refresh line failed:", e);
    }
  }

  figma.notify("Refreshed " + count + " connectors");
  figma.ui.postMessage({ type: "refresh-done", count: count });
}