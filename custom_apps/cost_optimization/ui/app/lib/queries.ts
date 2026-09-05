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

export const hostUsage = () => `
timeseries {
  cpu = avg(dt.host.cpu.usage),
  mem = avg(dt.host.memory.usage),
  disk = avg(dt.host.disk.used.percent)
}, by: {dt.entity.host}, ${HOST_WINDOW}
| fieldsAdd
    host_name = getNodeName(dt.entity.host),
    cpu_avg = round(arrayAvg(cpu), decimals: 1),
    mem_avg = round(arrayAvg(mem), decimals: 1),
    disk_avg = round(arrayAvg(disk), decimals: 1)
| fields dt.entity.host, host_name, cpu_avg, mem_avg, disk_avg
| sort cpu_avg desc
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
 * Per-container CPU/memory request vs. actual usage - the rightsizing table.
 * cpu_p90/cpu_req are millicores, mem_p100/mem_req are bytes (matches the raw
 * `dt.kubernetes.container.*` units, no conversion needed for the kubectl
 * command builder in lib/kubectl.ts).
 */
export const k8sWorkloadSlack = () => `
timeseries {
  cpu_p90 = percentile(dt.kubernetes.container.cpu_usage, 90, rollup: "avg"),
  cpu_req = avg(dt.kubernetes.container.requests_cpu),
  mem_p100 = percentile(dt.kubernetes.container.memory_working_set, 100, rollup: "avg"),
  mem_req = avg(dt.kubernetes.container.requests_memory)
}, by: {k8s.workload.name, k8s.namespace.name, k8s.container.name}, ${K8S_WINDOW}
| fieldsAdd
    cpu_p90_avg = arrayAvg(cpu_p90),
    cpu_req_avg = arrayAvg(cpu_req),
    mem_p100_avg = arrayAvg(mem_p100),
    mem_req_avg = arrayAvg(mem_req)
| filter isNotNull(cpu_req_avg) and cpu_req_avg > 0
| fields k8s.workload.name, k8s.namespace.name, k8s.container.name,
    cpu_p90_avg, cpu_req_avg, mem_p100_avg, mem_req_avg
`;

// ---------------------------------------------------------------------------
// Cloud - built and verified against demo-live (see AGENTS.md); ditmar has no
// cloud entities today so these render an empty table there, which is correct.
// ---------------------------------------------------------------------------

export const awsEc2Cpu = () => `
timeseries cpu = avg(cloud.aws.ec2.CPUUtilization.By.InstanceId),
  by: {dt.smartscape_source.id}, ${CLOUD_WINDOW}
| fieldsAdd name = getNodeName(dt.smartscape_source.id), cpu_avg = round(arrayAvg(cpu), decimals: 1)
| fields dt.smartscape_source.id, name, cpu_avg
`;

export const azureVmCpu = () => `
timeseries cpu = avg(dt.cloud.azure.vm.cpu_usage),
  by: {dt.smartscape_source.id}, ${CLOUD_WINDOW}
| fieldsAdd name = getNodeName(dt.smartscape_source.id), cpu_avg = round(arrayAvg(cpu), decimals: 1)
| fields dt.smartscape_source.id, name, cpu_avg
`;

export const gcpComputeCpu = () => `
timeseries cpu = avg(cloud.gcp.gce_instance.compute_googleapis_com.instance.cpu.utilization),
  by: {dt.smartscape_source.id}, ${CLOUD_WINDOW}
| fieldsAdd name = getNodeName(dt.smartscape_source.id), cpu_avg = round(arrayAvg(cpu) * 100, decimals: 1)
| fields dt.smartscape_source.id, name, cpu_avg
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
