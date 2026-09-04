import { bucketDefinitionsClient } from '@dynatrace-sdk/client-bucket-management';
import { settingsObjectsClient } from '@dynatrace-sdk/client-settings';

// One-time tenant setup: creates the three dedicated Grail buckets and wires
// OpenPipeline so ncm.* records land in them instead of default_logs.
//
// Every shape here was pulled from the live tenant, not guessed: the
// bucketAssignment processor shape came from a real PostgreSQL extension's
// pipeline object (builtin:openpipeline.logs.pipelines), and the routing
// object shape came from reading the tenant's actual (single, shared)
// builtin:openpipeline.logs.routing object.
//
// That routing object is the one genuinely dangerous part: it is ONE object
// per tenant, already holding entries for Azure App Service, OTel, Databricks,
// VMware, and others. This code only ever reads it, appends our one entry if
// missing, and writes the merged array back with optimistic locking - it must
// never construct a routing value from scratch and overwrite what's there.
//
// Never-throw contract, like ncmPromote: an exception escaping an app
// function is reported as a generic "Execution crashed" with the real message
// lost, so every step is caught individually and reported in the response
// instead.

const BUCKETS: { bucketName: string; table: string; retentionDays: number; displayName: string }[] = [
  { bucketName: 'ncm_index', table: 'logs', retentionDays: 730, displayName: 'NCM change ledger (index records)' },
  { bucketName: 'ncm_captures', table: 'logs', retentionDays: 14, displayName: 'NCM raw captures (short-lived)' },
  { bucketName: 'ncm_versions', table: 'logs', retentionDays: 730, displayName: 'NCM promoted config versions' },
];

const PIPELINE_SCHEMA = 'builtin:openpipeline.logs.pipelines';
const ROUTING_SCHEMA = 'builtin:openpipeline.logs.routing';
// External id makes the pipeline upsert idempotent - re-running setup updates
// the same object instead of creating a duplicate pipeline every time.
const PIPELINE_EXTERNAL_ID = 'my.ncm_storage-routing';
const PIPELINE_DISPLAY_NAME = 'NCM (my.ncm) storage routing';
// Every record this app writes carries ncm.record.type - that alone is
// enough to select "is this one of ours" at the routing layer. The pipeline's
// own processors then split by the specific type.
const ROUTING_MATCHER = 'isNotNull(ncm.record.type)';
const ROUTING_DESCRIPTION = 'NCM (my.ncm) - route ncm.* records to dedicated buckets';

interface SetupRequest {
  /** Compute and report what would happen; write nothing. Default true - this must be opted OUT of, not into. */
  dryRun?: boolean;
}

type StepStatus = 'ok' | 'created' | 'would_create' | 'updated' | 'would_update' | 'failed';

interface StepResult {
  name: string;
  status: StepStatus;
  detail?: string;
}

interface SetupResponse {
  ok: boolean;
  dryRun: boolean;
  steps: StepResult[];
  message?: string;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function ensureBuckets(dryRun: boolean): Promise<StepResult[]> {
  let existing: Set<string>;
  try {
    const defs = await bucketDefinitionsClient.getDefinitions();
    existing = new Set(defs.buckets.map((b) => b.bucketName));
  } catch (e) {
    return BUCKETS.map((b) => ({ name: `bucket:${b.bucketName}`, status: 'failed', detail: `could not list buckets - ${msg(e)}` }));
  }

  const results: StepResult[] = [];
  for (const b of BUCKETS) {
    if (existing.has(b.bucketName)) {
      results.push({ name: `bucket:${b.bucketName}`, status: 'ok', detail: 'already exists' });
      continue;
    }
    if (dryRun) {
      results.push({ name: `bucket:${b.bucketName}`, status: 'would_create', detail: `table=${b.table} retentionDays=${b.retentionDays}` });
      continue;
    }
    try {
      await bucketDefinitionsClient.createBucket({
        body: { bucketName: b.bucketName, table: b.table, displayName: b.displayName, retentionDays: b.retentionDays },
      });
      results.push({ name: `bucket:${b.bucketName}`, status: 'created' });
    } catch (e) {
      results.push({ name: `bucket:${b.bucketName}`, status: 'failed', detail: msg(e) });
    }
  }
  return results;
}

/** The pipeline's per-record-type bucket assignment. Matches the real shape read from a live PostgreSQL extension pipeline. */
function pipelineValue() {
  return {
    customId: 'my-ncm-storage-routing',
    displayName: PIPELINE_DISPLAY_NAME,
    storage: {
      processors: BUCKETS.map((b) => {
        const recordType = b.bucketName === 'ncm_index' ? 'index' : b.bucketName === 'ncm_captures' ? 'capture' : 'version';
        return {
          id: `ncm.storage.${recordType}`,
          description: `NCM ${recordType} records -> ${b.bucketName}`,
          enabled: true,
          matcher: `ncm.record.type == "${recordType}"`,
          type: 'bucketAssignment',
          bucketAssignment: { bucketName: b.bucketName },
        };
      }),
    },
  };
}

/** Finds our pipeline object by its stable externalId, if it exists. Never lists by schema alone and assumes position - other apps' pipelines share this schema. */
async function findPipeline(): Promise<{ objectId: string } | null> {
  const list = await settingsObjectsClient.listSettingsObjects({
    schemaId: PIPELINE_SCHEMA,
    scope: 'environment',
    addFields: 'externalId',
    pageSize: 500,
  });
  const mine = list.items.find((it) => it.externalId === PIPELINE_EXTERNAL_ID);
  return mine ? { objectId: mine.objectId } : null;
}

async function ensurePipeline(dryRun: boolean): Promise<{ result: StepResult; objectId: string | null }> {
  try {
    const found = await findPipeline();
    if (found) {
      return { result: { name: 'pipeline', status: 'ok', detail: 'already exists' }, objectId: found.objectId };
    }
    if (dryRun) {
      return { result: { name: 'pipeline', status: 'would_create', detail: '3 bucketAssignment processors, one per record type' }, objectId: null };
    }
    const created = await settingsObjectsClient.upsertSettingsObject({
      body: { schemaId: PIPELINE_SCHEMA, scope: 'environment', externalId: PIPELINE_EXTERNAL_ID, value: pipelineValue() },
    });
    const objectId = created && typeof created === 'object' ? created.objectId : null;
    if (!objectId) {
      // upsert can return void on a plain update; re-fetch to get the id for the routing step.
      const refetched = await findPipeline();
      return { result: { name: 'pipeline', status: 'created' }, objectId: refetched?.objectId ?? null };
    }
    return { result: { name: 'pipeline', status: 'created' }, objectId };
  } catch (e) {
    return { result: { name: 'pipeline', status: 'failed', detail: msg(e) }, objectId: null };
  }
}

/**
 * Appends our routing entry to the tenant's ONE shared routing object.
 *
 * This is the step that can do real damage if written carelessly: read the
 * current value, check whether our entry is already present (by pipelineId,
 * which is stable once the pipeline exists), and if not, write back the
 * EXISTING entries plus ours - never a value constructed from scratch.
 */
async function ensureRouting(pipelineObjectId: string | null, dryRun: boolean): Promise<StepResult> {
  if (!pipelineObjectId) {
    // In a dry run this is expected, not a failure: the pipeline step only
    // reports what it WOULD create and never actually creates it, so there is
    // no real object id yet to preview a routing entry against. Only treat
    // this as a real failure outside dry-run, where the pipeline step really
    // did have a chance to create one and didn't.
    return dryRun
      ? { name: 'routing', status: 'would_create', detail: 'depends on the pipeline step above - would add 1 entry once it exists' }
      : { name: 'routing', status: 'failed', detail: 'pipeline step did not produce an object id - cannot add a routing entry for it' };
  }
  try {
    const list = await settingsObjectsClient.listSettingsObjects({ schemaId: ROUTING_SCHEMA, scope: 'environment', pageSize: 1 });
    const existingObjectId = list.items[0]?.objectId;

    if (!existingObjectId) {
      // Fresh tenant with no routing object at all yet for this table type.
      if (dryRun) return { name: 'routing', status: 'would_create', detail: 'no routing object exists yet - would create one with our entry' };
      await settingsObjectsClient.upsertSettingsObject({
        body: {
          schemaId: ROUTING_SCHEMA,
          scope: 'environment',
          value: { routingEntries: [{ enabled: true, matcher: ROUTING_MATCHER, pipelineId: pipelineObjectId, pipelineType: 'custom', description: ROUTING_DESCRIPTION }] },
        },
      });
      return { name: 'routing', status: 'created' };
    }

    const full = await settingsObjectsClient.getSettingsObject({ objectId: existingObjectId });
    const value = full.value as { routingEntries?: { pipelineId?: string; description?: string }[] };
    const entries = value.routingEntries ?? [];
    const alreadyPresent = entries.some((e) => e.pipelineId === pipelineObjectId);

    if (alreadyPresent) {
      return { name: 'routing', status: 'ok', detail: `already present (${entries.length} total entries in the tenant's shared routing table)` };
    }
    if (dryRun) {
      return { name: 'routing', status: 'would_update', detail: `would append 1 entry to ${entries.length} existing (untouched) entries` };
    }
    await settingsObjectsClient.updateSettingsObject({
      objectId: existingObjectId,
      optimisticLockingVersion: full.version,
      body: {
        value: {
          ...value,
          routingEntries: [...entries, { enabled: true, matcher: ROUTING_MATCHER, pipelineId: pipelineObjectId, pipelineType: 'custom', description: ROUTING_DESCRIPTION }],
        },
      },
    });
    return { name: 'routing', status: 'updated', detail: `appended 1 entry, left ${entries.length} existing entries untouched` };
  } catch (e) {
    return { name: 'routing', status: 'failed', detail: msg(e) };
  }
}

export default async function (request: SetupRequest = {}): Promise<SetupResponse> {
  const dryRun = request.dryRun !== false;
  try {
    const bucketSteps = await ensureBuckets(dryRun);
    const { result: pipelineStep, objectId: pipelineObjectId } = await ensurePipeline(dryRun);
    const routingStep = await ensureRouting(pipelineObjectId, dryRun);

    const steps = [...bucketSteps, pipelineStep, routingStep];
    const ok = steps.every((s) => s.status !== 'failed');
    return { ok, dryRun, steps };
  } catch (e) {
    console.error('ncmSetup failed:', e);
    return { ok: false, dryRun, steps: [], message: msg(e) };
  }
}
