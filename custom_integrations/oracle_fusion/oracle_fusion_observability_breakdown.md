# Oracle Fusion Cloud Applications — Observability Breakdown

What's actually available from Oracle Fusion Cloud Applications (ERP/HCM/SCM) for observability purposes, via API or otherwise — researched against docs.oracle.com and Oracle's own blogs/tutorials, not assumed. This is the reference document behind `workflow.yaml`/`dashboard.yaml`/`README.md` in this folder, written to stand on its own for anyone deciding whether/how to extend this integration.

Oracle Fusion doesn't ship a "metrics API" the way infrastructure platforms do — this is a fully-managed SaaS, and Oracle draws a hard line around infrastructure-level access (see [Infrastructure metrics](#infrastructure-metrics-dont-exist-for-customers) below). What exists instead is a set of business/operational REST APIs, one of which — Enterprise Scheduler Service — is a genuinely strong observability signal. The rest range from usable-but-narrow to UI-only.

## Data sources, ranked by what's actually usable

| Source | API surface | Confidence | Used by this integration? |
|---|---|---|---|
| **ESS Scheduled Processes** | `GET /ess/rest/scheduler/v1/requests` (REST, own API root, not under `fscmRestApi`) | High — confirmed live doc | **Yes — built** |
| ERP Integrations (bulk-data jobs) | `POST /fscmRestApi/resources/{version}/erpintegrations` | High — confirmed live doc | No — narrower subset of ESS, Financials/SCM-specific; ESS alone already covers these job runs |
| Business-object audit trail | `POST /fscmRestApi/fndAuditRESTService/audittrail/getaudithistory` | High — confirmed live doc | No — deferred, see below |
| Sign-in/sign-out audit | `GET /oam/services/rest/access/api/v1/audit/{events,stats}` | Medium — exists, deprecation status unresolved | No — deferred, see below |
| ESS job log/output content | SOAP `ErpIntegrationService.downloadESSJobExecutionDetails` only — no REST equivalent found | Medium — operation list triangulated, not directly fetched | No — deferred, see below |
| BI Publisher custom reports | `POST /xmlpserver/services/rest/v1/reports/{path}/run` (+ SOAP `ReportService`/`ExternalReportWSSService`) | Medium — REST mechanics confirmed, Fusion-SaaS applicability community-corroborated | No — generic backdoor for a custom KPI, not a ready-made metrics API |
| OTBI analyses | SOAP only (`analytics-ws/saw.dll`) | Low — weakly sourced, no REST found | No |
| Fusion service status | saasstatus.oracle.com — no documented API; an undocumented `pub_pg_data.json` exists (found via network inspection, no contract) | Low as an integration point | No — see below |
| OIC (Oracle Integration Cloud) metrics | Standard OCI Monitoring, namespace `oci_integration` | High, but **only applicable if the customer runs OIC** | No — conditional add-on, different auth entirely |
| Diagnostic Dashboard | UI only — no REST API exists | Confirmed absent | Not usable |
| Interface-table backlogs / FBDI error counts | No unified API | Confirmed absent | Not usable — ESS job state/errorType is the closest proxy |
| Infrastructure metrics (CPU/memory/DB) | Does not exist for SaaS customers | Confirmed absent, by design | Not usable |

---

## Built: Enterprise Scheduler Service (ESS)

ESS is Oracle Fusion's batch/scheduled-job engine — every nightly import, month-end close step, payroll run, report, and background process across ERP/HCM/SCM goes through it. It's the single best-documented, highest-coverage operational signal available via REST in the entire product.

**Endpoint**: `GET /ess/rest/scheduler/v1/requests` (introduced ~Release 23B). Confirmed fields per job execution:

- **Identity**: `requestId`, `jobDefinitionId`, `application`, `product`, `jobDisplayName`, `description`, `requestCategory`
- **Status**: `state` (enum: `WAIT`, `READY`, `RUNNING`, `COMPLETED`, `BLOCKED`, `HOLD`, `CANCELLING`, `EXPIRED`, `CANCELLED`, `ERROR`, `WARNING`, `SUCCEEDED`, `PAUSED`, `PENDING_VALIDATION`, `VALIDATION_FAILED`, `SCHEDULE_ENDED`, `FINISHED`, `ERROR_AUTO_RETRY`, `ERROR_MANUAL_RECOVERY`, `UNKNOWN`), `stateDescription`, `previousState`, `stateChangeTime`, `processPhase`
- **Failure detail**: `cause` (enum incl. `PROCESS_ERROR`, `PROCESS_BIZ_ERROR`, `PROCESS_SYSTEM_ERROR`, `VALIDATION_ERROR`, `REQUEST_AUTHORIZATION_FAILED`, `METADATA_NOT_FOUND`), `causeDescription`, `errorType` (`SYSTEM`/`BUSINESS`/`TIMEOUT`/`MIXED_NON_BUSINESS`/`MIXED_BUSINESS`), `errorWarningMessage`, `errorWarningTime`, `errorWarningDetail`
- **Timing**: `submissionTime`, `requestedStartTime`, `scheduledTime`, `processStartTime`, `processEndTime`, `completedTime`, `elapsedTime` (ms)
- **User**: `submitter`, `submitterGUID`, `runAsUser`
- **Parent/child**: `absParentRequestId`, `parentRequestId`, `instanceParentId`, `requestType` (`SINGLETON`/`RECUR_PARENT`/`RECUR_CHILD`/`JOBSET_*`/`SUB_REQUEST`/`UNKNOWN`)
- **Control**: `isCancellable`, `isHoldable`, `retriedCount`, `priority` (0-9)

Filterable via a SCIM-style `q` parameter (`state eq 'RUNNING'`, date comparators on `submissionTime`, etc.), sortable via `orderBy`, sparse-fieldable via `fields`/`excludeFields`.

**What's not available even here**: the actual job log/output file content. That requires the SOAP `ErpIntegrationService.downloadESSJobExecutionDetails` operation (returns a zip of `.log`/`.out` files, the `.out` containing import summary counts like Total Records Read/Imported/Failed) — no REST equivalent was found. Out of scope for this integration; see README.

---

## Documented, deferred (researched, not built)

Each of these is real and could be added later without disrupting the ESS-based core — noted here so the option is visible, not buried.

- **Business-object audit trail** (`getaudithistory`): tracks data changes (insert/update/delete) to specific business objects, with old/new values. Useful for correlating a failure with "what config changed right before this." Requires per-object audit policies to be turned on first (Setup and Maintenance → Manage Audit Policies), and queries are capped at a 1-month range. Good Phase 2 candidate if change-correlation becomes a priority.
- **Sign-in/sign-out audit**: `GET /oam/services/rest/access/api/v1/audit/{events,stats}`, 7-day retention. Deprecation status is genuinely unclear from research — some sources say it stops working once a tenant migrates to the newer OCI IAM Identity Domain model (replaced by OCI Audit Logs), but the current docs.oracle.com page still documents it live with no deprecation banner. Don't build against this without checking the target tenant's identity-model migration state first.
- **saasstatus.oracle.com**: Oracle's public Fusion Cloud Applications status page (3-state: Normal/Disruption/Down, 30-day history, explicitly excludes planned maintenance and customer-specific status). No documented API, RSS, or iCal feed. An undocumented JSON file (`pub_pg_data.json`) backs the page's own rendering and is technically pollable, but it's an implementation detail with no contract, versioning, or SLA — could change or vanish without notice. Don't build production monitoring on it. (Note: `ocistatus.oraclecloud.com` has a real, documented API/RSS, but it covers OCI/PaaS services, not core Fusion ERP/HCM/SCM/CX — easy to confuse the two, they're separate products.)
- **OIC (Oracle Integration Cloud) metrics**: if the customer runs OIC alongside Fusion for integration flows, OIC instances live in the customer's own OCI tenancy and expose real, standard OCI Monitoring metrics (namespace `oci_integration`: inbound/outbound request counts, processing time percentiles, success/fail counts, 5-min granularity) — reachable via the normal OCI Monitoring REST API/SDK/CLI. This is a completely different auth model (OCI signing-key auth, not the Fusion identity domain) and a conditional add-on, not core scope: only relevant if the customer actually has OIC in their architecture.

## Confirmed absent (don't scope around these)

- **Diagnostic Dashboard**: UI-only (Navigator → Tools → Diagnostics → Health Check / Run Diagnostic Tests). No REST API exists for it.
- **Interface-table backlogs / FBDI import error counts**: no unified, product-agnostic API. Each FBDI/interface load is itself an ESS job, so its `state`/`errorType` is the real proxy; actual error rows live in product-specific tables (e.g. `HZ_IMP_ERRORS`) surfaced only through product-specific "Correct Import Errors" UI pages.
- **Infrastructure metrics (CPU/memory/DB) don't exist for customers.** This is architectural, not a documentation gap — Oracle's own tutorial on Fusion + OCI Observability states plainly that Fusion customers "have limited direct access to system logs and infrastructure metrics" and frames Oracle's own APM/Log Analytics solution as existing specifically because raw infrastructure access isn't available for SaaS. Oracle's recommended substitute is deploying **OCI APM Real User Monitoring** (a JS agent injected into Fusion pages, capturing page-load performance and traced API calls) plus **OCI Log Analytics** ingesting the Fusion Audit Trail API — both customer-configured, application/user-layer, not host-layer. Don't design around infra telemetry ever appearing here.

---

## Authentication

Oracle Fusion REST APIs support four auth methods:

1. **Basic Auth over SSL** — supported but Oracle explicitly discourages it as the least-secure option; can be blocked at the WAF layer by IP/CIDR/country via a Service Request.
2. **SAML 2.0 bearer tokens**
3. **JWT in the HTTP header over SSL**
4. **OAuth 2.0**, layered on top via the **OCI IAM identity domain** (formerly IDCS) tied to the Fusion instance — this is the right choice for scheduled machine-to-machine polling.

### OAuth 2.0 grant types

| Grant type | Legs | Notes |
|---|---|---|
| **Client Credentials** | 2-legged | Server-to-server, no user context — **the pattern this integration uses**. The Client ID itself must be modeled as a Fusion user. |
| JWT/Client Assertion | 2-legged | Requires uploading a signing cert to a "Trusted" confidential app; also needs the client modeled as a Fusion user. |
| Resource Owner | 2-legged | Real user credentials handled directly by the client app. |
| Authorization Code | 3-legged | Interactive browser redirect — Oracle's own docs call this "not recommended... less secure than the other flows." |

### Setup (Client Credentials)

1. OCI IAM Identity Domain console (as Administrator) → **Applications → Add application → Confidential Application**.
2. Grant type: **Client Credentials**. Add scope in `urn:opc:resource:fusion:<POD_NAME>:<product>/` form.
3. Activate → copy **Client ID**/**Client Secret** immediately (shown once).
4. **Fusion-specific step with no shortcut**: in Fusion's **Security Console**, model the Client ID as a **user** and assign it a job role + data role. Oracle's REST authorization is the same function/data-security model as the UI — there is no generic "read-only REST" toggle; access is granted per business object via the same role model real users get.
5. Get a token: `POST https://<domainURL>/oauth2/v1/token` with Basic auth of `client_id:client_secret`, body `grant_type=client_credentials&scope=...` → returns `access_token` (Bearer), `expires_in: 3600` (1 hour — build refresh into any integration, don't assume a long-lived token).

This auth model is identical across every Fusion REST family (`hcmRestApi`, `crmRestApi`, `fscmRestApi`, and ESS's own `/ess/rest/` root) — one identity domain, one OAuth setup, works everywhere in the instance.

---

## Rate limits

**Oracle does not publish a numeric rate limit** for Fusion Applications REST APIs — this was checked directly against Oracle's REST API documentation (throttling, SAF, "requests per minute/hour" — none of these turned up a number) and is a confirmed documentation gap, not a research miss.

What is known:
- A **WAF-level rate limit exists**, but its threshold is undisclosed and it's positioned as a DDoS/attack-traffic control, not a customer-facing API quota.
- **HTTP 429 is confirmed to occur** when some limit is exceeded. Documented `Retry-After` header behavior is **not** confirmed for Fusion specifically (unlike, for comparison, a vendor like Extreme Networks that fully documents IETF rate-limit headers) — any integration should implement defensive exponential backoff rather than trust a header Oracle hasn't committed to sending.
- An unofficial, community-sourced figure of "~5,000 calls/hour/user" circulates in consultant blogs and forum threads — not Oracle-confirmed, don't use it for precise capacity planning.
- **Pagination**: default page size is 25; a practical ceiling of roughly 499-500 records/page is commonly reported (Support KB/community, not directly confirmed on docs.oracle.com). Use `offset`+`limit`, loop while `hasMore` is true.
- **Timeout**: a support FAQ page indicates a 5-minute timeout per REST call (not independently re-verified against the live page this session — treat as likely correct, not certain).
- No Oracle-published guidance recommends or warns against a specific polling frequency. A 5-minute poll against a handful of endpoints is a light load pattern, well outside anything Oracle's high-volume-extraction warnings (which point bulk users toward BICC instead of REST) are aimed at.

---

## Positive outcomes for the customer

Grounded in what this integration actually produces (ESS job state, duration, failure detail) — not generic claims:

- **Faster failure detection.** A Davis-visible alert fires within one ~5-minute poll of a job entering `ERROR`/`WARNING`/`VALIDATION_FAILED`/`ERROR_MANUAL_RECOVERY` state — replacing "find out the payroll run or GL close job failed tomorrow morning" with same-poll-cycle visibility.
- **Batch-window creep caught before it's an outage.** Job duration trended per job/product over weeks surfaces a close process creeping from 40 to 90 minutes long before it blows through a maintenance window and becomes a business-visible incident. The native Scheduled Processes work area shows one run at a time — it has no trend view.
- **One dashboard answers "is anything broken" across ERP/HCM/SCM at once**, instead of someone manually filtering Oracle's UI by status, per product, by hand.
- **Immediate ownership routing.** Every alert carries `submitter`, `product`, and `application`, so the right team can be identified and paged without anyone opening Fusion first to investigate.
- **Recognizable repeat-incident signal.** Because `requestId` is a stable per-execution identifier, repeated alert refreshes for a still-failing job read during triage as one ongoing incident, not alert noise from a flapping check.
- **Single-pane correlation.** Oracle Fusion job health lands in the same Dynatrace timeline as the rest of a customer's monitored estate — hosts, services, and (in this same working directory) the Extreme Networks wireless and Genesys contact-center integrations. A failed batch job can be viewed against a concurrent network or service incident without switching tools.

**What this deliberately does not claim**: infrastructure-level insight (doesn't exist for Fusion SaaS — see [above](#confirmed-absent-dont-scope-around-these)), job log/root-cause text (SOAP-only, out of scope), or predictive/forecasting capability beyond a human reading a trend line Dynatrace draws for them.

---

## Sources

Primary research against docs.oracle.com (REST API guides for HCM/Financials/Common Features, ESS Scheduler REST API reference, OAuth/OCI IAM configuration guides), Oracle's official blogs (`blogs.oracle.com/cloud-infrastructure`), Oracle's Fusion + OCI Observability tutorial (`docs.oracle.com/en/learn/ofaob`), and direct inspection of `saasstatus.oracle.com`/`ocistatus.oraclecloud.com`. Where a claim couldn't be independently confirmed against an Oracle-hosted page (community threads, consultant blogs, or search-summary-only sources), it's flagged as such above rather than stated as fact.
