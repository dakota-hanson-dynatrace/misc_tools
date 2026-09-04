// DQL for the NCM app.
//
// Two rules govern every query here, both learned the hard way:
//
// 1. `fetch ... from:` filters on `timestamp`, which is INGEST time. Logical
//    capture time lives in the `ncm.capture.time` attribute, because Grail
//    rejects backdated timestamps beyond 24h. So the fetch window must be wide
//    enough to cover ingest, and all ordering/pairing uses the attribute.
//
// 2. DQL has no window functions - `prev`, `lag`, `lead`, `rowNumber`, `over`
//    and `partitionBy` are all UNKNOWN_FUNCTION. Change detection is expressed
//    instead as "group by (device, hash) and take min(capture.time)": each
//    distinct hash's first appearance IS a change event. No self-join, no
//    collectArray (whose ordering is explicitly not guaranteed).

/**
 * Ingest window - filters `timestamp`, NOT logical capture time.
 *
 * Seeded data all arrives in one instant while carrying up to 90 days of logical
 * history in `ncm.capture.time`, so this window must cover when records were
 * INGESTED, not the history they describe. At -7d the seeded dataset silently
 * vanished 7 days after seeding: every page empty, no error.
 *
 * Ceiling is the retention of the bucket the records land in. Today that is
 * `default_logs` at 35 days (the three ncm_* buckets are blocked on IAM), so
 * -30d is the widest useful value. Raise this if and when the dedicated buckets
 * exist with longer retention.
 */
/**
 * Grail is append-only, so re-running the seed ADDS records rather than
 * replacing them and every count silently doubles. `ncm.capture.id` is
 * deterministic (`<deviceId>-<YYYY-MM-DD>`), so deduping on it makes every
 * query idempotent across reseeds. For chunked blobs the key must include
 * `ncm.chunk.index`, or duplicate chunks make reassemble() see 2N rows against
 * a chunk.total of N and reject a perfectly good config.
 *
 * Every aggregating query below dedups. Do not remove it.
 */
const DEFAULT_LOGS_RETENTION_DAYS = 35;
const INGEST_WINDOW_DAYS = DEFAULT_LOGS_RETENTION_DAYS - 5;
const IN = `from: -${INGEST_WINDOW_DAYS}d`;

/**
 * Latest known state per device - the inventory table.
 *
 * `healthy` reflects the MOST RECENT capture, not "zero failures anywhere in
 * the window" - a device that had one transient failure and has since
 * recaptured cleanly is healthy. Matches the reasoning already used for
 * Coverage's `stateFor()` (a resolved past failure with a fresh success reads
 * as `covered`, not `failing`); the dot here previously used the naive
 * "any failure ever" definition and stayed red long after recovery.
 */
export const deviceInventory = () => `
fetch logs, ${IN}
| filter ncm.record.type == "index"
// ncmPromote writes a SECOND "index" record under the same ncm.capture.id
// (the promotion ledger entry, carrying ncm.lines.added/removed). Without an
// explicit sort, which of the two rows dedup keeps is scan-order dependent -
// sorting by ingest time first makes the later-written (enriched) row win
// deterministically, every time.
| sort timestamp desc
| dedup {ncm.capture.id}
| summarize
    lastCapture   = max(ncm.capture.time),
    lastSuccess   = max(if(ncm.capture.status == "ok", ncm.capture.time)),
    captures      = count(),
    name          = takeAny(ncm.device.name),
    site          = takeAny(ncm.site),
    vendor        = takeAny(ncm.vendor),
    role          = takeAny(ncm.role),
    versions      = countDistinctExact(ncm.config.hash),
    failures      = countIf(ncm.capture.status != "ok"),
    by: {ncm.device.id}
| fieldsAdd healthy = (lastCapture == lastSuccess)
| sort name asc`;

/**
 * Every config version period, fleet-wide or for one device.
 *
 * One row per (device, hash): when that config first appeared, when it was last
 * seen, and how many captures observed it. A device with N rows changed N-1
 * times. This is the change ledger and the basis of the change feed.
 */
export const versionPeriods = (deviceId?: string) => `
fetch logs, ${IN}
| filter ncm.record.type == "index" and ncm.capture.status == "ok"
// ncmPromote writes a SECOND "index" record under the same ncm.capture.id
// (the promotion ledger entry, carrying ncm.lines.added/removed). Without an
// explicit sort, which of the two rows dedup keeps is scan-order dependent -
// sorting by ingest time first makes the later-written (enriched) row win
// deterministically, every time.
| sort timestamp desc
| dedup {ncm.capture.id}
${deviceId ? `| filter ncm.device.id == "${deviceId}"` : ''}
| summarize
    firstSeen = min(ncm.capture.time),
    lastSeen  = max(ncm.capture.time),
    captures  = count(),
    name      = takeAny(ncm.device.name),
    site      = takeAny(ncm.site),
    vendor    = takeAny(ncm.vendor),
    bytes     = takeAny(ncm.size.bytes),
    by: {ncm.device.id, ncm.config.hash}
// Revert detection without window functions. Captures are daily, so a hash that
// was continuously in effect must appear once per day between its first and last
// sighting. Fewer captures than that span means the config moved away and came
// BACK - a revert, which min(capture.time) alone cannot see.
| fieldsAdd spanDays = (toLong(toTimestamp(lastSeen)) - toLong(toTimestamp(firstSeen))) / 86400000000000
| fieldsAdd reverted = (captures < spanDays + 1)
| sort name asc, firstSeen asc`;

/**
 * Fleet-wide change feed: every config version EXCEPT each device's first.
 *
 * A device's earliest version is its baseline, not a change - including it
 * would report a change for every device the day monitoring began.
 */
export const changeFeed = (limit = 200) => `
fetch logs, ${IN}
| filter ncm.record.type == "index" and ncm.capture.status == "ok"
// ncmPromote writes a SECOND "index" record under the same ncm.capture.id
// (the promotion ledger entry, carrying ncm.lines.added/removed). Without an
// explicit sort, which of the two rows dedup keeps is scan-order dependent -
// sorting by ingest time first makes the later-written (enriched) row win
// deterministically, every time.
| sort timestamp desc
| dedup {ncm.capture.id}
| summarize firstSeen = min(ncm.capture.time),
            name   = takeAny(ncm.device.name),
            site   = takeAny(ncm.site),
            vendor = takeAny(ncm.vendor),
            bytes  = takeAny(ncm.size.bytes),
            by: {ncm.device.id, ncm.config.hash}
| summarize versions = collectArray(record(hash = ncm.config.hash, at = firstSeen, bytes = bytes)),
            baseline = min(firstSeen),
            name   = takeAny(name),
            site   = takeAny(site),
            vendor = takeAny(vendor),
            by: {ncm.device.id}
| expand versions
| fieldsAdd at = versions[at], hash = versions[hash], bytes = versions[bytes]
| filter at != baseline
| fields ncm.device.id, name, site, vendor, hash, at, bytes
| sort at desc
| limit ${limit}`;

/**
 * Devices whose most recent capture failed, with the failure reason.
 * "Which devices failed backup last night" is a first-class NCM report.
 */
export const backupFailures = () => `
fetch logs, ${IN}
| filter ncm.record.type == "index"
// ncmPromote writes a SECOND "index" record under the same ncm.capture.id
// (the promotion ledger entry, carrying ncm.lines.added/removed). Without an
// explicit sort, which of the two rows dedup keeps is scan-order dependent -
// sorting by ingest time first makes the later-written (enriched) row win
// deterministically, every time.
| sort timestamp desc
| dedup {ncm.capture.id}
| summarize lastCapture = max(ncm.capture.time),
            name   = takeAny(ncm.device.name),
            site   = takeAny(ncm.site),
            vendor = takeAny(ncm.vendor),
            statuses = collectDistinct(ncm.capture.status),
            failures = countIf(ncm.capture.status != "ok"),
            total    = count(),
            by: {ncm.device.id}
| filter failures > 0
| fieldsAdd failureRate = failures * 100 / total
| sort failures desc`;

/**
 * The chunk rows for one captured config, ordered for reassembly.
 *
 * Returns raw chunks rather than a joined string on purpose: the caller runs
 * reassemble() from utils/records, which verifies chunk count and total byte
 * length. `content` truncates SILENTLY at 512 KiB, so a config must never be
 * displayed without that check.
 */
export const configChunks = (captureId: string, recordType: 'version' | 'capture' = 'version') => `
fetch logs, ${IN}
// Exactly ONE record type. ncmPromote writes a capture blob and a version
// blob under the SAME ncm.capture.id, so matching both would return 2N rows
// against a chunk.total of N and reassemble() would reject every promoted
// config as corrupt.
| filter ncm.capture.id == "${captureId}" and ncm.record.type == "${recordType}"
| dedup {ncm.capture.id, ncm.chunk.index}
| fields content,
         ncm.chunk.index,
         ncm.chunk.total,
         ncm.content.bytes,
         ncm.capture.time,
         ncm.config.hash,
         ncm.device.id
| sort ncm.chunk.index asc`;

/**
 * Capture ids for a device's stored versions, newest first - the version picker
 * behind the diff view.
 */
export const versionCaptureIds = (deviceId: string) => `
fetch logs, ${IN}
| filter ncm.record.type == "version" and ncm.device.id == "${deviceId}"
| dedup {ncm.capture.id, ncm.chunk.index}
| summarize captureTime = takeAny(ncm.capture.time),
            hash        = takeAny(ncm.config.hash),
            bytes       = takeAny(ncm.content.bytes),
            chunks      = count(),
            by: {ncm.capture.id}
| sort captureTime desc`;

/**
 * Identity and latest status for ONE device, regardless of whether captures
 * succeeded.
 *
 * versionPeriods filters `status == "ok"`, so for a device that has never
 * captured successfully it returns nothing - leaving the detail page with no
 * name, no vendor, and crucially no reason. Those are exactly the devices an
 * operator clicks on.
 */
export const deviceStatus = (deviceId: string) => `
fetch logs, ${IN}
| filter ncm.record.type == "index" and ncm.device.id == "${deviceId}"
// ncmPromote writes a SECOND "index" record under the same ncm.capture.id
// (the promotion ledger entry, carrying ncm.lines.added/removed). Without an
// explicit sort, which of the two rows dedup keeps is scan-order dependent -
// sorting by ingest time first makes the later-written (enriched) row win
// deterministically, every time.
| sort timestamp desc
| dedup {ncm.capture.id}
| summarize
    name        = takeAny(ncm.device.name),
    site        = takeAny(ncm.site),
    vendor      = takeAny(ncm.vendor),
    role        = takeAny(ncm.role),
    lastAttempt = max(ncm.capture.time),
    attempts    = count(),
    failures    = countIf(ncm.capture.status != "ok"),
    statuses    = collectDistinct(ncm.capture.status),
    lastSuccess = max(if(ncm.capture.status == "ok", ncm.capture.time))`;

/** Fleet rollup for the header: devices, sites, versions, failures. */
export const fleetSummary = () => `
fetch logs, ${IN}
| filter ncm.record.type == "index"
// ncmPromote writes a SECOND "index" record under the same ncm.capture.id
// (the promotion ledger entry, carrying ncm.lines.added/removed). Without an
// explicit sort, which of the two rows dedup keeps is scan-order dependent -
// sorting by ingest time first makes the later-written (enriched) row win
// deterministically, every time.
| sort timestamp desc
| dedup {ncm.capture.id}
| summarize devices  = countDistinctExact(ncm.device.id),
            sites    = countDistinctExact(ncm.site),
            versions = countDistinctExact(ncm.config.hash),
            captures = count(),
            // No else branch: the expression yields null for healthy captures
            // and null is not counted. An \`else: ""\` would add a phantom
            // bucket and overstate the count by one.
            failing  = countDistinctExact(if(ncm.capture.status != "ok", ncm.device.id))`;


// ---------------------------------------------------------------------------
// Coverage: which SNMP-monitored network devices are actually being backed up?
// ---------------------------------------------------------------------------

/**
 * Network devices Dynatrace already knows about from SNMP.
 *
 * Entities are NOT bucket-partitioned, so `storage:entities:read` alone is
 * enough here - no `storage:buckets:read` needed for this half.
 *
 * The entity carries no address; only `id`, `entity.name` (which is sysName, a
 * MUTABLE display label) and `tags`. The address comes from monitoredAddresses()
 * below.
 */
export const monitoredDevices = () => `
fetch \`dt.entity.network:device\`, from: -30d
| fields entityId = id, name = entity.name
| sort name asc`;

/**
 * Entity id -> polled address, from SNMP metric dimensions.
 *
 * The metric carries both `device.address` and a `dt.entity.network:device`
 * dimension, so this is a single query rather than a correlation step.
 *
 * BEST-EFFORT by nature: only devices actively reporting the metric appear. A
 * monitored device with a feature-set gap or an unavailable OID yields no
 * address at all, which is exactly why the name fallback exists.
 */
export const monitoredAddresses = () => `
timeseries v = avg(com.dynatrace.extension.network_device.sysuptime), from: -30d,
  by: {\`dt.entity.network:device\`, device.address}
| fieldsAdd points = arraySize(arrayRemoveNulls(v))
| filter points > 0
| fields entityId = \`dt.entity.network:device\`, address = device.address, points`;

/**
 * Backup state per NCM device: what we know about whether it is backed up.
 *
 * `lastSuccess` is null for a device that has never captured cleanly - that is
 * the difference between "outdated" and "not backed up at all", and the two
 * warrant different colours.
 */
export const backupState = () => `
fetch logs, ${IN}
| filter ncm.record.type == "index"
// ncmPromote writes a SECOND "index" record under the same ncm.capture.id
// (the promotion ledger entry, carrying ncm.lines.added/removed). Without an
// explicit sort, which of the two rows dedup keeps is scan-order dependent -
// sorting by ingest time first makes the later-written (enriched) row win
// deterministically, every time.
| sort timestamp desc
| dedup {ncm.capture.id}
| summarize
    name        = takeAny(ncm.device.name),
    address     = takeAny(ncm.device.address),
    site        = takeAny(ncm.site),
    vendor      = takeAny(ncm.vendor),
    attempts    = count(),
    failures    = countIf(ncm.capture.status != "ok"),
    lastAttempt = max(ncm.capture.time),
    lastSuccess = max(if(ncm.capture.status == "ok", ncm.capture.time)),
    statuses    = collectDistinct(ncm.capture.status),
    by: {deviceId = ncm.device.id}
| sort name asc`;
