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
  menu.addAction("修改连接设置");
  menu.addDestructiveAction("清除连接设置");
  menu.addCancelAction("关闭");

  const result = await menu.presentAlert();

  if (result === 0) return "preview";
  if (result === 1) {
    const didSave = await editConnectionSettings();
    return didSave ? "preview" : "close";
  }
  if (result === 2) {
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

async function fetchStatus() {
  const req = new Request(RUNTIME_CONFIG.SERVICE_URL);
  req.method = "GET";
  req.headers = {
    "X-Bambu-Token": RUNTIME_CONFIG.BAMBU_TOKEN,
    Accept: "application/json",
  };
  req.timeoutInterval = 25;

  const json = await req.loadJSON();
  const statusCode = req.response?.statusCode || 0;

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP ${statusCode}`);
  }

  if (!json?.ok) {
    throw new Error(json?.message || json?.error || "接口未返回打印机状态");
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
  return `${n.toFixed(1)}°C`;
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
    FINISH:  { title: "打印完成", textColor: green },
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

function addProgressBar(parent, progress, width, height = 10) {
  const value = Math.max(0, Math.min(100, numberOrNull(progress) ?? 0));

  const track = parent.addStack();
  track.size = new Size(width, height);
  track.backgroundColor = new Color("#E6ECE7");
  track.cornerRadius = height / 2;

  const fill = track.addStack();
  const fillWidth = value <= 0 ? 0 : Math.max(height, Math.round(width * value / 100));
  fill.size = new Size(fillWidth, height);
  fill.backgroundColor = new Color(CONFIG.THEME_GREEN);
  fill.cornerRadius = height / 2;

  track.addSpacer();
  return track;
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

  // 大号百分比：数字不变，百分号变小
  const percentRow = left.addStack();
  percentRow.size = new Size(114, 38);
  percentRow.centerAlignContent();
  percentRow.addSpacer();

  const percentStack = percentRow.addStack();
  percentStack.bottomAlignContent();

  const pValue = numberOrNull(status.progress);
  const numText = addText(
    percentStack,
    pValue === null ? "--" : String(Math.round(pValue)),
    31,
    new Color(CONFIG.THEME_GREEN),
    "bold",
    true
  );
  numText.lineLimit = 1;
  numText.minimumScaleFactor = 0.72;

  percentStack.addSpacer(1);

  const percentSign = addText(
    percentStack,
    "%",
    15,
    new Color(CONFIG.THEME_GREEN),
    "bold",
    false
  );
  percentSign.lineLimit = 1;
  percentSign.minimumScaleFactor = 0.8;

  percentRow.addSpacer();

  left.addSpacer(6);

  // 进度条更宽更厚，和百分比比例更协调
  const barRow = left.addStack();
  barRow.size = new Size(114, 12);
  barRow.addSpacer();
  addProgressBar(barRow, status.progress, 106, 10);
  barRow.addSpacer();

  left.addSpacer(12);

  // 更醒目的预计完成时间
  const etaRow = left.addStack();
  etaRow.size = new Size(114, 24);
  etaRow.centerAlignContent();
  etaRow.addSpacer();
  addEtaPill(etaRow, estimateFinishTime(updateAt, status.remainingMinutes));
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
    value: formatPercent(status.speedPercent),
    subtitle: speedModeText(status.speedLevel),
  });

  return widget;
}

function buildSmallWidget(payload, options = {}) {
  const printer = payload.printer || {};
  const status = payload.status || {};
  const state = stateInfo(status.gcodeState);

  const widget = new ListWidget();
  widget.backgroundColor = new Color("#FFFFFF");
  widget.setPadding(12, 12, 12, 12);
  widget.refreshAfterDate = new Date(
    Date.now() + Math.max(5, CONFIG.REFRESH_MINUTES) * 60 * 1000
  );

  const updateAt = options.fromCache
    ? options.cacheSavedAt
    : (payload.fetchedAt || status.updatedAt);

  const titleRow = widget.addStack();
  titleRow.centerAlignContent();
  addText(titleRow, printer.name || CONFIG.WIDGET_TITLE_FALLBACK, 14, new Color("#111827"), "bold");
  titleRow.addSpacer(5);
  addText(titleRow, state.title, 10, state.textColor, "semibold");

  widget.addSpacer(10);

  const percentRow = widget.addStack();
  percentRow.centerAlignContent();
  percentRow.addSpacer();

  const percentStack = percentRow.addStack();
  percentStack.bottomAlignContent();

  const pValue = numberOrNull(status.progress);
  addText(
    percentStack,
    pValue === null ? "--" : String(Math.round(pValue)),
    30,
    new Color(CONFIG.THEME_GREEN),
    "bold",
    true
  );
  percentStack.addSpacer(1);
  addText(
    percentStack,
    "%",
    15,
    new Color(CONFIG.THEME_GREEN),
    "bold"
  );

  percentRow.addSpacer();

  widget.addSpacer(8);

  const barWrap = widget.addStack();
  barWrap.addSpacer();
  addProgressBar(barWrap, status.progress, 136, 10);
  barWrap.addSpacer();

  widget.addSpacer(10);

  const etaWrap = widget.addStack();
  etaWrap.addSpacer();
  addEtaPill(etaWrap, estimateFinishTime(updateAt, status.remainingMinutes));
  etaWrap.addSpacer();

  widget.addSpacer();

  const updateRow = widget.addStack();
  updateRow.centerAlignContent();
  addSymbol(updateRow, "clock", 8, new Color("#B0B7BF"));
  updateRow.addSpacer(3);
  addText(updateRow, `更新 ${formatClockTime(updateAt)}`, 8.5, new Color("#B0B7BF"), "medium");

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

  try {
    if (!config.runsInWidget) {
      const action = await showAppMenu();

      if (action === "close") {
        Script.complete();
        return;
      }
    }

    assertConfig();

    const result = await fetchStatus();
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
