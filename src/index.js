import { connect } from "cloudflare:sockets";

const MQTT_PORT = 8883;
const MQTT_VERSION_3_1_1 = 4;
const MQTT_KEEPALIVE_SECONDS = 15;
const MAX_TIMEOUT_MS = 20000;
const DEFAULT_TIMEOUT_MS = 10000;
const USER_INFO_TIMEOUT_MS = 5000;

// Bambu's cloud API gateway rejects requests that don't look like the official
// client (typically HTTP 403), so every call mimics the OrcaSlicer network
// agent headers. Mirrors greghesp/ha-bambulab (pybambu) and the reference
// swzsweet/Bambu-print-status-monitoring project.
const BAMBU_API_HEADERS = {
  "User-Agent": "bambu_network_agent/01.09.05.01",
  "X-BBL-Client-Name": "OrcaSlicer",
  "X-BBL-Client-Type": "slicer",
  "X-BBL-Client-Version": "01.09.05.51",
  "X-BBL-Language": "en-US",
  "X-BBL-OS-Type": "linux",
  "X-BBL-OS-Version": "6.2.0",
  "X-BBL-Agent-Version": "01.09.05.01",
  "X-BBL-Executable-info": "{}",
  "X-BBL-Agent-OS-Type": "linux",
  accept: "application/json",
  "Content-Type": "application/json",
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "bambu-widget-worker" });
    }

    if (request.method !== "GET" || !["/", "/status", "/devices"].includes(url.pathname)) {
      return json({ ok: false, error: "NOT_FOUND" }, 404);
    }

    // The Bambu access token is the credential: the caller (e.g. Scriptable)
    // supplies it per request. Nothing sensitive is stored in the Worker.
    const token = tokenFromRequest(request, env);
    if (!token) {
      return json({
        ok: false,
        error: "MISSING_TOKEN",
        message: "Provide the Bambu access token via the X-Bambu-Token header (or Authorization: Bearer <token>).",
      }, 401);
    }

    if (url.pathname === "/devices") {
      return handleDevices(env, url, token);
    }

    try {
      const config = await readConfig(env, url, token);
      const useCache = Number(config.cacheTtlSeconds) > 0 && url.searchParams.get("force") !== "1";
      const includeRaw = url.searchParams.get("raw") === "1";
      const cacheKey = new Request(`https://bambu-widget-worker.local/status/${config.serial}?raw=${includeRaw}`);

      if (useCache) {
        const cached = await readCache(cacheKey);
        if (cached) return withCors(cached);
      }

      const snapshot = await fetchPrinterSnapshot(config, includeRaw);
      const response = json(snapshot);
      if (useCache) {
        ctx.waitUntil(writeCache(cacheKey, response.clone(), config.cacheTtlSeconds));
      }
      return response;
    } catch (error) {
      const status = error.statusCode || 502;
      return json({
        ok: false,
        error: error.code || "MQTT_ERROR",
        message: error.message || String(error),
        fetchedAt: new Date().toISOString(),
      }, status);
    }
  },
};

// GET /devices — list the printers bound to the account, so callers can pick a
// serial (dev_id) without connecting to MQTT.
async function handleDevices(env, url, token) {
  try {
    const region = (env.BAMBU_REGION || "Global").trim().toLowerCase();
    const apiBase = (env.BAMBU_API_BASE || defaultApiBase(region)).trim().replace(/\/+$/, "");

    const devices = await fetchDevicesFromBambuCloud(apiBase, token);
    return json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      count: devices.length,
      devices: devices.map((d) => ({
        name: d.name || null,
        serial: d.dev_id || null,
        online: Boolean(d.online),
        model: d.dev_product_name || d.dev_model_name || null,
        printStatus: d.print_status || null,
      })),
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.code || "DEVICES_ERROR",
      message: error.message || String(error),
      fetchedAt: new Date().toISOString(),
    }, error.statusCode || 502);
  }
}

async function fetchPrinterSnapshot(config, includeRaw) {
  const startedAt = Date.now();
  const client = new MinimalMqttClient({
    hostname: config.host,
    port: config.port,
    clientId: config.clientId,
    username: config.username,
    password: config.password,
  });

  const reportTopic = `device/${config.serial}/report`;
  const requestTopic = `device/${config.serial}/request`;
  const received = [];
  let latestPrint = null;
  let latestInfo = null;

  try {
    await client.connect(config.timeoutMs);
    await client.subscribe(reportTopic, config.timeoutMs);

    await client.publishJson(requestTopic, {
      pushing: { sequence_id: sequenceId(), command: "pushall" },
    });
    await client.publishJson(requestTopic, {
      info: { sequence_id: sequenceId(), command: "get_version" },
    });

    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) {
      const packet = await client.readPacket(deadline - Date.now());
      if (!packet) break;
      if (packet.type !== 3 || packet.topic !== reportTopic) continue;

      const payload = safeJsonParse(packet.payloadText);
      if (!payload) continue;

      const compact = compactPayload(payload);
      received.push(compact);

      if (payload.print) latestPrint = mergeDefined(latestPrint || {}, payload.print);
      if (payload.info) latestInfo = mergeDefined(latestInfo || {}, payload.info);

      if (latestPrint && hasPushallPayload(payload.print)) break;
    }

    if (!latestPrint && !latestInfo) {
      throw mqttError("MQTT_TIMEOUT", "Timed out before receiving a printer report packet.", 504);
    }

    const normalized = normalizePrinterStatus(latestPrint || {}, latestInfo || {}, config.deviceName);
    const snapshot = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      source: {
        host: config.host,
        serial: maskSerial(config.serial),
        reportTopic,
      },
      printer: normalized,
      receivedPackets: received.length,
    };

    if (includeRaw) {
      snapshot.raw = {
        print: latestPrint,
        info: latestInfo,
        received,
      };
    }

    return snapshot;
  } finally {
    await client.close();
  }
}

async function readConfig(env, url, token) {
  const password = token;
  const region = (env.BAMBU_REGION || "Global").trim().toLowerCase();
  const apiBase = (env.BAMBU_API_BASE || defaultApiBase(region)).trim().replace(/\/+$/, "");
  const host = (env.BAMBU_MQTT_HOST || defaultMqttHost(region)).trim();
  const port = Number(env.BAMBU_MQTT_PORT || MQTT_PORT);
  const timeoutMs = boundedNumber(url.searchParams.get("timeout") || env.REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
  const cacheTtlSeconds = boundedNumber(env.CACHE_TTL_SECONDS, 0, 0, 300);

  // The account's device list ("bind") gives us both the serial (dev_id) and,
  // when needed, is fetched alongside the uid. Only call it if we actually need
  // the serial, to avoid an extra round-trip when it is configured explicitly.
  const configuredSerial = (env.BAMBU_SERIAL || url.searchParams.get("serial") || "").trim();
  const username = await resolveMqttUsername(env, password, apiBase);

  let serial = configuredSerial;
  let deviceName = null;
  if (!serial) {
    const chosen = await resolveDevice(apiBase, password, url);
    serial = chosen.serial;
    deviceName = chosen.name;
  }

  return {
    serial,
    deviceName,
    username,
    password,
    host,
    port,
    timeoutMs,
    cacheTtlSeconds,
    clientId: env.BAMBU_MQTT_CLIENT_ID || randomClientId(),
  };
}

async function resolveMqttUsername(env, token, apiBase) {
  const configured = env.BAMBU_USERNAME
    ? mqttUsername(env.BAMBU_USERNAME, true)
    : mqttUsername(env.BAMBU_USER_ID || userIdFromJwt(token));
  if (configured) return configured;

  const uid = await fetchUserIdFromBambuCloud(apiBase, token);
  const username = mqttUsername(uid);
  if (username) return username;

  throw configError("Unable to derive Bambu MQTT username from BAMBU_ACCESS_TOKEN. The token may be expired, invalid, or for the wrong BAMBU_REGION.");
}

// Resolve the printer (serial + name) from the account's bound device list when
// no serial is configured. Picks a device matching ?name= if given, otherwise
// prefers an online printer, else the first bound device.
async function resolveDevice(apiBase, token, url) {
  const devices = await fetchDevicesFromBambuCloud(apiBase, token);
  if (!devices.length) {
    throw configError("No printers are bound to this Bambu account. Set BAMBU_SERIAL explicitly.");
  }

  const wanted = (url.searchParams.get("name") || "").trim().toLowerCase();
  const byName = wanted && devices.find((d) => String(d.name || "").toLowerCase() === wanted);
  const online = devices.find((d) => d.online);
  const chosen = byName || online || devices[0];

  const serial = String(chosen.dev_id || chosen.dev_serial || "").trim();
  if (!serial) {
    throw configError("Bound device did not include a serial (dev_id). Set BAMBU_SERIAL explicitly.");
  }
  return { serial, name: chosen.name || null };
}

function defaultMqttHost(region) {
  if (["cn", "china", "mainland", "mainland_china"].includes(region)) {
    return "cn.mqtt.bambulab.com";
  }
  return "us.mqtt.bambulab.com";
}

function defaultApiBase(region) {
  if (["cn", "china", "mainland", "mainland_china"].includes(region)) {
    return "https://api.bambulab.cn";
  }
  return "https://api.bambulab.com";
}

function requireEnv(env, key) {
  const value = env[key];
  if (!value || !String(value).trim()) {
    throw configError(`Missing ${key}.`);
  }
  return String(value);
}

function configError(message) {
  return mqttError("CONFIG_ERROR", message, 500);
}

// Read the Bambu access token from the request. Prefer the dedicated header,
// then Authorization: Bearer. Falls back to a Worker-stored token only if one
// is set (kept for backward compatibility / local testing).
function tokenFromRequest(request, env) {
  const explicit = request.headers.get("x-bambu-token") || "";
  const authValue = request.headers.get("authorization") || "";
  const bearer = authValue.toLowerCase().startsWith("bearer ") ? authValue.slice(7) : "";
  const fromEnv = env.BAMBU_ACCESS_TOKEN || env.BAMBU_AUTH_TOKEN || "";
  return normalizeAccessToken(explicit || bearer || fromEnv);
}

class MinimalMqttClient {
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.buffer = new Uint8Array(0);
    this.packetId = 1;
  }

  async connect(timeoutMs) {
    this.socket = connect(
      { hostname: this.options.hostname, port: this.options.port },
      { secureTransport: "on" },
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();

    await this.writePacket(connectPacket(this.options));
    const packet = await this.readPacket(timeoutMs);
    if (!packet || packet.type !== 2) {
      throw mqttError("MQTT_CONNACK_TIMEOUT", "Timed out waiting for MQTT CONNACK.", 504);
    }
    if (packet.returnCode !== 0) {
      throw mqttError("MQTT_CONNACK_FAILED", `MQTT broker rejected the connection with return code ${packet.returnCode}.`, 502);
    }
  }

  async subscribe(topic, timeoutMs) {
    const packetId = this.nextPacketId();
    await this.writePacket(subscribePacket(packetId, topic));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const packet = await this.readPacket(deadline - Date.now());
      if (!packet) break;
      if (packet.type === 9 && packet.packetId === packetId) {
        const grantedQos = packet.grantedQos?.[0];
        if (grantedQos === 0x80) {
          throw mqttError("MQTT_SUBSCRIBE_FAILED", `Broker rejected subscription to ${topic}.`, 502);
        }
        return;
      }
    }

    throw mqttError("MQTT_SUBACK_TIMEOUT", `Timed out waiting for SUBACK for ${topic}.`, 504);
  }

  async publishJson(topic, payload) {
    await this.writePacket(publishPacket(topic, JSON.stringify(payload)));
  }

  async writePacket(packet) {
    await this.writer.write(packet);
  }

  async readPacket(timeoutMs) {
    if (timeoutMs <= 0) return null;

    const firstByte = await this.readExact(1, timeoutMs);
    if (!firstByte) return null;

    let multiplier = 1;
    let remainingLength = 0;
    const startedAt = Date.now();

    for (let i = 0; i < 4; i += 1) {
      const byteBuffer = await this.readExact(1, Math.max(1, timeoutMs - (Date.now() - startedAt)));
      if (!byteBuffer) return null;
      const byte = byteBuffer[0];
      remainingLength += (byte & 127) * multiplier;
      if ((byte & 128) === 0) break;
      multiplier *= 128;
    }

    const body = await this.readExact(remainingLength, Math.max(1, timeoutMs - (Date.now() - startedAt)));
    if (!body) return null;

    return decodePacket(firstByte[0], body);
  }

  async readExact(size, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length < size) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;

      const result = await withTimeout(this.reader.read(), remainingMs);
      if (!result) return null;
      if (result.done) {
        throw mqttError("MQTT_SOCKET_CLOSED", "MQTT socket closed before the expected packet was received.", 502);
      }
      this.buffer = concatBytes(this.buffer, result.value);
    }

    const out = this.buffer.slice(0, size);
    this.buffer = this.buffer.slice(size);
    return out;
  }

  nextPacketId() {
    const id = this.packetId;
    this.packetId = this.packetId === 0xffff ? 1 : this.packetId + 1;
    return id;
  }

  async close() {
    try {
      if (this.writer) await this.writer.write(new Uint8Array([0xe0, 0x00]));
    } catch (_) {
      // Ignore disconnect failures; the request response has already been built.
    }
    try {
      if (this.writer) this.writer.releaseLock();
      if (this.reader) this.reader.releaseLock();
      if (this.socket) this.socket.close();
    } catch (_) {
      // Ignore cleanup failures.
    }
  }
}

function connectPacket({ clientId, username, password }) {
  const variableHeader = concatBytes(
    stringField("MQTT"),
    new Uint8Array([
      MQTT_VERSION_3_1_1,
      0xc2, // username + password + clean session
      MQTT_KEEPALIVE_SECONDS >> 8,
      MQTT_KEEPALIVE_SECONDS & 0xff,
    ]),
  );

  const payload = concatBytes(
    stringField(clientId),
    stringField(username),
    stringField(password),
  );

  return mqttPacket(1, 0, concatBytes(variableHeader, payload));
}

function subscribePacket(packetId, topic) {
  const variableHeader = new Uint8Array([packetId >> 8, packetId & 0xff]);
  const payload = concatBytes(stringField(topic), new Uint8Array([0x00]));
  return mqttPacket(8, 0x02, concatBytes(variableHeader, payload));
}

function publishPacket(topic, message) {
  return mqttPacket(3, 0, concatBytes(stringField(topic), textEncoder.encode(message)));
}

function mqttPacket(type, flags, body) {
  return concatBytes(
    new Uint8Array([(type << 4) | flags]),
    encodeRemainingLength(body.length),
    body,
  );
}

function decodePacket(firstByte, body) {
  const type = firstByte >> 4;
  if (type === 2) {
    return { type, sessionPresent: Boolean(body[0] & 0x01), returnCode: body[1] };
  }
  if (type === 3) {
    const topicLength = (body[0] << 8) | body[1];
    const topic = textDecoder.decode(body.slice(2, 2 + topicLength));
    const qos = (firstByte & 0x06) >> 1;
    const payloadOffset = qos > 0 ? 2 + topicLength + 2 : 2 + topicLength;
    const payload = body.slice(payloadOffset);
    return { type, topic, payload, payloadText: textDecoder.decode(payload) };
  }
  if (type === 9) {
    const packetId = (body[0] << 8) | body[1];
    return { type, packetId, grantedQos: Array.from(body.slice(2)) };
  }
  return { type, body };
}

function stringField(value) {
  const bytes = textEncoder.encode(String(value));
  return concatBytes(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes);
}

function encodeRemainingLength(length) {
  const bytes = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 128;
    bytes.push(digit);
  } while (length > 0);
  return new Uint8Array(bytes);
}

function concatBytes(...parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function normalizePrinterStatus(print, info, fallbackName = null) {
  const temperatures = {
    nozzle: temperaturePair(print.nozzle_temper, print.nozzle_target_temper),
    bed: temperaturePair(print.bed_temper, print.bed_target_temper),
    chamber: numberOrNull(print.chamber_temper),
  };

  return {
    name: print.dev_name || info.dev_name || fallbackName || null,
    online: true,
    state: print.gcode_state || print.print_status || null,
    stateLabel: stateLabel(print.gcode_state || print.print_status),
    subtaskName: print.subtask_name || null,
    progress: numberOrNull(print.mc_percent),
    remainingMinutes: numberOrNull(print.mc_remaining_time),
    layer: {
      current: numberOrNull(print.layer_num),
      total: numberOrNull(print.total_layer_num),
    },
    temperatures,
    fans: {
      cooling: numberOrNull(print.cooling_fan_speed),
      heatbreak: numberOrNull(print.heatbreak_fan_speed),
      auxiliary: numberOrNull(print.big_fan1_speed),
      chamber: numberOrNull(print.big_fan2_speed),
    },
    speed: {
      percent: numberOrNull(print.spd_mag),
      level: numberOrNull(print.spd_lvl),
    },
    ams: print.ams || null,
    trayNow: print.tray_now || null,
    wifiSignal: print.wifi_signal || null,
    errorCode: print.print_error || print.fail_reason || null,
    firmware: {
      otaVersion: info.ota_version || null,
      module: info.module || null,
    },
  };
}

function temperaturePair(current, target) {
  return {
    current: numberOrNull(current),
    target: numberOrNull(target),
  };
}

function stateLabel(state) {
  const labels = {
    RUNNING: "printing",
    PAUSE: "paused",
    PAUSED: "paused",
    FINISH: "finished",
    FAILED: "failed",
    IDLE: "idle",
    PREPARE: "preparing",
    SLICING: "slicing",
  };
  return labels[String(state || "").toUpperCase()] || null;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mergeDefined(previous, next) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

function hasPushallPayload(print) {
  return Boolean(
    print
    && (
      Object.prototype.hasOwnProperty.call(print, "mc_percent")
      || Object.prototype.hasOwnProperty.call(print, "gcode_state")
      || Object.prototype.hasOwnProperty.call(print, "bed_temper")
    )
  );
}

function compactPayload(payload) {
  const print = payload.print || {};
  const info = payload.info || {};
  return {
    type: payload.print ? "print" : payload.info ? "info" : "unknown",
    command: print.command || info.command || null,
    sequenceId: print.sequence_id || info.sequence_id || null,
    state: print.gcode_state || print.print_status || null,
    progress: numberOrNull(print.mc_percent),
    keys: Object.keys(payload),
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function normalizeAccessToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) return "";
  // Tolerate values pasted as `Bearer <token>` or wrapped in quotes.
  const withoutBearer = token.replace(/^bearer\s+/i, "").trim();
  return withoutBearer.replace(/^["']|["']$/g, "").trim();
}

function userIdFromJwt(token) {
  const parts = String(token).split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    // Bambu tokens carry the ready-to-use `u_<uid>` string in `username`;
    // prefer it, then fall back to any numeric-id claim.
    return payload.username || payload.preferred_username || payload.user_name || payload.user_id || payload.uid || payload.sub || null;
  } catch (_) {
    return null;
  }
}

async function fetchUserIdFromBambuCloud(apiBase, token) {
  const endpoints = [
    "/v1/design-user-service/my/preference",
    "/v1/user-service/my/profile",
  ];

  let lastMessage = "";
  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTimeout(`${apiBase}${endpoint}`, {
        headers: {
          ...BAMBU_API_HEADERS,
          authorization: `Bearer ${token}`,
        },
      }, USER_INFO_TIMEOUT_MS);

      const text = await response.text();
      const data = safeJsonParse(text);
      if (!response.ok) {
        lastMessage = `${endpoint} returned HTTP ${response.status}`;
        continue;
      }

      const uid = extractUserId(data);
      if (uid) return uid;
      lastMessage = `${endpoint} did not include uid`;
    } catch (error) {
      lastMessage = error.message || String(error);
    }
  }

  throw configError(`Unable to fetch Bambu user id from token. ${lastMessage}`);
}

// Fetch the account's bound printers. `dev_id` is the serial used for MQTT topics.
async function fetchDevicesFromBambuCloud(apiBase, token) {
  const endpoint = "/v1/iot-service/api/user/bind";
  let response;
  try {
    response = await fetchWithTimeout(`${apiBase}${endpoint}`, {
      headers: {
        ...BAMBU_API_HEADERS,
        authorization: `Bearer ${token}`,
      },
    }, USER_INFO_TIMEOUT_MS);
  } catch (error) {
    throw configError(`Unable to fetch bound devices from Bambu cloud: ${error.message || error}`);
  }

  const text = await response.text();
  const data = safeJsonParse(text);
  if (response.status === 401) {
    throw configError("Bambu access token is invalid or expired (HTTP 401).");
  }
  if (!response.ok) {
    throw configError(`Device list request returned HTTP ${response.status}.`);
  }

  const devices = Array.isArray(data?.devices) ? data.devices : [];
  return devices;
}

function extractUserId(value) {
  const direct = [
    value?.uid,
    value?.user_id,
    value?.userId,
    value?.data?.uid,
    value?.data?.user_id,
    value?.data?.userId,
    value?.preferred_username,
    value?.data?.preferred_username,
  ].find((candidate) => mqttUsername(candidate));

  if (direct) return direct;

  return findUserIdCandidate(value, 0);
}

function findUserIdCandidate(value, depth) {
  if (!value || typeof value !== "object" || depth > 4) return null;

  for (const [key, child] of Object.entries(value)) {
    if (["uid", "user_id", "userId", "preferred_username"].includes(key)) {
      const username = mqttUsername(child);
      if (username) return child;
    }
  }

  for (const child of Object.values(value)) {
    const found = findUserIdCandidate(child, depth + 1);
    if (found) return found;
  }

  return null;
}

function mqttUsername(value, allowRaw = false) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("u_")) return raw;
  if (/^\d+$/.test(raw)) return `u_${raw}`;
  return allowRaw ? raw : "";
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function sequenceId() {
  return String(Date.now());
}

function randomClientId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `bambu-${suffix}`;
}

function maskSerial(serial) {
  if (!serial || serial.length <= 6) return serial;
  return `${serial.slice(0, 3)}***${serial.slice(-3)}`;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function mqttError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readCache(key) {
  try {
    return await caches.default.match(key);
  } catch (_) {
    return null;
  }
}

async function writeCache(key, response, ttlSeconds) {
  try {
    const cached = new Response(response.body, response);
    cached.headers.set("Cache-Control", `private, max-age=${ttlSeconds}`);
    await caches.default.put(key, cached);
  } catch (_) {
    // Cache API is best effort; MQTT fetching still succeeds without it.
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

function withCors(response) {
  const wrapped = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders())) {
    wrapped.headers.set(key, value);
  }
  return wrapped;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key",
  };
}
