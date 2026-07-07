const CONFIG = {
  REFRESH_MINUTES: 6,
  MAX_LOCAL_CACHE_AGE_MINUTES: 120,
  WIDGET_TITLE_FALLBACK: "Bambu Lab",
  THEME_GREEN: "#00AE42",
  THEME_GREEN_DARK: "#00974A",
};

const KEYCHAIN_KEYS = {
  SERVICE_URL: "bambu_mqtt_widget_service_url_v9",
  BAMBU_TOKEN: "bambu_mqtt_widget_access_token_v9",
};

const CACHE_FILE = "bambu-mqtt-widget-cache-v8.json";

let RUNTIME_CONFIG = null;

// -------------------- 设置与凭证 --------------------

function getSavedConfig() {
  return {
    serviceUrl: Keychain.contains(KEYCHAIN_KEYS.SERVICE_URL)
      ? Keychain.get(KEYCHAIN_KEYS.SERVICE_URL)
      : "",
    bambuToken: Keychain.contains(KEYCHAIN_KEYS.BAMBU_TOKEN)
      ? Keychain.get(KEYCHAIN_KEYS.BAMBU_TOKEN)
      : "",
  };
}

function normalizeServiceUrl(value) {
  let url = String(value || "").trim().replace(/\/+$/, "");
  if (!url.startsWith("https://")) {
    throw new Error("Cloudflare Worker 地址必须以 https:// 开头");
  }
  if (url.endsWith("/api/bambu-status")) {
    url = url.replace(/\/api\/bambu-status$/, "/status");
  } else if (!url.endsWith("/status")) {
    url += "/status";
  }
  return url;
}

async function showMessage(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction("确定");
  await alert.presentAlert();
}

async function editConnectionSettings() {
  const saved = getSavedConfig();

  const alert = new Alert();
  alert.title = "Bambu Widget 设置";
  alert.message =
    "填写 Cloudflare Worker 地址和拓竹 Access Token。\n\n" +
    "只需填写域名，脚本会自动补全 /status。\n" +
    "Token 仅保存在此 iPhone 的 Keychain 中，不会写入脚本，\n" +
    "每次请求由本机发给 Worker，Worker 不存储它。";

  alert.addTextField(
    "Worker 地址",
    saved.serviceUrl.replace(/\/status$/, "").replace(/\/api\/bambu-status$/, "")
  );
  alert.addSecureTextField("拓竹 Access Token", saved.bambuToken);

  alert.addAction("保存");
  alert.addCancelAction("取消");

  const result = await alert.presentAlert();
  if (result === -1) return false;

  try {
    const serviceUrl = normalizeServiceUrl(alert.textFieldValue(0));
    const bambuToken = String(alert.textFieldValue(1) || "").trim();

    if (!bambuToken) {
      throw new Error("拓竹 Access Token 不能为空");
    }

    Keychain.set(KEYCHAIN_KEYS.SERVICE_URL, serviceUrl);
    Keychain.set(KEYCHAIN_KEYS.BAMBU_TOKEN, bambuToken);
    return true;
  } catch (error) {
    await showMessage("保存失败", error.message || String(error));
    return false;
  }
}

function clearConnectionSettings() {
  Object.values(KEYCHAIN_KEYS).forEach((key) => {
    if (Keychain.contains(key)) Keychain.remove(key);
  });
}

async function showAppMenu() {
  const saved = getSavedConfig();

  if (!saved.serviceUrl || !saved.bambuToken) {
    const didSave = await editConnectionSettings();
    return didSave ? "preview" : "close";
  }

  const menu = new Alert();
  menu.title = "Bambu Widget";
  menu.message = "连接配置已保存在本机 Keychain。";
  menu.addAction("预览小组件");
  menu.addAction("清除缓存并刷新");
  menu.addAction("修改连接设置");
  menu.addDestructiveAction("清除连接设置");
  menu.addCancelAction("关闭");

  const result = await menu.presentAlert();

  if (result === 0) return "preview";
  if (result === 1) {
    clearCache();
    return "refresh";
  }
  if (result === 2) {
    const didSave = await editConnectionSettings();
    return didSave ? "preview" : "close";
  }
  if (result === 3) {
    clearConnectionSettings();
    await showMessage("已清除", "Worker 地址和 Access Token 已从本机删除。");
  }
  return "close";
}

function assertConfig() {
  const saved = getSavedConfig();

  if (!saved.serviceUrl || !saved.bambuToken) {
    throw new Error("尚未配置接口。请在 Scriptable 中手动运行脚本后完成设置。");
  }

  RUNTIME_CONFIG = {
    SERVICE_URL: normalizeServiceUrl(saved.serviceUrl),
    BAMBU_TOKEN: saved.bambuToken,
  };
}

// -------------------- 缓存与接口 --------------------

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
}

function saveCache(payload) {
  const fm = FileManager.local();
  fm.writeString(
    cachePath(),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      payload,
    })
  );
}

function clearCache() {
  const fm = FileManager.local();
  const path = cachePath();
  if (fm.fileExists(path)) fm.remove(path);
}

function loadCache() {
  const fm = FileManager.local();
  const path = cachePath();

  if (!fm.fileExists(path)) return null;

  try {
    const cached = JSON.parse(fm.readString(path));
    const savedAt = new Date(cached?.savedAt).getTime();
    const maxAgeMs = CONFIG.MAX_LOCAL_CACHE_AGE_MINUTES * 60 * 1000;

    if (!cached?.payload || !Number.isFinite(savedAt)) return null;
    if (Date.now() - savedAt > maxAgeMs) return null;

    return cached;
  } catch (_) {
    return null;
  }
}

async function fetchStatus(options = {}) {
  let url = RUNTIME_CONFIG.SERVICE_URL;
  if (options.force) {
    // Also bypass the Worker-side cache so we get a truly fresh MQTT snapshot.
    url += url.includes("?") ? "&force=1" : "?force=1";
  }

  const req = new Request(url);
  req.method = "GET";
  req.headers = {
    "X-Bambu-Token": RUNTIME_CONFIG.BAMBU_TOKEN,
    Accept: "application/json",
  };
  req.timeoutInterval = 25;

  const json = await req.loadJSON();
  const statusCode = req.response?.statusCode || 0;

  // The Worker returns {ok:false, error, message} even on 4xx/5xx, so surface
  // that detail instead of a bare status code.
  if (!json?.ok) {
    const detail = json?.message || json?.error;
    if (detail) throw new Error(detail);
    throw new Error(statusCode ? `HTTP ${statusCode}` : "接口未返回打印机状态");
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP ${statusCode}`);
  }

  const payload = normalizeWorkerPayload(json);

  saveCache(payload);

  return {
    payload,
    fromCache: false,
    cacheSavedAt: null,
  };
}

function normalizeWorkerPayload(json) {
  if (json?.status) return json;

  const printer = json?.printer || {};
  const temperatures = printer.temperatures || {};
  const nozzle = temperatures.nozzle || {};
  const bed = temperatures.bed || {};
  const layer = printer.layer || {};
  const speed = printer.speed || {};

  return {
    ok: true,
    fetchedAt: json.fetchedAt,
    printer: {
      name: printer.name || CONFIG.WIDGET_TITLE_FALLBACK,
    },
    status: {
      updatedAt: json.fetchedAt,
      gcodeState: printer.state,
      progress: printer.progress,
      remainingMinutes: printer.remainingMinutes,
      nozzleTemp: nozzle.current,
      nozzleTargetTemp: nozzle.target,
      bedTemp: bed.current,
      bedTargetTemp: bed.target,
      currentLayer: layer.current,
      totalLayers: layer.total,
      speedPercent: speed.percent ?? printer.speedPercent,
      speedLevel: speed.level ?? printer.speedLevel,
    },
    raw: json.raw,
  };
}

// -------------------- 格式化 --------------------

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatTemperature(value) {
  const n = numberOrNull(value);
  if (n === null) return "--";
  return `${Math.round(n)}°C`;
}

function formatTempShort(value) {
  const n = numberOrNull(value);
  if (n === null) return "--°";
  return `${Math.round(n)}°`;
}

function formatPercent(value) {
  const n = numberOrNull(value);
  if (n === null) return "--%";
  return `${Math.round(n)}%`;
}

function formatInteger(value) {
  const n = numberOrNull(value);
  return n === null ? "--" : String(Math.round(n));
}

function formatClockTime(isoString) {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function estimateFinishTime(updatedAt, remainingMinutes) {
  const base = new Date(updatedAt).getTime();
  const remain = numberOrNull(remainingMinutes);

  if (!Number.isFinite(base)) return "--:--";
  if (remain === null || remain < 0) return "--:--";

  const finish = new Date(base + remain * 60 * 1000);
  return finish.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatRemaining(remainingMinutes) {
  const remain = numberOrNull(remainingMinutes);
  if (remain === null || remain < 0) return "--";
  if (remain < 60) return `${Math.round(remain)}m`;
  const hours = Math.floor(remain / 60);
  const mins = Math.round(remain % 60);
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

function formatSpeedShort(percent, level) {
  const p = numberOrNull(percent);
  if (p !== null) return `${Math.round(p)}%`;
  return speedModeText(level);
}

function speedModeText(level) {
  const n = numberOrNull(level);
  const map = { 1: "静音", 2: "标准", 3: "运动", 4: "狂暴" };
  return map[n] || "未知";
}

function stateInfo(rawState) {
  const state = String(rawState || "UNKNOWN").toUpperCase();

  const green = new Color(CONFIG.THEME_GREEN_DARK);
  const grayText = new Color("#6B7280");
  const orange = new Color("#C97A00");
  const red = new Color("#D94A5B");

  const map = {
    RUNNING: { title: "打印中", textColor: green },
    PREPARE: { title: "准备中", textColor: green },
    PAUSE:   { title: "已暂停", textColor: orange },
    FINISH:  { title: "成功", textColor: green, finished: true },
    FAILED:  { title: "打印失败", textColor: red },
    IDLE:    { title: "空闲", textColor: grayText },
  };

  return map[state] || { title: state || "未知", textColor: grayText };
}

// -------------------- UI 基础 --------------------

function addText(stack, value, size, color, weight = "regular", mono = false) {
  const text = stack.addText(String(value));

  if (mono) {
    text.font = weight === "bold"
      ? Font.boldMonospacedSystemFont(size)
      : Font.regularMonospacedSystemFont(size);
  } else {
    if (weight === "bold") text.font = Font.boldSystemFont(size);
    else if (weight === "semibold") text.font = Font.semiboldSystemFont(size);
    else if (weight === "medium") text.font = Font.mediumSystemFont(size);
    else text.font = Font.systemFont(size);
  }

  text.textColor = color;
  return text;
}

function addSymbol(stack, name, size, color) {
  const symbol = SFSymbol.named(name);
  if (!symbol) return null;
  symbol.applyFont(Font.systemFont(size));
  const image = stack.addImage(symbol.image);
  image.imageSize = new Size(size, size);
  image.tintColor = color;
  return image;
}

function addInfoCard(parent, options) {
  const { icon, iconColor, label, value, subtitle } = options;

  const card = parent.addStack();
  card.layoutVertically();
  card.backgroundColor = new Color("#F7F8FA");
  card.cornerRadius = 14;
  card.setPadding(8, 10, 8, 10);
  card.size = new Size(96, 62);

  const top = card.addStack();
  top.centerAlignContent();

  addSymbol(top, icon, 11, iconColor);
  top.addSpacer(5);

  const labelText = addText(top, label, 10, new Color("#7C8792"), "medium");
  labelText.lineLimit = 1;
  labelText.minimumScaleFactor = 0.72;

  card.addSpacer(3);

  const valueText = addText(card, value, 15, new Color("#111827"), "bold", true);
  valueText.lineLimit = 1;
  valueText.minimumScaleFactor = 0.76;

  card.addSpacer(1);

  const subText = addText(card, subtitle, 10, new Color("#B0B7BF"), "medium");
  subText.lineLimit = 1;
  subText.minimumScaleFactor = 0.76;

  return card;
}

function addEtaPill(parent, timeText) {
  const pill = parent.addStack();
  pill.centerAlignContent();
  pill.backgroundColor = new Color("#E8F7EE");
  pill.cornerRadius = 999;
  pill.setPadding(5, 10, 5, 10);

  addSymbol(pill, "flag.checkered", 10, new Color(CONFIG.THEME_GREEN_DARK));
  pill.addSpacer(4);

  const label = addText(
    pill,
    `预计完成 ${timeText}`,
    10,
    new Color(CONFIG.THEME_GREEN_DARK),
    "semibold"
  );
  label.lineLimit = 1;
  label.minimumScaleFactor = 0.72;

  return pill;
}

// -------------------- 布局 --------------------

function buildMediumWidget(payload, options = {}) {
  const printer = payload.printer || {};
  const status = payload.status || {};
  const state = stateInfo(status.gcodeState);

  const widget = new ListWidget();
  widget.backgroundColor = new Color("#FFFFFF");
  widget.setPadding(6, 8, 6, 8);
  widget.refreshAfterDate = new Date(
    Date.now() + Math.max(5, CONFIG.REFRESH_MINUTES) * 60 * 1000
  );

  const black = new Color("#111827");
  const lightGray = new Color("#B0B7BF");
  const updateAt = options.fromCache
    ? options.cacheSavedAt
    : (payload.fetchedAt || status.updatedAt);

  const root = widget.addStack();
  root.layoutHorizontally();
  root.centerAlignContent();
  root.size = new Size(0, 140);

  // 左侧
  const left = root.addStack();
  left.layoutVertically();
  left.size = new Size(114, 140);

  const titleRow = left.addStack();
  titleRow.centerAlignContent();
  titleRow.size = new Size(114, 20);

  const printerName = addText(
    titleRow,
    printer.name || CONFIG.WIDGET_TITLE_FALLBACK,
    16,
    black,
    "bold"
  );
  printerName.lineLimit = 1;
  printerName.minimumScaleFactor = 0.72;

  titleRow.addSpacer(5);

  const inlineState = addText(
    titleRow,
    state.title,
    10,
    state.textColor,
    "semibold"
  );
  inlineState.lineLimit = 1;
  inlineState.minimumScaleFactor = 0.7;

  left.addSpacer(6);

  // 圆环进度（百分比居中），替代原来的横条进度条
  const ringRow = left.addStack();
  ringRow.size = new Size(114, 72);
  ringRow.addSpacer();
  const ring = ringRow.addImage(drawPercentRingImage(status.progress, 200));
  ring.imageSize = new Size(72, 72);
  ringRow.addSpacer();

  left.addSpacer(4);

  // 更醒目的预计完成时间（打印成功后隐藏）
  const etaRow = left.addStack();
  etaRow.size = new Size(114, 24);
  etaRow.centerAlignContent();
  etaRow.addSpacer();
  if (!state.finished) {
    addEtaPill(etaRow, estimateFinishTime(updateAt, status.remainingMinutes));
  }
  etaRow.addSpacer();

  left.addSpacer();

  const updateRow = left.addStack();
  updateRow.centerAlignContent();
  updateRow.size = new Size(114, 11);

  addSymbol(updateRow, "clock", 8, lightGray);
  updateRow.addSpacer(3);

  const updateText = addText(
    updateRow,
    `更新 ${formatClockTime(updateAt)}`,
    8.5,
    lightGray,
    "medium"
  );
  updateText.lineLimit = 1;
  updateText.minimumScaleFactor = 0.68;

  root.addSpacer(9);

  const divider = root.addStack();
  divider.size = new Size(1, 140);
  divider.backgroundColor = new Color("#E6E8EB");
  divider.cornerRadius = 1;

  root.addSpacer(9);

  // 右侧
  const right = root.addStack();
  right.layoutVertically();
  right.size = new Size(196, 140);

  const nozzleTarget = numberOrNull(status.nozzleTargetTemp);
  const bedTarget = numberOrNull(status.bedTargetTemp);
  const nozzleSub = nozzleTarget && nozzleTarget > 0 ? `目标 ${Math.round(nozzleTarget)}°C` : "已冷却";
  const bedSub = bedTarget && bedTarget > 0 ? `目标 ${Math.round(bedTarget)}°C` : "已冷却";

  const row1 = right.addStack();
  row1.layoutHorizontally();
  row1.size = new Size(196, 62);

  addInfoCard(row1, {
    icon: "thermometer.medium",
    iconColor: new Color("#FF7A00"),
    label: "喷嘴温度",
    value: formatTemperature(status.nozzleTemp),
    subtitle: nozzleSub,
  });

  row1.addSpacer(6);

  addInfoCard(row1, {
    icon: "thermometer.low",
    iconColor: new Color("#2D8CFF"),
    label: "热床温度",
    value: formatTemperature(status.bedTemp),
    subtitle: bedSub,
  });

  right.addSpacer(8);

  const row2 = right.addStack();
  row2.layoutHorizontally();
  row2.size = new Size(196, 62);

  addInfoCard(row2, {
    icon: "square.3.layers.3d",
    iconColor: new Color("#8A4FFF"),
    label: "打印层数",
    value: formatInteger(status.currentLayer),
    subtitle: `共 ${formatInteger(status.totalLayers)} 层`,
  });

  row2.addSpacer(6);

  addInfoCard(row2, {
    icon: "bolt.fill",
    iconColor: new Color("#FF8A1D"),
    label: "打印速度",
    value: speedModeText(status.speedLevel),
    subtitle: formatPercent(status.speedPercent),
  });

  return widget;
}

// Small widget: progress ring with four corner stats and a big centered
// percentage. Stacks can't draw arcs, so the whole face is rendered as an
// image via DrawContext and set as the widget background.
function drawSmallRingImage(payload, state) {
  const status = payload.status || {};

  const S = 300;               // canvas size (points, rendered @1x here)
  const ctx = new DrawContext();
  ctx.size = new Size(S, S);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const green = new Color(CONFIG.THEME_GREEN);
  const trackColor = new Color("#E4F3E9");
  const dark = new Color("#1F2937");
  const gray = new Color("#AEB6BF");
  const orange = new Color("#FF7A00");
  const blue = new Color("#F0A500");

  // ---- progress ring ----
  const cx = S / 2;
  const cy = S / 2 + 4;
  const radius = 98;
  const lineWidth = 12;
  const pValue = Math.max(0, Math.min(100, numberOrNull(status.progress) ?? 0));
  drawRing(ctx, cx, cy, radius, lineWidth, trackColor, green, pValue / 100);

  // ---- center: big percent (number + smaller %) ----
  const pText = numberOrNull(status.progress) === null ? "--" : String(Math.round(pValue));
  const pctW = 20;
  const gap = 2;
  // Anchor the number+% group so it reads centered: right-align the number to
  // just left of the anchor, put "%" right after it. Independent of digit width.
  const anchorX = cx + pctW / 2 + 1;
  ctx.setFont(Font.boldSystemFont(52));
  ctx.setTextColor(dark);
  ctx.setTextAlignedRight();
  ctx.drawTextInRect(pText, new Rect(anchorX - 140, cy - 40, 140, 62));
  ctx.setFont(Font.boldSystemFont(20));
  ctx.setTextColor(gray);
  ctx.setTextAlignedLeft();
  ctx.drawTextInRect("%", new Rect(anchorX + gap, cy - 12, pctW + 6, 28));

  // state dot + label (centered group)
  drawStateLine(ctx, cx, cy + 20, state.title || "", state.textColor);

  if (!state.finished) {
    const remainText = `剩余 ${formatRemaining(status.remainingMinutes)}`;
    ctx.setFont(Font.systemFont(14));
    ctx.setTextColor(gray);
    ctx.setTextAlignedCenter();
    ctx.drawTextInRect(remainText, new Rect(cx - 90, cy + 44, 180, 20));
  }

  // ---- four corners ----
  const pad = 26;
  // top-left: nozzle
  drawCorner(ctx, pad, pad, "喷嘴", formatTempShort(status.nozzleTemp), orange, "left");
  // top-right: bed
  drawCorner(ctx, S - pad, pad, "热床", formatTempShort(status.bedTemp), blue, "right");
  // bottom-left: layers
  drawCorner(
    ctx, pad, S - pad - 40,
    "层数",
    `${formatInteger(status.currentLayer)}`,
    dark, "left",
    `/${formatInteger(status.totalLayers)}`
  );
  // bottom-right: speed
  drawCorner(ctx, S - pad, S - pad - 40, "速度", formatSpeedShort(status.speedPercent, status.speedLevel), green, "right");

  return ctx.getImage();
}

// Compact ring with the percentage centered inside — used in the medium
// widget's left column in place of the old horizontal progress bar.
function drawPercentRingImage(progress, size = 200) {
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const green = new Color(CONFIG.THEME_GREEN);
  const trackColor = new Color("#E4F3E9");
  const dark = new Color("#1F2937");
  const gray = new Color("#AEB6BF");

  const cx = size / 2;
  const cy = size / 2;
  const lineWidth = 14;
  const radius = cx - lineWidth / 2 - 4;
  const pValue = Math.max(0, Math.min(100, numberOrNull(progress) ?? 0));
  drawRing(ctx, cx, cy, radius, lineWidth, trackColor, green, pValue / 100);

  const pText = numberOrNull(progress) === null ? "--" : String(Math.round(pValue));
  const pctW = 22;
  const anchorX = cx + pctW / 2 + 1;
  ctx.setFont(Font.boldSystemFont(54));
  ctx.setTextColor(dark);
  ctx.setTextAlignedRight();
  ctx.drawTextInRect(pText, new Rect(anchorX - 150, cy - 40, 150, 64));
  ctx.setFont(Font.boldSystemFont(22));
  ctx.setTextColor(gray);
  ctx.setTextAlignedLeft();
  ctx.drawTextInRect("%", new Rect(anchorX + 2, cy - 10, pctW + 8, 30));

  return ctx.getImage();
}

function drawRing(ctx, cx, cy, radius, lineWidth, trackColor, fillColor, fraction) {
  // Track (full circle)
  const steps = 180;
  ctx.setLineWidth(lineWidth);
  strokeArc(ctx, cx, cy, radius, -90, 270, trackColor, lineWidth, steps);
  // Fill (from top clockwise)
  const endAngle = -90 + 360 * Math.max(0, Math.min(1, fraction));
  if (fraction > 0) {
    strokeArc(ctx, cx, cy, radius, -90, endAngle, fillColor, lineWidth, Math.max(2, Math.round(steps * fraction)));
  }
}

// Approximate an arc with a series of filled dots (DrawContext has no arc API).
function strokeArc(ctx, cx, cy, radius, startDeg, endDeg, color, width, steps) {
  ctx.setFillColor(color);
  const total = endDeg - startDeg;
  const n = Math.max(2, steps);
  for (let i = 0; i <= n; i += 1) {
    const deg = startDeg + (total * i) / n;
    const rad = (deg * Math.PI) / 180;
    const x = cx + radius * Math.cos(rad);
    const y = cy + radius * Math.sin(rad);
    ctx.fillEllipse(new Rect(x - width / 2, y - width / 2, width, width));
  }
}

// Rough text-width estimate. CJK glyphs are ~1em wide, ASCII ~0.55em.
function measureWidth(text, size) {
  let units = 0;
  for (const ch of String(text)) {
    units += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.56;
  }
  return units * size;
}

function drawStateLine(ctx, cx, y, label, color) {
  // dot + label, centered as a group
  const fontSize = 15;
  const dot = 8;
  const dotGap = 6;
  const labelW = measureWidth(label, fontSize);
  const groupW = dot + dotGap + labelW;
  const startX = cx - groupW / 2;
  ctx.setFillColor(color);
  ctx.fillEllipse(new Rect(startX, y + 3, dot, dot));
  ctx.setFont(Font.semiboldSystemFont(fontSize));
  ctx.setTextColor(color);
  ctx.setTextAlignedLeft();
  ctx.drawTextInRect(label, new Rect(startX + dot + dotGap, y - 3, labelW + 8, 22));
}

function drawCorner(ctx, x, y, label, value, valueColor, align, faint) {
  const labelFont = Font.mediumSystemFont(14);
  const valueFont = Font.boldSystemFont(22);
  const labelColor = new Color("#8A939C");
  const w = 120;

  ctx.setFont(labelFont);
  ctx.setTextColor(labelColor);
  if (align === "left") {
    ctx.setTextAlignedLeft();
    ctx.drawTextInRect(label, new Rect(x, y, w, 18));
    ctx.setFont(valueFont);
    ctx.setTextColor(valueColor);
    ctx.drawTextInRect(value, new Rect(x, y + 18, w, 26));
    if (faint) {
      ctx.setFont(Font.mediumSystemFont(13));
      ctx.setTextColor(new Color("#C7CDD3"));
      const vw = measureWidth(value, 22) + 3;
      ctx.drawTextInRect(faint, new Rect(x + vw, y + 26, w, 20));
    }
  } else {
    ctx.setTextAlignedRight();
    ctx.drawTextInRect(label, new Rect(x - w, y, w, 18));
    ctx.setFont(valueFont);
    ctx.setTextColor(valueColor);
    ctx.drawTextInRect(value, new Rect(x - w, y + 18, w, 26));
  }
}

function buildSmallWidget(payload, options = {}) {
  const status = payload.status || {};
  const state = stateInfo(status.gcodeState);

  const widget = new ListWidget();
  widget.backgroundColor = new Color("#FFFFFF");
  widget.setPadding(0, 0, 0, 0);
  widget.refreshAfterDate = new Date(
    Date.now() + Math.max(5, CONFIG.REFRESH_MINUTES) * 60 * 1000
  );

  const image = drawSmallRingImage(payload, state);
  widget.backgroundImage = image;

  return widget;
}

function buildErrorWidget(error) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#FFFFFF");
  widget.setPadding(14, 14, 14, 14);

  addText(widget, "Bambu Lab", 15, new Color("#111827"), "bold");
  widget.addSpacer(12);
  addText(widget, "连接失败", 22, new Color("#D94A5B"), "bold");
  widget.addSpacer(6);

  const detail = addText(
    widget,
    error?.message || String(error || "未知错误"),
    11,
    new Color("#7C8792"),
    "regular"
  );
  detail.lineLimit = 5;

  widget.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
  return widget;
}

function buildWidget(payload, options = {}) {
  return config.widgetFamily === "small"
    ? buildSmallWidget(payload, options)
    : buildMediumWidget(payload, options);
}

// -------------------- 运行入口 --------------------

async function main() {
  let widget;

  let forceRefresh = false;

  try {
    if (!config.runsInWidget) {
      const action = await showAppMenu();

      if (action === "close") {
        Script.complete();
        return;
      }
      if (action === "refresh") forceRefresh = true;
    }

    assertConfig();

    const result = await fetchStatus({ force: forceRefresh });
    widget = buildWidget(result.payload, result);
  } catch (error) {
    const cached = loadCache();

    widget = cached?.payload
      ? buildWidget(cached.payload, {
          fromCache: true,
          cacheSavedAt: cached.savedAt,
        })
      : buildErrorWidget(error);
  }

  Script.setWidget(widget);

  if (!config.runsInWidget) {
    if (config.widgetFamily === "small") {
      await widget.presentSmall();
    } else {
      await widget.presentMedium();
    }
  }

  Script.complete();
}

await main();
