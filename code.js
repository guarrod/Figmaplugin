// Heap Event Tracker - Plugin Code (sandbox)
// Converts comments into visual annotation frames on the canvas
// Card, anchor dot and connector stay as loose siblings (linked by pairId)
// so the card can be repositioned freely without dragging the anchor along.
//
// Scanning: the scan filter (check-page-nodes) builds a complete node map of
// the current page via figma.currentPage.findAll() and resolves each comment's
// pin position from its anchor node's absoluteBoundingBox + node_offset, then
// keeps only comments whose pin falls inside the current viewport bounds.
// This is the original, proven approach — reliable across nested nodes.
// Heap annotation nodes themselves are created at the top level of the page,
// so the live-refresh index (collectPairNodes) only walks page.children.

figma.showUI(__html__, { width: 380, height: 580, themeColors: true });

// Skip invisible instance children during traversal. Comment anchors and Heap
// nodes never live inside hidden instance subtrees, so this is a safe and
// significant speedup for scanning large, component-heavy files.
figma.skipInvisibleInstanceChildren = true;

// ─── Connector line settings (persisted per file) ────────────────────
var LINE_STYLES = ["orthogonal", "curve", "straight"];
var LINE_ENDS = ["none", "arrow", "dot"];
var lineStyle = "orthogonal";
var lineEnd = "none";
try {
  var savedStyle = figma.root.getPluginData("heapLineStyle");
  var savedEnd = figma.root.getPluginData("heapLineEnd");
  if (LINE_STYLES.indexOf(savedStyle) !== -1) lineStyle = savedStyle;
  if (LINE_ENDS.indexOf(savedEnd) !== -1) lineEnd = savedEnd;
} catch (e) {}

// ─── Init ────────────────────────────────────────────────────────────
(async () => {
  // Always use the file currently open on screen. Only fall back to a saved
  // key if the editor can't report the current one (manual entry as a last
  // resort) — so the plugin scans wherever the user is, never a stale file.
  var fileKey = "";
  try { fileKey = figma.fileKey || ""; } catch (e) {}
  if (!fileKey) { try { fileKey = figma.root.getPluginData("fileKey") || ""; } catch (e) {} }
  figma.ui.postMessage({
    type: "init",
    fileKey: fileKey,
    lineStyle: lineStyle,
    lineEnd: lineEnd,
  });
})();

// ─── Heap node discovery (top-level scan — cheap even on huge pages) ─
function collectPairNodes(page) {
  var res = {
    dotsByPair: {}, dotsById: {}, annByPair: {}, connsByPair: {},
    dots: [], legacyConnectors: [], pairIdByNodeId: {},
  };
  var children = page.children;
  for (var i = 0; i < children.length; i++) {
    visitHeapCandidate(children[i], res, 0);
  }
  return res;
}

function visitHeapCandidate(n, res, depth) {
  var pid = "";
  try { pid = n.getPluginData("pairId") || ""; } catch (e) { return; }

  if (n.name === "Heap connector") {
    if (pid) {
      if (!res.connsByPair[pid]) res.connsByPair[pid] = [];
      res.connsByPair[pid].push(n);
    } else {
      res.legacyConnectors.push(n); // created before v0.6, no pairId
    }
  } else if (pid && n.name === "Heap anchor") {
    res.dotsByPair[pid] = n;
    res.dotsById[n.id] = n;
    res.dots.push(n);
  } else if (pid && n.type === "FRAME" && n.getPluginData("heapAnnotation") === "1") {
    res.annByPair[pid] = n;
  }

  if (pid) res.pairIdByNodeId[n.id] = pid;

  // Cards live one level inside their group; tolerate sections too.
  // Never recurse into FRAMEs — that's where the actual design lives.
  if (depth < 3 && (n.type === "GROUP" || n.type === "SECTION")) {
    var kids = n.children;
    for (var k = 0; k < kids.length; k++) visitHeapCandidate(kids[k], res, depth + 1);
  }
}

// ─── Live connector refresh on node move ─────────────────────────────
var isRefreshing = false;
var refreshTimeout = null;
var pendingPairIds = {};   // pairId -> true (pairs whose nodes moved)
var pendingDotIds = {};    // dotId -> true (dots dragged by the user)
var pendingTargetIds = {}; // anchored element id -> true (elements that moved)
var attachedPages = {};

// Index so the nodechange handler does pure id lookups (no API calls)
var heapIndex = null; // { pairIdByNodeId, targetToDots }

var indexBuild = 0;

function rebuildHeapIndex() {
  // Keep the previous anchor map until the new one resolves (no blind window)
  var idx = { pairIdByNodeId: {}, targetToDots: heapIndex ? heapIndex.targetToDots : {} };
  var dots = [];
  try {
    var pairs = collectPairNodes(figma.currentPage);
    idx.pairIdByNodeId = pairs.pairIdByNodeId;
    dots = pairs.dots;
  } catch (e) {}
  heapIndex = idx; // pair lookups are usable right away

  // Moving a frame only reports the frame itself, not the elements inside it,
  // so index every ancestor of each anchored element too (resolved async).
  var token = ++indexBuild;
  (async function () {
    var targetToDots = {};
    function add(id, dotId) {
      if (!targetToDots[id]) targetToDots[id] = {};
      targetToDots[id][dotId] = true;
    }
    for (var i = 0; i < dots.length; i++) {
      var nid = "", dotId = "";
      try { nid = dots[i].getPluginData("anchorNodeId"); dotId = dots[i].id; } catch (e) {}
      if (!nid) continue;
      add(nid, dotId);
      try {
        var node = await figma.getNodeByIdAsync(nid);
        var p = node && !node.removed ? node.parent : null;
        var guard = 0;
        while (p && p.type !== "PAGE" && p.type !== "DOCUMENT" && guard++ < 100) {
          add(p.id, dotId);
          p = p.parent;
        }
      } catch (e) {}
    }
    if (token === indexBuild) idx.targetToDots = targetToDots;
  })();
}

function geoChanged(props) {
  if (!props) return false;
  // Figma reports a drag as x/y on leaf nodes, but as "relativeTransform" when
  // moving a GROUP (the card) — without this the card move was never detected.
  return props.indexOf("x") !== -1 || props.indexOf("y") !== -1 ||
         props.indexOf("width") !== -1 || props.indexOf("height") !== -1 ||
         props.indexOf("relativeTransform") !== -1;
}

function handleNodeChanges(nodeChanges) {
  if (isRefreshing || !heapIndex) return;

  var relevant = false;
  for (var i = 0; i < nodeChanges.length; i++) {
    var change = nodeChanges[i];
    if (change.type !== "PROPERTY_CHANGE" || !change.node) continue;
    if (!geoChanged(change.properties)) continue;
    var node = change.node;
    // Connectors are output only: our own redraws must not retrigger a refresh
    try { if (node.name === "Heap connector") continue; } catch (e) { continue; }

    var pid = heapIndex.pairIdByNodeId[node.id];
    if (pid) {
      pendingPairIds[pid] = true;
      try {
        if (!node.removed && node.name === "Heap anchor") pendingDotIds[node.id] = true;
      } catch (e) {}
      relevant = true;
    } else if (heapIndex.targetToDots[node.id]) {
      pendingTargetIds[node.id] = true;
      relevant = true;
    }
  }

  if (!relevant) return;

  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(function () {
    liveRefreshConnectors();
  }, 80);
}

function attachPageListener(page) {
  if (attachedPages[page.id]) return;
  attachedPages[page.id] = true;
  page.on("nodechange", function (event) {
    handleNodeChanges(event.nodeChanges);
  });
}

// Defer so the plugin window opens immediately
setTimeout(function () {
  attachPageListener(figma.currentPage);
  rebuildHeapIndex();
}, 0);

figma.on("currentpagechange", function () {
  attachPageListener(figma.currentPage);
  rebuildHeapIndex();
});

// ─── Anchor dot ↔ element binding ────────────────────────────────────
async function getAnchorBox(dot) {
  var nid = "";
  try { nid = dot.getPluginData("anchorNodeId"); } catch (e) {}
  if (!nid) return null;
  var node = null;
  try { node = await figma.getNodeByIdAsync(nid); } catch (e) { return null; }
  if (!node || node.removed || !("absoluteBoundingBox" in node) || !node.absoluteBoundingBox) return null;
  return node.absoluteBoundingBox;
}

// User dragged the dot: store its new offset relative to the element
async function updateDotOffset(dot) {
  var box = await getAnchorBox(dot);
  if (!box) return;
  dot.setPluginData("anchorOffsetX", String(dot.x + dot.width / 2 - box.x));
  dot.setPluginData("anchorOffsetY", String(dot.y + dot.height / 2 - box.y));
}

// Element moved: pull the dot along using the stored offset
async function repositionDot(dot) {
  var box = await getAnchorBox(dot);
  if (!box) return false;
  var ox = parseFloat(dot.getPluginData("anchorOffsetX"));
  var oy = parseFloat(dot.getPluginData("anchorOffsetY"));
  if (isNaN(ox)) ox = box.width / 2;
  if (isNaN(oy)) oy = box.height / 2;
  var nx = box.x + ox - dot.width / 2;
  var ny = box.y + oy - dot.height / 2;
  if (Math.abs(nx - dot.x) < 0.01 && Math.abs(ny - dot.y) < 0.01) return false;
  dot.x = nx;
  dot.y = ny;
  return true;
}

// Redraws only the pairs that actually moved
async function liveRefreshConnectors() {
  isRefreshing = true;
  var pairIds = pendingPairIds; pendingPairIds = {};
  var dotIds = pendingDotIds; pendingDotIds = {};
  var targetIds = pendingTargetIds; pendingTargetIds = {};

  try {
    var page = figma.currentPage;
    var pairs = collectPairNodes(page);

    // A dragged dot re-anchors: remember its new offset on the element
    for (var dotId in dotIds) {
      var dragged = pairs.dotsById[dotId];
      if (dragged) await updateDotOffset(dragged);
    }

    // A moved element pulls its anchored dots along
    var t2d = heapIndex ? heapIndex.targetToDots : {};
    for (var tid in targetIds) {
      var dotMap = t2d[tid] || {};
      for (var dId in dotMap) {
        var dot = pairs.dotsById[dId];
        if (!dot) continue;
        var moved = await repositionDot(dot);
        if (moved) pairIds[dot.getPluginData("pairId")] = true;
      }
    }

    for (var pid in pairIds) {
      var conns = pairs.connsByPair[pid] || [];
      var pairDot = pairs.dotsByPair[pid];
      var ann = pairs.annByPair[pid];
      if (!pairDot || !ann) {
        for (var c = 0; c < conns.length; c++) conns[c].remove();
        continue;
      }
      for (var ce = 1; ce < conns.length; ce++) conns[ce].remove();

      try {
        await drawConnector(pairDot, ann, pid, conns[0] || null);
      } catch (e) {}
    }
  } catch (e) {
  } finally {
    isRefreshing = false;
  }

  rebuildHeapIndex();
}

// ─── Message handler ─────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "save-filekey":
      figma.root.setPluginData("fileKey", msg.fileKey);
      figma.ui.postMessage({ type: "filekey-saved" });
      break;

    case "get-filekey":
      // Always prefer the file currently open; saved key only as last resort
      var detectedKey = "";
      try { detectedKey = figma.fileKey || ""; } catch (e) {}
      if (!detectedKey) {
        try { detectedKey = figma.root.getPluginData("fileKey") || ""; } catch (e) {}
      }
      figma.ui.postMessage({ type: "filekey-result", fileKey: detectedKey });
      break;

    case "convert":
      await convertComments(msg.comments);
      break;

    case "refresh-connectors":
      await refreshConnectors();
      break;

    case "sync-comments":
      await syncCommentPositions(msg.items);
      break;

    case "set-line-style":
      if (LINE_STYLES.indexOf(msg.lineStyle) !== -1) lineStyle = msg.lineStyle;
      if (LINE_ENDS.indexOf(msg.lineEnd) !== -1) lineEnd = msg.lineEnd;
      try {
        figma.root.setPluginData("heapLineStyle", lineStyle);
        figma.root.setPluginData("heapLineEnd", lineEnd);
      } catch (e) {}
      await refreshConnectors(true);
      break;

    case "get-viewport":
      var vpb = figma.viewport.bounds;
      figma.ui.postMessage({
        type: "viewport-bounds",
        bounds: { x: vpb.x, y: vpb.y, width: vpb.width, height: vpb.height },
      });
      break;

    case "check-page-nodes":
      var vb = msg.viewportBounds || null;
      var nodeIdSet = {};
      var nodeBBoxMap = {};
      nodeIdSet[figma.currentPage.id] = true;

      // Build the node ID set + bbox map. The filter below is the original,
      // proven logic (pin = bbox + node_offset, tested against the viewport).
      // The only optimization: when we have a viewport, we walk the page tree
      // and PRUNE any subtree whose box is off screen, so we touch only what's
      // visible instead of every node on the canvas (orders of magnitude less).
      if (vb) {
        var vbR = vb.x + vb.width, vbB = vb.y + vb.height;
        var stack = figma.currentPage.children.slice();
        while (stack.length) {
          var n = stack.pop();
          var nbox = ("absoluteBoundingBox" in n) ? n.absoluteBoundingBox : null;
          // Off-screen node → its children are inside it, so skip the subtree
          if (nbox && (nbox.x > vbR || nbox.x + nbox.width < vb.x ||
                       nbox.y > vbB || nbox.y + nbox.height < vb.y)) {
            continue;
          }
          nodeIdSet[n.id] = true;
          if (nbox) nodeBBoxMap[n.id] = nbox;
          if ("children" in n) {
            var kids = n.children;
            for (var ki = 0; ki < kids.length; ki++) stack.push(kids[ki]);
          }
        }
      } else {
        // Full-page scan (fallback button): no viewport to prune by
        var allPageNodes = figma.currentPage.findAll();
        for (var ni = 0; ni < allPageNodes.length; ni++) {
          var pn = allPageNodes[ni];
          nodeIdSet[pn.id] = true;
          if (pn.absoluteBoundingBox) nodeBBoxMap[pn.id] = pn.absoluteBoundingBox;
        }
      }

      // Comments already converted on this page (cards store the commentId).
      // Annotations are top-level, so this top-level scan is cheap + complete.
      var convertedIds = [];
      try {
        var pairsScan = collectPairNodes(figma.currentPage);
        for (var pk in pairsScan.annByPair) {
          var cidv = pairsScan.annByPair[pk].getPluginData("commentId");
          if (cidv) convertedIds.push(cidv);
        }
      } catch (e) {}

      var validIds = [];
      var stats = { total: msg.items.length, otherPage: 0, outsideViewport: 0, inView: 0 };

      for (var pi = 0; pi < msg.items.length; pi++) {
        var item = msg.items[pi];
        var rawId = item.nodeId;
        var normalizedId = rawId ? rawId.replace(/-/g, ":") : null;
        var effectiveId = rawId && nodeIdSet[rawId] ? rawId : normalizedId;

        // ── Page filter ──────────────────────────────────────────────
        // With a viewport we only mapped visible nodes, so a miss means the
        // anchor is either off-screen or on another page → "not in view".
        // Without a viewport (page scan) the map is complete → another page.
        if (rawId && !nodeIdSet[rawId] && !nodeIdSet[normalizedId]) {
          if (vb) stats.outsideViewport++; else stats.otherPage++;
          continue;
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
            stats.outsideViewport++;
            continue; // outside viewport
          }
        }

        validIds.push(item.commentId);
        stats.inView++;
      }

      console.log("[Heap] scan:", JSON.stringify(stats), "vb:", JSON.stringify(vb));
      figma.ui.postMessage({ type: "page-nodes-result", validIds: validIds, convertedIds: convertedIds, stats: stats });
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

function rectsOverlap(a, b) {
  var m = 8; // breathing room between cards
  return a.x < b.x + b.w + m && a.x + a.w + m > b.x &&
         a.y < b.y + b.h + m && a.y + a.h + m > b.y;
}

function overlapsAny(rect, rects) {
  for (var i = 0; i < rects.length; i++) {
    if (rectsOverlap(rect, rects[i])) return true;
  }
  return false;
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
async function resolveCommentPosition(c) {
  var meta = c.clientMeta || {};

  // Method 1: Node-pinned comment — direct id lookup (no tree traversal).
  // findOne() walks the entire page per comment (tens of thousands of nodes
  // on heavy files → minutes); getNodeByIdAsync is a direct hash lookup.
  // REST node_id may use "-" separators, Figma uses ":", so try both forms.
  if (meta.node_id) {
    var ids = [meta.node_id, meta.node_id.replace(/-/g, ":")];
    for (var i = 0; i < ids.length; i++) {
      try {
        var node = await figma.getNodeByIdAsync(ids[i]);
        if (node && !node.removed && "absoluteBoundingBox" in node && node.absoluteBoundingBox) {
          var box = node.absoluteBoundingBox;
          var offsetX = meta.node_offset ? meta.node_offset.x : box.width / 2;
          var offsetY = meta.node_offset ? meta.node_offset.y : box.height / 2;
          return { x: box.x + offsetX, y: box.y + offsetY, anchorNode: node };
        }
      } catch (e) {}
    }
  }

  // Method 2: Floating comment — absolute canvas coordinates from REST API
  if (meta.x !== undefined && meta.y !== undefined) {
    return { x: meta.x, y: meta.y, anchorNode: null };
  }

  // Method 3: Fallback to viewport center
  var vp = figma.viewport.center;
  return { x: vp.x, y: vp.y, anchorNode: null };
}

// ─── Follow the native comment pin ───────────────────────────────────
// The plugin API can't see comments, so the UI polls them via the REST proxy
// and sends their client_meta here. When a comment's pin moved since the last
// sync, its anchor dot follows (a dot the user dragged by hand is left alone
// until the comment itself moves again).
function metaSig(m) {
  m = m || {};
  var o = m.node_offset;
  return JSON.stringify([
    m.node_id || "", o ? o.x : "", o ? o.y : "",
    m.x === undefined ? "" : m.x, m.y === undefined ? "" : m.y,
  ]);
}

async function syncCommentPositions(items) {
  if (!items || !items.length || isRefreshing) return;

  var pairs = collectPairNodes(figma.currentPage);
  var pidByComment = {};
  for (var pk in pairs.annByPair) {
    var cid = pairs.annByPair[pk].getPluginData("commentId");
    if (cid) pidByComment[cid] = pk;
  }

  var changed = [];
  for (var i = 0; i < items.length; i++) {
    var pid = pidByComment[items[i].commentId];
    var dot = pid ? pairs.dotsByPair[pid] : null;
    var meta = items[i].clientMeta || {};
    if (!dot || (!meta.node_id && meta.x === undefined)) continue;

    var sig = metaSig(meta);
    var prev = dot.getPluginData("commentSig");
    if (prev === sig) continue;
    dot.setPluginData("commentSig", sig);
    if (!prev) continue; // first sighting of an older annotation: just remember it

    changed.push({ pid: pid, dot: dot, pos: await resolveCommentPosition({ clientMeta: meta }) });
  }
  if (changed.length === 0) return;

  isRefreshing = true;
  try {
    for (var j = 0; j < changed.length; j++) {
      var ch = changed[j], pos = ch.pos, d = ch.dot;
      d.x = pos.x - d.width / 2;
      d.y = pos.y - d.height / 2;
      if (pos.anchorNode && pos.anchorNode.absoluteBoundingBox) {
        var ab = pos.anchorNode.absoluteBoundingBox;
        d.setPluginData("anchorNodeId", pos.anchorNode.id);
        d.setPluginData("anchorOffsetX", String(pos.x - ab.x));
        d.setPluginData("anchorOffsetY", String(pos.y - ab.y));
      } else {
        d.setPluginData("anchorNodeId", "");
        d.setPluginData("anchorOffsetX", "");
        d.setPluginData("anchorOffsetY", "");
      }
      var ann = pairs.annByPair[ch.pid];
      if (!ann) continue;
      var conns = pairs.connsByPair[ch.pid] || [];
      for (var ce = 1; ce < conns.length; ce++) conns[ce].remove();
      try { await drawConnector(d, ann, ch.pid, conns[0] || null); } catch (e) {}
    }
  } finally {
    isRefreshing = false;
  }
  rebuildHeapIndex();
}

// ─── Main conversion logic ───────────────────────────────────────────
async function convertComments(comments) {
  try {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
    await figma.loadFontAsync({ family: "Inter", style: "Bold" });
  } catch (e) {
    figma.notify("Error al cargar la fuente Inter.", { error: true });
    figma.ui.postMessage({ type: "convert-done", count: 0, successIds: [], error: "Font loading failed" });
    return;
  }

  isRefreshing = true;
  var count = 0;
  var createdNodes = [];
  var successIds = [];

  // Existing cards on the page, so new ones don't land on top of them
  var placedRects = [];
  try {
    var existingPairs = collectPairNodes(figma.currentPage);
    for (var pk in existingPairs.annByPair) {
      var bb = existingPairs.annByPair[pk].absoluteBoundingBox;
      if (bb) placedRects.push({ x: bb.x, y: bb.y, w: bb.width, h: bb.height });
    }
  } catch (e) {}

  try {
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      try {
        var pos = await resolveCommentPosition(c);

        // Position annotation to the right of the anchor
        var frameX = pos.x + 120;
        var frameY = pos.y - 20;

        var annotationFrame = createAnnotationFrame(c.eventName, c.user || "", frameX, frameY, c.commentType, c.rawMessage);

        // Stagger downward until the card stops overlapping other cards
        var rect = { x: annotationFrame.x, y: annotationFrame.y, w: annotationFrame.width, h: annotationFrame.height };
        var guard = 0;
        while (guard < 50 && overlapsAny(rect, placedRects)) {
          rect.y += rect.h + 16;
          guard++;
        }
        annotationFrame.y = rect.y;
        placedRects.push(rect);

        var pairId = "heap-pair-" + Date.now() + "-" + i;
        annotationFrame.setPluginData("pairId", pairId);
        annotationFrame.setPluginData("commentId", c.id || "");

        var group = figma.group([annotationFrame], figma.currentPage);
        group.name = c.eventName;
        group.setPluginData("pairId", pairId);

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
        dot.setPluginData("commentSig", metaSig(c.clientMeta));

        // Bind the dot to the commented element so it follows it
        if (pos.anchorNode && pos.anchorNode.absoluteBoundingBox) {
          var abox = pos.anchorNode.absoluteBoundingBox;
          dot.setPluginData("anchorNodeId", pos.anchorNode.id);
          dot.setPluginData("anchorOffsetX", String(pos.x - abox.x));
          dot.setPluginData("anchorOffsetY", String(pos.y - abox.y));
        }

        // Dashed connector line
        try {
          var line = await drawConnector(dot, annotationFrame, pairId, null);
          createdNodes.push(line);
        } catch (lineErr) {
          console.error("Line creation failed:", lineErr);
        }

        createdNodes.push(dot);
        createdNodes.push(group);
        successIds.push(c.id);
        count++;
      } catch (err) {
        console.error("Error creating annotation for:", c.eventName, err);
      }
    }
  } finally {
    isRefreshing = false;
  }

  rebuildHeapIndex();

  if (createdNodes.length > 0) {
    figma.viewport.scrollAndZoomIntoView(createdNodes);
  }

  figma.ui.postMessage({ type: "convert-done", count: count, successIds: successIds });
  if (count > 0) {
    figma.notify("Listo: " + count + " anotaciones Heap creadas");
  } else {
    figma.notify("No se pudo crear ninguna anotación", { error: true });
  }
}

// ─── Annotation frame builder ────────────────────────────────────────
function createAnnotationFrame(eventName, user, x, y, commentType, rawMessage) {
  var date = formatDateSpanish();
  var isJson = commentType === 'json';

  var outer = figma.createFrame();
  outer.name = eventName;
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
  inner.resize(isJson ? 320 : 256, inner.height);

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

  // JSON comments: copy the comment verbatim (original line breaks and indentation)
  if (isJson && rawMessage) {
    var rawText = figma.createText();
    rawText.characters = rawMessage;
    rawText.fontSize = 10;
    rawText.fontName = { family: "Inter", style: "Regular" };
    rawText.fills = [{ type: "SOLID", color: hexToRgb(COLORS.textSecondary) }];
    rawText.lineHeight = { value: 14, unit: "PIXELS" };
    rawText.layoutAlign = "STRETCH";
    rawText.textAutoResize = "HEIGHT";
    inner.appendChild(rawText);
  }

  inner.appendChild(dateText);
  outer.appendChild(inner);
  outer.setPluginData("heapAnnotation", "1");

  return outer;
}

// ─── Connector line (Autoflow-style) ─────────────────────────────────
// Picks the card side that faces the anchor dot, leaves the dot along that
// axis and enters the card perpendicular to the side, so the line never
// crosses the card. Three styles: orthogonal (rounded steps), curve (bezier)
// and straight. Geometry uses absolute coordinates (works inside Sections).
function pickSide(px, py, b) {
  var L = b.x, R = b.x + b.width, T = b.y, B = b.y + b.height;
  var gx = px < L ? L - px : (px > R ? px - R : 0);
  var gy = py < T ? T - py : (py > B ? py - B : 0);

  if (gx === 0 && gy === 0) {
    // Dot sits on the card: use the nearest edge
    var d = { left: px - L, right: R - px, top: py - T, bottom: B - py };
    var best = "left";
    for (var k in d) if (d[k] < d[best]) best = k;
    return best;
  }
  if (gx >= gy) return px < L ? "left" : "right";
  return py < T ? "top" : "bottom";
}

function sideAnchor(side, b) {
  var cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  if (side === "left") return { x: b.x, y: cy, dx: 1, dy: 0 };
  if (side === "right") return { x: b.x + b.width, y: cy, dx: -1, dy: 0 };
  if (side === "top") return { x: cx, y: b.y, dx: 0, dy: 1 };
  return { x: cx, y: b.y + b.height, dx: 0, dy: -1 };
}

// Vertices/segments in coordinates relative to the dot (0,0)
function buildLineNetwork(dx, dy, dir, style, end) {
  var horiz = dir.dx !== 0;
  var vertices, segments;

  if (style === "straight") {
    vertices = [{ x: 0, y: 0 }, { x: dx, y: dy }];
    segments = [{ start: 0, end: 1 }];
  } else if (style === "curve") {
    var k = Math.min(220, Math.max(24, 0.5 * Math.abs(horiz ? dx : dy)));
    vertices = [{ x: 0, y: 0 }, { x: dx, y: dy }];
    segments = [{
      start: 0, end: 1,
      tangentStart: { x: dir.dx * k, y: dir.dy * k },
      tangentEnd: { x: -dir.dx * k, y: -dir.dy * k },
    }];
  } else {
    var off = horiz ? dy : dx; // distance between the two parallel runs
    if (Math.abs(off) < 0.5) {
      vertices = [{ x: 0, y: 0 }, { x: dx, y: dy }];
      segments = [{ start: 0, end: 1 }];
    } else {
      var r = Math.min(12, Math.abs(horiz ? dx : dy) / 2, Math.abs(off) / 2);
      var c1, c2;
      if (horiz) { c1 = { x: dx / 2, y: 0 }; c2 = { x: dx / 2, y: dy }; }
      else { c1 = { x: 0, y: dy / 2 }; c2 = { x: dx, y: dy / 2 }; }
      if (r >= 0.5) { c1.cornerRadius = r; c2.cornerRadius = r; }
      vertices = [{ x: 0, y: 0 }, c1, c2, { x: dx, y: dy }];
      segments = [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }];
    }
  }

  var cap = end === "arrow" ? "ARROW_LINES" : (end === "dot" ? "CIRCLE_FILLED" : null);
  if (cap) vertices[vertices.length - 1].strokeCap = cap;
  return { vertices: vertices, segments: segments, regions: [] };
}

// Draws (or updates in place) the connector between an anchor dot and its card
async function drawConnector(dot, card, pairId, existing) {
  var db = dot.absoluteBoundingBox, cb = card.absoluteBoundingBox;
  if (!db || !cb) throw new Error("No bounding box for connector");
  var px = db.x + db.width / 2, py = db.y + db.height / 2;

  var anchor = sideAnchor(pickSide(px, py, cb), cb);
  var net = buildLineNetwork(anchor.x - px, anchor.y - py, anchor, lineStyle, lineEnd);

  var vector = existing;
  if (!vector) {
    vector = figma.createVector();
    vector.name = "Heap connector";
    vector.fills = [];
    vector.strokes = [{ type: "SOLID", color: hexToRgb(COLORS.accent) }];
    vector.strokeWeight = 1.5;
    vector.dashPattern = [5, 4];
    if (pairId) vector.setPluginData("pairId", pairId);

    // Sit just below the card (and above the design) so it never hides the card
    var top = card;
    while (top.parent && top.parent.type !== "PAGE") top = top.parent;
    var page = figma.currentPage;
    var idx = page.children.indexOf(top);
    if (idx >= 0) page.insertChild(idx, vector);
  }

  vector.x = px;
  vector.y = py;
  try {
    await vector.setVectorNetworkAsync(net);
  } catch (e) {
    // Retry without end caps in case the cap type is rejected
    for (var i = 0; i < net.vertices.length; i++) delete net.vertices[i].strokeCap;
    await vector.setVectorNetworkAsync(net);
  }

  // Figma may re-normalize the vector bounds: pin vertex 0 back onto the dot
  var v0 = vector.vectorNetwork.vertices[0];
  var t = vector.absoluteTransform;
  var ex = px - (t[0][0] * v0.x + t[0][1] * v0.y + t[0][2]);
  var ey = py - (t[1][0] * v0.x + t[1][1] * v0.y + t[1][2]);
  if (Math.abs(ex) > 0.01 || Math.abs(ey) > 0.01) {
    vector.x += ex;
    vector.y += ey;
  }

  return vector;
}

// ─── Refresh all connectors based on paired positions ────────────────
async function refreshConnectors(silent) {
  isRefreshing = true;
  var count = 0;

  try {
    var page = figma.currentPage;
    var pairs = collectPairNodes(page);

    if (pairs.dots.length === 0 || Object.keys(pairs.annByPair).length === 0) {
      if (!silent) figma.notify("No hay anotaciones Heap en esta página.");
      figma.ui.postMessage({ type: "refresh-done", count: 0 });
      return;
    }

    // Untagged connectors from older versions can't be paired: drop them
    for (var lc = 0; lc < pairs.legacyConnectors.length; lc++) {
      pairs.legacyConnectors[lc].remove();
    }

    // Redraw using pair IDs, reusing each pair's connector and snapping
    // anchored dots back onto their element
    var drawn = {};
    for (var d = 0; d < pairs.dots.length; d++) {
      var dot = pairs.dots[d];
      try { await repositionDot(dot); } catch (e) {}

      var dotPairId = dot.getPluginData("pairId");
      var paired = dotPairId ? pairs.annByPair[dotPairId] : null;
      if (!paired) continue;

      var conns = pairs.connsByPair[dotPairId] || [];
      for (var ce = 1; ce < conns.length; ce++) conns[ce].remove();

      try {
        await drawConnector(dot, paired, dotPairId, conns[0] || null);
        drawn[dotPairId] = true;
        count++;
      } catch (e) {
        console.error("Refresh line failed:", e);
      }
    }

    // Connectors whose dot or card no longer exists are orphans
    for (var pk in pairs.connsByPair) {
      if (drawn[pk] || (pairs.dotsByPair[pk] && pairs.annByPair[pk])) continue;
      var orphans = pairs.connsByPair[pk];
      for (var oc = 0; oc < orphans.length; oc++) orphans[oc].remove();
    }

    if (!silent) figma.notify("Se actualizaron " + count + " conectores");
    figma.ui.postMessage({ type: "refresh-done", count: count });
  } finally {
    isRefreshing = false;
  }

  rebuildHeapIndex();
}
