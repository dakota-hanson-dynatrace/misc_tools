// DQL for the Cost Optimization app. Every query here was run directly via
// `dtctl query` against a live environment before being wired into the UI
// (ditmar for hosts/Kubernetes, demo-live for cloud - ditmar has no AWS/Azure/
// GCP entities monitored, see AGENTS.md).

const HOST_WINDOW = 'from: -7d';
const K8S_WINDOW = 'from: -7d';
const CLOUD_WINDOW = 'from: -7d';

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/**
 * Raw (unreduced) per-host CPU/memory series - each record carries the full
 * `interval`/`timeframe`/value-array shape DQL returns, which lib/sizing.ts
 * converts into chart datapoints AND computes a true client-side percentile
 * from (sorting the actual array), rather than approximating via a second
 * DQL aggregation query. One query serves both the Hosts list (percentile per
 * host) and the host detail drawer's chart (filtered to one host by id,
 * client-side - only 5 hosts, no need for a second per-host query).
 */
export const hostRawSeries = () => `
timeseries {
  cpu = avg(dt.host.cpu.usage),
  mem = avg(dt.host.memory.usage)
}, by: {dt.entity.host}, ${HOST_WINDOW}
`;

/** Host capacity (for translating a usage % into an absolute recommended size). */
export const hostCapacity = () => `
smartscapeNodes "HOST"
| fields id, name, cores, memory
`;

/**
 * Raw per-host-per-disk used/avail byte series. A host can have several
 * disks (mounts) - grouping by both dt.entity.host and dt.entity.disk keeps
 * each disk's usage independent rather than averaged across a host's disks.
 */
export const hostDiskRawSeries = () => `
timeseries {
  used = avg(dt.host.disk.used),
  avail = avg(dt.host.disk.avail)
}, by: {dt.entity.host, dt.entity.disk}, ${HOST_WINDOW}
`;

/**
 * Mount-point name per disk id, for display only. NOT used to join disk->host
 * - smartscapeNodes "DISK"'s host.name field is null for many disks in this
 * environment; the host<->disk relationship instead comes from
 * hostDiskRawSeries's own {dt.entity.host, dt.entity.disk} grouping, which is
 * populated directly from the metric data and reliable.
 */
export const diskInventory = () => `
smartscapeNodes "DISK"
| fields id, name
`;

// ---------------------------------------------------------------------------
// Kubernetes
// ---------------------------------------------------------------------------

export const k8sNodeCapacity = () => `
timeseries {
  alloc_cpu = avg(dt.kubernetes.node.cpu_allocatable),
  alloc_mem = avg(dt.kubernetes.node.memory_allocatable),
  alloc_pods = avg(dt.kubernetes.node.pods_allocatable),
  cur_pods = avg(dt.kubernetes.pods)
}, by: {k8s.node.name}, ${K8S_WINDOW}
| fieldsAdd
    cpu_millicores = round(arrayAvg(alloc_cpu), decimals: 0),
    mem_gb = round(arrayAvg(alloc_mem) / 1024 / 1024 / 1024, decimals: 1),
    max_pods = round(arrayAvg(alloc_pods), decimals: 0),
    cur_pods = round(arrayAvg(cur_pods), decimals: 0)
| fields k8s.node.name, cpu_millicores, mem_gb, max_pods, cur_pods
| sort k8s.node.name asc
`;

/**
 * Raw (unreduced) per-container CPU/memory usage-vs-request series - the
 * rightsizing table's source data. cpu_usage/cpu_req are millicores,
 * mem_usage/mem_req are bytes (matches the raw `dt.kubernetes.container.*`
 * units, no conversion needed for the kubectl command builder in
 * lib/kubectl.ts). Same "keep the raw array, compute percentile client-side"
 * approach as lib/sizing.ts uses for hosts - one query serves both the list
 * (percentile per container) and the workload detail drawer's chart.
 */
export const k8sWorkloadRawSeries = () => `
timeseries {
  cpu_usage = avg(dt.kubernetes.container.cpu_usage),
  cpu_req = avg(dt.kubernetes.container.requests_cpu),
  mem_usage = avg(dt.kubernetes.container.memory_working_set),
  mem_req = avg(dt.kubernetes.container.requests_memory)
}, by: {k8s.workload.name, k8s.namespace.name, k8s.container.name}, ${K8S_WINDOW}
| filter isNotNull(arrayAvg(cpu_req)) and arrayAvg(cpu_req) > 0
| fields k8s.workload.name, k8s.namespace.name, k8s.container.name,
    interval, timeframe, cpu_usage, cpu_req, mem_usage, mem_req
`;

// ---------------------------------------------------------------------------
// Cloud - built and verified against demo-live (see AGENTS.md); ditmar has no
// cloud entities today so these render an empty table there, which is correct.
// ---------------------------------------------------------------------------

// Raw arrays kept (not reduced to a single avg) so the same query serves
// both the Compute utilization list (percentile computed client-side, see
// lib/sizing.ts) and the instance detail drawer's chart.
export const awsEc2Cpu = () => `
timeseries cpu = avg(cloud.aws.ec2.CPUUtilization.By.InstanceId),
  by: {dt.smartscape_source.id}, ${CLOUD_WINDOW}
| fieldsAdd name = getNodeName(dt.smartscape_source.id)
| fields dt.smartscape_source.id, name, interval, timeframe, cpu
`;

export const azureVmCpu = () => `
timeseries cpu = avg(dt.cloud.azure.vm.cpu_usage),
  by: {dt.smartscape_source.id}, ${CLOUD_WINDOW}
| fieldsAdd name = getNodeName(dt.smartscape_source.id)
| fields dt.smartscape_source.id, name, interval, timeframe, cpu
`;

// GCP's utilization metric is a 0-1 ratio, unlike AWS/Azure's 0-100 percent.
// DQL rejects arithmetic on a timeseries aggregation directly ("has to be a
// metric-based timeseries aggregation"), so the *100 scaling happens
// client-side in Cloud.tsx instead, applied to the raw values.
export const gcpComputeCpu = () => `
timeseries cpu = avg(cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization),
  by: {dt.smartscape_source.id}, ${CLOUD_WINDOW}
| fieldsAdd name = getNodeName(dt.smartscape_source.id)
| fields dt.smartscape_source.id, name, interval, timeframe, cpu
`;

/**
 * ponytail: Azure/GCP branches use the same smartscapeNodes + JSON-parse
 * shape as the AWS query below but were not independently confirmed against
 * a real unattached disk in demo-live (none happened to be in that state) -
 * verify against a real detached disk before trusting those two.
 */
export const awsUnattachedVolumes = () => `
smartscapeNodes "AWS_EC2_VOLUME"
| parse aws.object, "JSON:awsjson"
| fieldsAdd state = awsjson[configuration][state], size_gb = awsjson[configuration][size]
| filter state == "available"
| fields name, aws.resource.id, size_gb, aws.availability_zone, aws.account.id
`;

export const azureUnattachedDisks = () => `
smartscapeNodes "AZURE_MICROSOFT_COMPUTE_DISKS"
| parse azure.object, "JSON:azjson"
| fieldsAdd diskState = azjson[configuration][properties][diskState], size_gb = azjson[configuration][properties][diskSizeGB]
| filter diskState == "Unattached"
| fields name, azure.resource.group, size_gb, azure.location, azure.subscription
`;

export const gcpUnattachedDisks = () => `
smartscapeNodes "GCP_COMPUTE_GOOGLEAPIS_COM_DISK"
| parse gcp.object, "JSON:gcpjson"
| fieldsAdd users = gcpjson[configuration][resource][users], size_gb = gcpjson[configuration][resource][sizeGb]
| filter isNull(users) or arraySize(users) == 0
| fields name, gcp.project.id, size_gb, gcp.zone
`;
