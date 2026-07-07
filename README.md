# Bambu Widget Worker

Cloudflare Worker that temporarily connects to Bambu Lab cloud MQTT, asks the printer
for a fresh status snapshot, and exposes a small HTTP JSON endpoint for Scriptable.

## Endpoints

- `GET /status` or `GET /` - fetch printer status.
- `GET /status?force=1` - bypass the optional Worker cache.
- `GET /status?raw=1` - include raw `print` / `info` MQTT payloads for debugging.
- `GET /status?name=<printer name>` - when the account has several printers, pick one by name.
- `GET /devices` - list the printers bound to the account (name, serial, online, model). Does not connect to MQTT.
- `GET /health` - simple health check; the only endpoint that needs no token.

All endpoints except `/health` require the access token (see Authentication).

## Authentication

The **Bambu access token is the credential**, supplied by the caller on every
request — the Worker stores nothing sensitive. A request without a token gets
`401`, so only someone holding a valid token can read the printer.

Send the token in a request header (preferred, keeps it out of URLs and logs):

```http
X-Bambu-Token: <access token>
```

`Authorization: Bearer <access token>` is also accepted.

From the token alone the Worker automatically derives:

- the **MQTT username** (`u_<uid>`), from the token's JWT `username` claim, falling
  back to the Bambu cloud user-preference API; and
- the **printer serial**, from the account's bound-device list (`/devices`). If the
  account has more than one printer it prefers an online one; pin a specific printer
  with `?serial=`, `?name=`, or the `BAMBU_SERIAL` variable.

### Optional server-stored token

For local testing you may still set a token on the Worker; it is used only when a
request carries none. Leave it unset in production so the token stays client-side.

```bash
npx wrangler secret put BAMBU_ACCESS_TOKEN   # optional fallback only
```

Optional non-secret overrides (in `wrangler.toml` `[vars]` or as secrets):

```
BAMBU_SERIAL     # pin a specific printer serial
BAMBU_USERNAME   # full MQTT username, usually u_<user_id>
BAMBU_USER_ID    # numeric user id; converted to u_<user_id>
```

## Optional variables

Set these in `wrangler.toml` `[vars]` or as secrets:

- `BAMBU_REGION`: `Global` (default) uses `us.mqtt.bambulab.com`; `China` uses `cn.mqtt.bambulab.com`.
- `BAMBU_MQTT_HOST`: override the broker hostname directly.
- `BAMBU_MQTT_PORT`: defaults to `8883`.
- `REQUEST_TIMEOUT_MS`: MQTT request timeout, defaults to `10000`, capped at `20000`.
- `CACHE_TTL_SECONDS`: optional Cloudflare cache TTL, defaults to `0`; `20` is a practical widget value.

## Local and deploy

```bash
npm install
npm run check
npm run dev
npm run deploy
```

Local development needs Wrangler's Cloudflare runtime because the Worker uses
`cloudflare:sockets` for the TLS MQTT connection.

## JSON shape

Successful responses look like:

```json
{
  "ok": true,
  "fetchedAt": "2026-07-07T00:00:00.000Z",
  "durationMs": 1200,
  "source": {
    "host": "us.mqtt.bambulab.com",
    "serial": "ABC***XYZ",
    "reportTopic": "device/<serial>/report"
  },
  "printer": {
    "state": "RUNNING",
    "stateLabel": "printing",
    "subtaskName": "example.3mf",
    "progress": 42,
    "remainingMinutes": 123,
    "layer": { "current": 10, "total": 100 },
    "temperatures": {
      "nozzle": { "current": 220, "target": 220 },
      "bed": { "current": 60, "target": 60 },
      "chamber": 38
    },
    "ams": null
  },
  "receivedPackets": 1
}
```
