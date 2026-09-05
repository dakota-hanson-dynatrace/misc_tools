// Rightsizing math, mirrors the source dashboard's defaults: CPU sized off
// p90 usage, memory sized off p100 (peak) usage, both with a 10% buffer.
// ponytail: buffer/percentile are hardcoded, not a settings UI - the user
// didn't ask for tunable knobs. Add a settings panel if that's ever needed.
const BUFFER = 1.1;
const CPU_STEP_M = 5; // round CPU requests to the nearest 5m, like the source dashboard
const MEM_STEP_MI = 1; // round memory requests to the nearest 1Mi

export interface WorkloadSlackRow {
  'k8s.workload.name': string;
  'k8s.namespace.name': string;
  'k8s.container.name': string;
  cpu_p90_avg: number;
  cpu_req_avg: number;
  mem_p100_avg: number;
  mem_req_avg: number;
}

export interface Recommendation {
  recommendedCpuRequestM: number;
  recommendedCpuLimitM: number;
  cpuSlackM: number;
  recommendedMemRequestMi: number;
  recommendedMemLimitMi: number;
  memSlackMi: number;
  cpuCommand: string;
  memCommand: string;
}

const bytesToMi = (bytes: number) => bytes / 1024 / 1024;
const roundUpTo = (value: number, step: number) => Math.ceil(value / step) * step;

export function computeRecommendation(row: WorkloadSlackRow): Recommendation {
  const recommendedCpuRequestM = roundUpTo(row.cpu_p90_avg * BUFFER, CPU_STEP_M);
  // ponytail: limit sized as 1.3x the recommended request (a common headroom
  // ratio) - the source dashboard derives limit from a separate percentile
  // this app doesn't query. Revisit if per-container limit accuracy matters.
  const recommendedCpuLimitM = roundUpTo(recommendedCpuRequestM * 1.3, CPU_STEP_M);
  const cpuSlackM = row.cpu_req_avg - recommendedCpuRequestM;

  const recommendedMemRequestMi = roundUpTo(bytesToMi(row.mem_p100_avg) * BUFFER, MEM_STEP_MI);
  const recommendedMemLimitMi = recommendedMemRequestMi;
  const memSlackMi = bytesToMi(row.mem_req_avg) - recommendedMemRequestMi;

  const workload = row['k8s.workload.name'];
  const container = row['k8s.container.name'];
  const namespace = row['k8s.namespace.name'];
  const oldCpuReqM = Math.round(row.cpu_req_avg);
  const oldMemReqMi = Math.round(bytesToMi(row.mem_req_avg));

  const cpuCommand =
    `kubectl set resources deployment ${workload} -c ${container} -n ${namespace} ` +
    `--requests=cpu=${recommendedCpuRequestM}m --limits=cpu=${recommendedCpuLimitM}m ` +
    `# was: requests:${oldCpuReqM}m slack:${Math.round(cpuSlackM)}m`;

  const memCommand =
    `kubectl set resources deployment ${workload} -c ${container} -n ${namespace} ` +
    `--requests=memory=${recommendedMemRequestMi}Mi --limits=memory=${recommendedMemLimitMi}Mi ` +
    `# was: requests:${oldMemReqMi}Mi slack:${Math.round(memSlackMi)}Mi`;

  return {
    recommendedCpuRequestM,
    recommendedCpuLimitM,
    cpuSlackM,
    recommendedMemRequestMi,
    recommendedMemLimitMi,
    memSlackMi,
    cpuCommand,
    memCommand,
  };
}
