figma.showUI(__html__, { width: 360, height: 700, themeColors: true });

let exportTimer;
let highQualityTimer;
let exporting = false;
let pendingStage = null;
let lockedTargetId = null;
let lockedTarget = null;
let targetRevision = 0;

function selectedFrame() {
  const selected = figma.currentPage.selection;
  if (selected.length !== 1) return null;
  let node = selected[0];
  while (node.parent && node.parent.type !== "PAGE") node = node.parent;
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" ? node : null;
}

function previewTarget() {
  if (!lockedTargetId) return selectedFrame();
  return lockedTarget;
}

function sendSelection() {
  const node = previewTarget();
  const candidate = selectedFrame();
  figma.ui.postMessage({
    type: "selection",
    targetRevision,
    canSwitch: Boolean(lockedTargetId && candidate && candidate.id !== lockedTargetId),
    candidateName: candidate?.name || "",
    valid: Boolean(node),
    locked: Boolean(lockedTargetId),
    name: node?.name || "",
    width: node ? Math.round(node.width) : 0,
    height: node ? Math.round(node.height) : 0
  });
}

async function exportSelection(stage = "fast") {
  if (exporting) {
    pendingStage = stage;
    return;
  }
  const node = previewTarget();
  if (!node) {
    sendSelection();
    return;
  }
  const revision = targetRevision;
  exporting = true;
  try {
    const highQuality = stage === "high";
    const scale = highQuality ? 3 : 1;
    const bytes = await node.exportAsync({
      format: "JPG",
      constraint: { type: "SCALE", value: scale },
      quality: highQuality ? 0.9 : 0.68
    });
    if (revision !== targetRevision) return;
    figma.ui.postMessage({
      type: "frame",
      targetRevision: revision,
      bytes,
      mimeType: "image/jpeg",
      scale,
      stage,
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height)
    });
  } catch (error) {
    figma.ui.postMessage({ type: "error", message: String(error) });
  } finally {
    exporting = false;
    if (pendingStage) {
      const nextStage = pendingStage;
      pendingStage = null;
      setTimeout(() => exportSelection(nextStage), nextStage === "fast" ? 0 : 80);
    }
  }
}

function scheduleExport(delay = 80) {
  clearTimeout(exportTimer);
  clearTimeout(highQualityTimer);
  exportTimer = setTimeout(() => exportSelection("fast"), delay);
  highQualityTimer = setTimeout(() => exportSelection("high"), delay + 1000);
}

figma.on("selectionchange", () => {
  sendSelection();
  // Once preview starts, clicking elsewhere must not change the phone target.
  if (!lockedTargetId) scheduleExport(100);
});

figma.currentPage.on("nodechange", () => scheduleExport(80));

// The page-level event is quick, while documentchange also catches updates
// caused by styles, components and nested instances.
figma.loadAllPagesAsync()
  .then(() => figma.on("documentchange", () => scheduleExport(80)))
  .catch(error => figma.ui.postMessage({ type: "error", message: `无法监听设计修改：${String(error)}` }));

figma.ui.onmessage = message => {
  if (message.type === "ready") {
    figma.clientStorage.getAsync("serverUrl")
      .then(serverUrl => figma.ui.postMessage({ type: "settings", serverUrl: serverUrl || "" }))
      .catch(() => figma.ui.postMessage({ type: "settings", serverUrl: "" }));
  }
  if (message.type === "save-settings") {
    figma.clientStorage.setAsync("serverUrl", message.serverUrl).catch(() => {});
  }
  if (message.type === "start-preview" || message.type === "switch-preview") {
    const node = selectedFrame();
    if (!node) {
      sendSelection();
      return;
    }
    targetRevision += 1;
    pendingStage = null;
    lockedTargetId = node.id;
    lockedTarget = node;
    sendSelection();
    scheduleExport(0);
  }
  if (message.type === "request-frame") {
    if (!lockedTargetId) {
      const node = selectedFrame();
      if (node) {
        lockedTargetId = node.id;
        lockedTarget = node;
      }
    }
    scheduleExport(0);
  }
  if (message.type === "stop-preview") {
    targetRevision += 1;
    clearTimeout(exportTimer);
    clearTimeout(highQualityTimer);
    pendingStage = null;
    lockedTargetId = null;
    lockedTarget = null;
    sendSelection();
  }
  if (message.type === "set-compact") figma.ui.resize(message.compact ? 120 : 360, message.compact ? 48 : 700);
  if (message.type === "resize") figma.ui.resize(360, Math.max(440, Math.min(700, message.height)));
};

sendSelection();
