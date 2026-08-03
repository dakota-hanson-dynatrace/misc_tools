# Extreme Networks Production DQL Dashboard — Technical Audit

**Dashboard:** "Extreme Networks | Network Monitoring — Production DQL"
**Dashboard ID:** `bbfbade8-e319-46f9-85f0-99dd35213274`
**Dashboard URL:** https://demo.apps.dynatrace.com/ui/apps/dynatrace.dashboards/dashboard/bbfbade8-e319-46f9-85f0-99dd35213274
**Local file:** `C:\Users\tim.dolan\Desktop\extreme-network-dashboard-production.json`
**Audit date:** 2026-07-31
**Auditor perspective:** Senior Network Engineer / Network Observability Architect with Extreme Networks and XIQ experience

---

## Data Collection Stack (production environment)

| Source | Data type | DQL access |
|--------|-----------|------------|
| Generic Network Extension (SNMPv3) | `ext:network.device.*`, `ext:network.interface.*` metrics | `timeseries` |
| ExtremeCloud IQ API workflow | AP/client snapshots pushed as bizevents | `fetch bizevents` |
| Extreme EMS syslog | Client events, link events, wireless events | `fetch logs` |
| SNMP Traps | Link-down, auth failure traps | `fetch logs \| filter log.source == "snmp-trap"` |
| NetFlow | Per-flow records | `fetch events \| filter event.kind == "FLEET_EVENT"` |

---

## P1 — Critical Issues (tiles return wrong data or no data)

### 1. `disconnect.count` and `auth.failure.count` do not exist in XIQ API v1

**Affected tiles:** 31, 32, 35, 36

The ExtremeCloud IQ REST API v1 does NOT expose disconnect counts or auth failure counts at the device/AP level via any polling endpoint. These are only available via the XIQ WebSocket/event stream — not the REST API used by the workflow.

- All four tiles must be rebuilt using syslog sources (`fetch logs`)
- Disconnect events: filter on `WM.ClientLeave`
- Auth failure events: filter on `WM.AuthFailure`

**Additional problem:** Even if these fields existed, they would be cumulative running totals (not per-interval deltas). The current queries use `sum()` over 2 hours which multiplies the running counter by the number of poll events (~24), overcounting by a factor of ~500. For cumulative counters, use `max(field) - min(field)` grouped by entity. For syslog-based event counts, use `count()` directly.

**Corrected queries for syslog approach:**
```dql
-- Tile 31/33: Disconnect KPI
fetch logs, from:now()-2h, scanLimitGBytes:-1
| filter contains(content, "WM.ClientLeave")
| summarize total_disconnects = count()

-- Tile 32: Auth failure KPI
fetch logs, from:now()-2h, scanLimitGBytes:-1
| filter contains(content, "WM.AuthFailure")
| summarize total_auth_failures = count()

-- Tile 35: Disconnect rate timeseries
fetch logs, from:now()-2h, scanLimitGBytes:-1
| filter contains(content, "WM.ClientLeave")
| makeTimeseries disconnects = count(), interval:5m

-- Tile 36: Auth failure rate timeseries
fetch logs, from:now()-2h, scanLimitGBytes:-1
| filter contains(content, "WM.AuthFailure")
| makeTimeseries auth_failures = count(), interval:5m
```

---

### 2. All syslog filter keywords are wrong for ExtremeXOS

**Affected tiles:** 33, 34, 37, 38, 39

ExtremeXOS structures syslog using module-prefixed message IDs. The wireless manager module prefix is `WM.`. None of the filter keywords currently in the dashboard match actual ExtremeXOS syslog output.

| Current (wrong) | Correct ExtremeXOS identifier |
|---|---|
| `CLIENT_ROAM` | `WM.ClientRoam` |
| `CLIENT_DISCONNECT` | `WM.ClientLeave` |
| `DHCP_FAIL` | `WM.DHCPFailure` |
| `AUTH_FAIL` | `WM.AuthFailure` |
| `ASSOC_FAIL` | `WM.AssocReject` (verify against firmware) |
| `DEAUTH` | `WM.Deauth` (verify) |

All `contains(content, "...")` filters in syslog tiles must be updated to the correct identifiers above.

**Additional note (Tile 37 — Roaming by AP):** The syslog source for roaming events is the ExtremeCloud IQ Campus Controller, not individual APs. Therefore `host.name` is the controller hostname for ALL roaming events. The `summarize by:{host.name}` grouping collapses all events to a single row (the controller). To get per-AP breakdown, parse the AP name from the message content using `parseLogs()` or regex.

---

### 3. `ap.status == "ONLINE"` is wrong

**Affected tile:** 3 (Access Points Online)

The XIQ REST API v1 `/devices` endpoint does NOT return a `status` field with value `"ONLINE"`. The connectivity indicator is either:
- A boolean field `connected: true/false`, OR
- A string field `device_status` with value `"CONNECTED"` / `"DISCONNECTED"`

The workflow must be checked to see what value it emits in the `ap.status` field. The filter `ap.status == "ONLINE"` will never match and the tile will always show 0.

**Also:** The bizevents window is `from:now()-10m`. If the XIQ workflow polls every 15 minutes (common for API rate limiting), this window misses entire cycles and intermittently shows 0.

**Fix:** Change filter value from `"ONLINE"` to `"CONNECTED"` (or whatever the workflow emits). Change window to `from:now()-20m` as a safe minimum.

---

### 4. Uptime divisor may be wrong — SNMP centisecond error

**Affected tiles:** 14, 19

SNMP `sysUpTime` (OID `1.3.6.1.2.1.1.3.0`) is defined in RFC 1213 as **centiseconds** (hundredths of a second). A device up for 10 days reports `86,400,000 centiseconds`. Dividing by `86400` yields `1000` days — off by a factor of 100.

**Must verify:** Check the Generic Network Extension metric definition in Dynatrace UI (Extensions > [extension] > Metrics > `ext:network.device.uptime` > Unit). If unit shows "count" or "timeticks", the extension emits raw centiseconds and the correct divisor is `8,640,000`. If unit shows "second", the extension converts internally and `86400` is correct.

```dql
-- If centiseconds (raw SNMP):
uptime_days = arrayLast(uptime) / 8640000

-- If seconds (extension-converted):
uptime_days = arrayLast(uptime) / 86400
```

---

## P2 — Plausible but Misleading Data

### 5. XIQ API field names don't match bizevent assumptions

**Affected tiles:** 3, 21, 22, 23, 24, 25, 26

The workflow pushes bizevents from XIQ API responses. The dashboard assumes field names that don't match actual XIQ API v1 response keys. The workflow must remap:

| Dashboard field assumed | Real XIQ API v1 field | XIQ endpoint |
|---|---|---|
| `client.count` | `connected_clients` | `GET /devices/{id}/stats` |
| `ap.name` | `hostname` | `GET /devices` |
| `ap.serial` | `serial_number` | `GET /devices` |
| `rssi` | No direct AP-level RSSI field | See note below |
| `site.name` | Requires `GET /locations/{location_id}` | Multi-call |

**RSSI note:** The XIQ API does not expose an AP-level average RSSI field in the standard `/devices/{id}/stats` response. RSSI is a per-client field from `GET /clients`. If per-AP average RSSI is needed, the workflow must compute it from per-client data. Consider replacing with `channel_utilization` which IS available from `/devices/{id}/stats`.

**site.name note:** XIQ `/devices` returns a `location_id` (integer). Getting the human-readable site name requires a second API call to `GET /locations/{location_id}`. The workflow must resolve this and emit `site.name` as a string. If not implemented, this column is always null.

---

### 6. `ext:network.interface.utilization` may not exist

**Affected tile:** 8

The Dynatrace Generic Network Extension EF2.0 typically exposes raw SNMP counter metrics (`ifInOctets`, `ifOutOctets`) rather than pre-computed utilization percentages. `ext:network.interface.utilization` is not a guaranteed metric key.

**Verify:** Check Extensions > [extension] > Metrics tab. If the metric exists, the query is valid. If not, compute utilization:
```dql
-- Derived utilization (requires bitrate and speed metrics):
timeseries {
  bitrate_in = avg(ext:network.interface.bitrate.in),
  speed = avg(ext:network.interface.speed)
}, from:now()-2h, by:{device.name, if.name}
| fieldsAdd utilization = bitrate_in / speed * 100
```

**Also:** Use `max()` instead of `avg()` per device for saturation detection — averaging across all interfaces (many near-idle access ports + one loaded uplink) underreports the real bottleneck.

---

### 7. `vendor:extreme-networks` tag not auto-applied

**Affected tile:** 5 (Active Alerts)

The Generic Network Extension EF2.0 does NOT automatically apply a `vendor:extreme-networks` tag to custom device entities. Tags are derived from the extension configuration (host group, custom properties). The tag value used in the filter must match whatever is actually configured in the extension's entity mapping rules in the target environment.

If this tag is not configured, `contains(entity_tags, "vendor:extreme-networks")` never matches, and the fallback `contains(affected_entity_types, "dt.entity.custom_device")` catches ALL custom device entities (not just Extreme devices).

**Fix:** Determine actual tag applied by the installed extension. Check Dynatrace UI > Entities > Custom Devices > [Extreme device] > Tags. Use that tag value in the filter.

---

### 8. `site` dimension not automatically emitted by SNMP extension

**Affected tiles:** 8, 11, 13, 14, 19, 26

The `site` dimension is not a standard SNMP MIB field. The Generic Network Extension only emits dimensions declared in its `extension.yaml`. If `site` is not declared as a dimension (mapped from a custom property or host group), it is null on all metric data points and produces empty columns in all inventory/table tiles.

**Fix:** Either (a) configure `site` as a host group label in the extension configuration, or (b) replace with `dt.entity.host_group` or a management zone lookup.

---

### 9. `limit` without sort shows wrong devices

**Affected tiles:** 8, 13, 16, 25

`timeseries ... | limit 6` after a `by:{device.name}` returns 6 arbitrary devices (first-seen order), not the 6 most loaded/stressed. An operator reading "Top 6 Interface Utilization" expects the highest-utilization devices.

**Fix for all four tiles:** Add a sort step before limiting:
```dql
| fieldsAdd peak = arrayMax(utilization)
| sort peak desc
| limit 6
```

---

## P3 — Design and Operational Refinements

### 10. Health score threshold too strict (Tile 4)

`total_errors == 0` marks any device with a single interface error as "unhealthy." In production, occasional FCS/CRC errors on copper Ethernet are normal background noise. This threshold guarantees most production devices appear unhealthy.

**Fix:** Replace with `total_errors < 10` or a configurable threshold. Consider measuring error *rate* per interface rather than total error count per device.

---

### 11. `avg()` used where `max()` is operationally correct

**Affected tiles:** 16 (CPU per device), 17 (Memory fleet)

- `avg(cpu)` per device: on multi-module switches (VSP 4900 with line cards), this blends idle management module CPU with stressed line card CPUs. Use `max()`.
- Fleet-wide `avg(memory)`: hides individual devices at 95% memory when the fleet average is 30%. Add a companion `max()` tile or show per-device breakdown.

---

### 12. Tile 24 title/computation mismatch

Tile 24 is titled "Total Client Count Trend" but uses `avg(client_count)` which computes average clients per AP per interval, not the fleet total. Either:
- Change to `sum(client_count)` for true fleet total, OR
- Retitle to "Average Clients per AP Trend"

---

## Workflow Remediation Requirements

The XIQ API workflow needs the following updates before the dashboard queries will work correctly:

1. **Remap response fields:** `hostname` → `ap.name`, `serial_number` → `ap.serial`, `connected_clients` → `client.count` (or update DQL to use raw field names)
2. **Fix AP status:** Map `connected: true` → `ap.status = "CONNECTED"`, `connected: false` → `ap.status = "DISCONNECTED"` (do not use "ONLINE"/"OFFLINE")
3. **Resolve site name:** Make a second API call to `GET /locations/{location_id}` and emit `site.name` as a string field
4. **Add channel_utilization:** Include `channel_utilization` from `/devices/{id}/stats` — replace RSSI in the bizevent payload or supplement it
5. **Remove disconnect.count and auth.failure.count:** These cannot be polled from XIQ REST API v1 — remove from workflow or mark as placeholder pending XIQ event stream integration
6. **Poll interval:** Ensure the workflow runs on ≤15-minute intervals; dashboard windows are set to `from:now()-10m` for live tiles which requires more frequent polling

---

## Tile Verdict Summary

| Tile | Title | Verdict |
|------|-------|---------|
| 2 | Network Devices Online | QUESTIONABLE (device.id dimension key) |
| 3 | Access Points Online | INCORRECT (ap.status == "ONLINE" wrong, 10m window too short) |
| 4 | Network Health Score | QUESTIONABLE (zero-error threshold impractical) |
| 5 | Active Alerts | QUESTIONABLE (vendor tag not auto-applied) |
| 7 | Total Throughput | QUESTIONABLE (metric key may not exist) |
| 8 | Interface Utilization | QUESTIONABLE (metric key uncertain, avg vs max) |
| 10 | Interface Error Rate | QUESTIONABLE (threshold not calibrated, title says rate but shows count) |
| 11 | Interface Error Summary | QUESTIONABLE (if.name dimension key to verify) |
| 13 | Packet Drops per Device | QUESTIONABLE (device.name collision risk, limit without sort) |
| 14 | Device Uptime & CPU | INCORRECT (uptime centisecond divisor) |
| 16 | CPU per Device | VALID (minor — avg vs max, limit without sort) |
| 17 | Memory Utilization | VALID (minor — fleet avg hides outliers) |
| 19 | Device Inventory | INCORRECT (uptime centisecond divisor, site dimension) |
| 21 | Total Connected Clients | QUESTIONABLE (client.count field name) |
| 22 | Average Client RSSI | INCORRECT (rssi field doesn't exist at AP level) |
| 23 | Avg Clients per AP | QUESTIONABLE (client.count field name) |
| 24 | Client Count Trend | QUESTIONABLE (client.count, avg vs sum mismatch with title) |
| 25 | Client Count by AP | QUESTIONABLE (client.count field name, limit without sort) |
| 26 | AP Fleet Table | QUESTIONABLE (client.count, rssi, site.name all need fixes) |
| 31 | Client Disconnects KPI | INCORRECT (field doesn't exist in XIQ API, cumulative counter bug) |
| 32 | Auth Failures KPI | INCORRECT (field doesn't exist in XIQ API, cumulative counter bug) |
| 33 | Roaming Events KPI | INCORRECT (wrong syslog keywords) |
| 34 | DHCP Failures KPI | INCORRECT (wrong syslog keywords) |
| 35 | Disconnect Rate chart | INCORRECT (field doesn't exist, cumulative counter in timeseries) |
| 36 | Auth Failure Rate chart | INCORRECT (field doesn't exist, cumulative counter in timeseries) |
| 37 | Roaming by AP table | INCORRECT (wrong syslog keywords, host.name is controller not AP) |
| 38 | Auth Failure Trend | INCORRECT (wrong syslog keywords) |
| 39 | Client Event Log | INCORRECT (all 6 syslog keywords wrong) |

**Totals:** 4 VALID (minor) · 10 QUESTIONABLE · 14 INCORRECT

---

## Related Memories
- [[feedback_dynatrace_notebook_upload_format]] — Dynatrace JSON upload format
- [[reference_acg_dql_syntax_constraints]] — DQL parser rules
