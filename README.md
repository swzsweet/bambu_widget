# Bambu Widget Worker

Cloudflare Worker that temporarily connects to Bambu Lab cloud MQTT, asks the printer
for a fresh status snapshot, and exposes a small HTTP JSON endpoint for Scriptable.

## Endpoints

- `GET /status` or `GET /` - fetch printer status.
- `GET /status?force=1` - bypass the optional Worker cache.
- `GET /status?raw=1` - include raw `print` / `info` MQTT payloads for debugging.
- `GET /health` - simple health check that does not connect to MQTT.

## Required configuration

Set these as Worker secrets:

```bash
npx wrangler secret put BAMBU_SERIAL
npx wrangler secret put BAMBU_ACCESS_TOKEN
npx wrangler secret put BAMBU_USERNAME
```

Recommended optional secret:

```bash
npx wrangler secret put API_KEY
```

When `API_KEY` is set, requests must include either:

```http
Authorization: Bearer <API_KEY>
```

or:

```http
x-api-key: <API_KEY>
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
