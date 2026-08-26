import { z } from "zod";
import {
  fetchLatestStatus,
  fetchNodes,
  fetchPublicConfig,
  fetchSession,
  listAdminPingTasks,
  listPublicPingTasks,
  queryMetrics as queryMetricsNative,
  queryPingStats,
  type MetricPayloadSeries,
  type MetricQueryParams,
  type MetricQueryPayload,
  type PingStatsParams,
  type PingStatsPayload,
} from "@/services/connect";
import {
  AdminClientSchema,
  type Me,
  type NodeInfo,
  type PublicConfig,
  type AdminClient,
  type LoadRecordsResponse,
  type PingRecordsResponse,
  type PingTask,
  type PingTaskStats,
} from "@/types/komari";
import { fetchWithTimeout } from "@/utils/abort";
import {
  LOAD_LAST_AGGREGATION,
  LOAD_METRIC_KEYS,
  mergeLoadMetricSeries,
  type LoadMetricSeries,
} from "@/utils/loadMetrics";
import {
  mergePingMetricSeries,
  pingTasksFromMetricStats,
  reconcilePingMetricStats,
  PING_LATENCY_METRIC,
  PING_LOSS_METRIC,
  type PingMetricSeries,
} from "@/utils/pingMetrics";
import {
  fillMetricBoundaryGaps,
  getMetricBoundaryRepairRange,
  hasMetricBoundaryGap,
  type MetricBoundaryAggregation,
  type MetricBoundarySeries,
} from "@/utils/metricBoundaryRepair";
import {
  RATE_DOWN_METRIC,
  RATE_UP_METRIC,
  TODAY_TRAFFIC_AGGREGATION,
  TODAY_TRAFFIC_METRIC_KEYS,
  TRAFFIC_DOWN_METRIC,
  TRAFFIC_UP_METRIC,
  type TrafficMetricSeries,
} from "@/utils/trafficStats";

const ApiEnvelope = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const OVERVIEW_METRIC_MAX_POINTS = 24;
const DETAIL_METRIC_MAX_POINTS = 500;
const TODAY_TRAFFIC_TOTAL_MAX_POINTS = 12;
// 仅剩的普通 HTTP 调用(主题设置保存、后台节点列表)自身没有传输超时,
// 在这里统一兜底,half-open socket 能快速失败而不是无限挂住调用方。
const DEFAULT_API_TIMEOUT_MS = 12_000;

interface PingOverviewResponse {
  records: PingRecordsResponse["records"];
  tasks: PingTask[];
  rangeStartMs?: number;
  rangeEndMs?: number;
  intervalSeconds?: number;
  stats?: PingTaskStats[];
}

interface RequestRange {
  rangeStartMs: number;
  rangeEndMs: number;
}

interface ApiCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

type LoadRecordsOptions = ApiCallOptions;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function createRequestRange(hours: number, now = Date.now()): RequestRange {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 1;
  return {
    rangeStartMs: now - safeHours * 60 * 60 * 1000,
    rangeEndMs: now,
  };
}

function getMetricPayloadRange(
  payload: MetricQueryPayload,
  fallback: RequestRange,
): RequestRange {
  const start = Date.parse(payload.start ?? "");
  const end = Date.parse(payload.end ?? "");
  return {
    rangeStartMs: Number.isFinite(start) ? start : fallback.rangeStartMs,
    rangeEndMs: Number.isFinite(end) ? end : fallback.rangeEndMs,
  };
}

async function apiGet<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<T> {
  const resp = await fetchWithTimeout(
    path,
    {
      credentials: "include",
      headers: { Accept: "application/json" },
    },
    options?.timeout ?? DEFAULT_API_TIMEOUT_MS,
    options?.signal,
  );
  if (!resp.ok) {
    throw new ApiRequestError(`Request ${path} failed: ${resp.status}`, resp.status, path);
  }
  const json = (await resp.json()) as unknown;
  const envelopeResult = ApiEnvelope.safeParse(json);
  if (envelopeResult.success) {
    const envelope = envelopeResult.data;
    if (envelope.status?.toLowerCase() === "error") {
      throw new ApiRequestError(
        envelope.message || `Request ${path} failed`,
        resp.status,
        path,
      );
    }
    if (Object.prototype.hasOwnProperty.call(envelope, "data")) {
      const dataResult = schema.safeParse(envelope.data);
      if (dataResult.success) return dataResult.data;
      throw new Error(
        `Schema mismatch on ${path}: envelope=${dataResult.error.issues[0]?.message ?? ""}`,
      );
    }
  }
  const rawResult = schema.safeParse(json);
  if (rawResult.success) return rawResult.data;
  // 两种解析错误都抛出来:enveloped 接口看 envelope 错误,裸 array/object 接口看 raw
  // 错误,而这里无法判断接口本该返回哪种结构。
  throw new Error(
    `Schema mismatch on ${path}: envelope=${
      envelopeResult.success ? "" : envelopeResult.error.issues[0]?.message ?? ""
    }; raw=${rawResult.error.issues[0]?.message ?? ""}`,
  );
}

let publicPingTasksCache: PingTask[] | null = null;
let publicPingTasksCachedAt = 0;
let publicPingTasksRequest: Promise<PingTask[]> | null = null;

// 降级链全程静默会让「统计缺失」与「一切正常」无法区分,每类降级警告一次。
const degradeWarned = new Set<string>();
export function warnDegradedOnce(key: string, message: string) {
  if (degradeWarned.has(key)) return;
  degradeWarned.add(key);
  console.warn(`[Junimo] ${message}`);
}

function requestDeadline(timeout?: number) {
  return typeof timeout === "number" && Number.isFinite(timeout)
    ? Date.now() + Math.max(0, timeout)
    : null;
}

function remainingRequestTimeout(deadline: number | null) {
  return deadline == null ? undefined : Math.max(0, deadline - Date.now());
}

/**
 * 延迟统计。
 *
 * 统计量由服务端算好;失败时返回 null,交由调用方用逐点序列本地兜底,
 * 图表主路径不因统计子请求失败而中断。
 */
async function queryPingMetricStatsPayload(
  params: PingStatsParams,
  options?: ApiCallOptions,
): Promise<PingStatsPayload | null> {
  try {
    return await queryPingStats(params, options);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    warnDegradedOnce("ping-stats", "Ping 统计接口失败,已由逐点序列本地兜底计算");
    return null;
  }
}

const queryMetricPayload = (
  params: MetricQueryParams,
  signal?: AbortSignal,
  timeout?: number,
) => queryMetricsNative(params, { signal, timeout });

function loadPublicPingTasks() {
  if (publicPingTasksCache && Date.now() - publicPingTasksCachedAt < 60_000) {
    return Promise.resolve(publicPingTasksCache);
  }
  if (publicPingTasksRequest) return publicPingTasksRequest;

  publicPingTasksRequest = listPublicPingTasks()
    // Connect 消息是精确类型,而 PingTask 出自 passthrough schema(带索引签名),
    // 两者结构一致但不能隐式互转,这里与本文件其他边界一样显式收窄。
    .then((tasks) => tasks as PingTask[])
    .then((tasks) => {
      if (tasks.length > 0) {
        publicPingTasksCache = tasks;
        publicPingTasksCachedAt = Date.now();
      } else {
        publicPingTasksCache = null;
        publicPingTasksCachedAt = 0;
      }
      return tasks;
    })
    .finally(() => {
      publicPingTasksRequest = null;
    });
  return publicPingTasksRequest;
}

export function prewarmPingOverviewDependencies() {
  void loadPublicPingTasks().catch(() => undefined);
}
function normalizePingMetricStats(
  payload: PingStatsPayload,
): PingTaskStats[] {
  const out: PingTaskStats[] = [];
  for (const item of payload.stats) {
    const taskId = Number.parseInt(String(item.task_id), 10);
    if (!Number.isFinite(taskId) || taskId <= 0 || !item.entity_id) continue;
    out.push({
      client: item.entity_id,
      taskId,
      name: item.name,
      type: item.type,
      interval: item.interval,
      total: item.total,
      valid: item.valid,
      loss: item.loss,
      min: item.min ?? null,
      max: item.max ?? null,
      avg: item.avg ?? null,
      latest: item.latest ?? null,
      p50: item.p50 ?? null,
      p99: item.p99 ?? null,
      stddev: item.stddev ?? null,
      p99P50Ratio: item.p99_p50_ratio,
    });
  }
  return out;
}

/** 公开任务列表与统计都拿不到任务名时，按 records 里出现过的 task_id 兜出占位任务。 */
function derivePingTasks(records: PingRecordsResponse["records"]): PingTask[] {
  return Array.from(new Set(records.map((record) => record.task_id)))
    .sort((a, b) => a - b)
    .map((id) => ({
      id,
      interval: 60,
      name: `任务 #${id}`,
      loss: 0,
      clients: [],
      type: "icmp",
      target: "",
      weight: id,
    }));
}

function rawMetricPoints(item: MetricPayloadSeries) {
  return item.points.map((point) => ({
    ...point,
    // 支持混合查询的后端可在边界小窗口同时返回 raw 与 rollup；
    // rollup 的 count 是真实样本数，不能强制改成 1。旧后端 raw 点未返回 count 时才回退为 1。
    count: point.count > 0 ? point.count : point.value == null ? 0 : 1,
  }));
}

async function repairMetricBoundary<T extends MetricBoundarySeries>(
  aggregateSeries: T[],
  metricPayload: MetricQueryPayload,
  requestRange: RequestRange,
  rawParams: Record<string, unknown>,
  mapRawSeries: (item: MetricPayloadSeries, intervalSeconds: number) => T,
  aggregationByMetric: Partial<Record<string, MetricBoundaryAggregation>> = {},
  signal?: AbortSignal,
  timeout?: number,
) {
  const payloadRange = getMetricPayloadRange(metricPayload, requestRange);
  const repairRange = getMetricBoundaryRepairRange(
    payloadRange.rangeStartMs,
    payloadRange.rangeEndMs,
  );
  if (!repairRange || !hasMetricBoundaryGap(aggregateSeries, repairRange)) {
    return aggregateSeries;
  }

  const deadline = requestDeadline(timeout);
  try {
    const rawPayload = await queryMetricPayload(
      {
        ...rawParams,
        start: new Date(repairRange.startMs).toISOString(),
        end: new Date(repairRange.endMs).toISOString(),
        downsample: false,
        fill_empty: false,
      },
      signal,
      remainingRequestTimeout(deadline),
    );
    const fallbackInterval = Math.max(
      0,
      ...aggregateSeries.map((item) => item.intervalSeconds ?? 0),
    );
    const rawSeries = rawPayload.series.map((item) =>
      mapRawSeries(item, fallbackInterval),
    );
    return fillMetricBoundaryGaps(
      aggregateSeries,
      rawSeries,
      aggregationByMetric,
    ).series;
  } catch (error) {
    if (signal?.aborted) throw error;
    warnDegradedOnce("boundary-repair", "边界补点查询失败,保留聚合序列(尾部可能缺最新桶)");
    return aggregateSeries;
  }
}

async function getLoadMetricData(
  uuid: string,
  hours: number,
  signal?: AbortSignal,
  timeout?: number,
): Promise<LoadRecordsResponse> {
  const requestRange = createRequestRange(hours);
  const metricPayload = await queryMetricPayload(
    {
      hours,
      entity_ids: [uuid],
      metric_keys: LOAD_METRIC_KEYS,
      max_points: DETAIL_METRIC_MAX_POINTS,
      aggregation: "avg",
      aggregation_by_metric: LOAD_LAST_AGGREGATION,
      fill_empty: false,
    },
    signal,
    timeout,
  );
  const series: LoadMetricSeries[] = metricPayload.series.map((item) => ({
    metricKey: item.metric_key,
    client: item.entity_id,
    intervalSeconds: item.interval_seconds,
    points: item.points,
  }));
  const records = mergeLoadMetricSeries(series);
  const intervalSeconds = Math.max(
    0,
    ...metricPayload.series.map((item) => item.interval_seconds),
  );
  return {
    count: records.length,
    records,
    ...getMetricPayloadRange(metricPayload, requestRange),
    intervalSeconds: intervalSeconds > 0 ? intervalSeconds : undefined,
  };
}

async function getPingMetricData({
  hours,
  entityIds,
  taskId,
  maxPoints,
  includeStats = false,
  repairBoundary = false,
  signal,
  timeout,
}: {
  hours: number;
  entityIds?: string[];
  taskId?: number;
  maxPoints: number;
  includeStats?: boolean;
  repairBoundary?: boolean;
  signal?: AbortSignal;
  timeout?: number;
}): Promise<PingRecordsResponse> {
  const deadline = requestDeadline(timeout);
  const requestRange = createRequestRange(hours);
  const commonParams = {
    hours,
    ...(entityIds?.length ? { entity_ids: entityIds } : {}),
    ...(taskId != null ? { task_id: taskId } : {}),
    max_points: maxPoints,
  };

  const statsRequest = includeStats
    ? queryPingMetricStatsPayload(commonParams, {
        signal,
        timeout: remainingRequestTimeout(deadline),
      })
    : Promise.resolve(null);
  const [metricPayload, statsPayload, publicTasks] = await Promise.all([
    queryMetricPayload(
      {
        ...commonParams,
        metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
        ...(taskId != null ? { tags: { task_id: String(taskId) } } : {}),
        aggregation: "avg",
        fill_empty: false,
      },
      signal,
      remainingRequestTimeout(deadline),
    ),
    statsRequest,
    loadPublicPingTasks().catch(() => {
      warnDegradedOnce("public-ping-tasks", "公开 Ping 任务列表获取失败,任务名将按 records 推导");
      return null;
    }),
  ]);
  let series: PingMetricSeries[] = metricPayload.series.map((item) => ({
    metricKey: item.metric_key,
    client: item.entity_id,
    tags: item.tags ?? {},
    intervalSeconds: item.interval_seconds,
    points: item.points,
  }));
  if (repairBoundary && entityIds?.length) {
    series = await repairMetricBoundary(
      series,
      metricPayload,
      requestRange,
      {
        entity_ids: entityIds,
        metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
        ...(taskId != null ? { tags: { task_id: String(taskId) } } : {}),
      },
      (item, intervalSeconds) => ({
        metricKey: item.metric_key,
        client: item.entity_id,
        tags: item.tags ?? {},
        intervalSeconds,
        points: rawMetricPoints(item),
      }),
      {},
      signal,
      remainingRequestTimeout(deadline),
    );
  }
  const records = mergePingMetricSeries(series);
  const stats = reconcilePingMetricStats(
    statsPayload ? normalizePingMetricStats(statsPayload) : [],
    records,
  );
  const intervalSeconds = Math.max(
    0,
    ...metricPayload.series.map((item) => item.interval_seconds),
  );
  const observedTaskIds = new Set([
    ...records.map((record) => record.task_id),
    ...stats.map((stat) => stat.taskId),
  ]);
  const statByTask = new Map(stats.map((stat) => [stat.taskId, stat] as const));
  const tasks = publicTasks
    ?.filter((task) => observedTaskIds.has(task.id))
    .map((task) => ({
      ...task,
      loss: statByTask.get(task.id)?.loss ?? task.loss,
    }));
  const statsTasks = pingTasksFromMetricStats(stats);
  return {
    count: records.length,
    records,
    ...getMetricPayloadRange(metricPayload, requestRange),
    intervalSeconds: intervalSeconds > 0 ? intervalSeconds : undefined,
    tasks:
      tasks && tasks.length > 0
        ? tasks
        : statsTasks.length > 0
          ? statsTasks
          : derivePingTasks(records),
    stats,
  };
}

// Connect 消息是精确类型,而 Me / PublicConfig / NodeInfo 出自 passthrough schema
// (带索引签名),两者结构一致但不能隐式互转,以下边界统一显式收窄。
export async function getMe(options?: ApiCallOptions): Promise<Me> {
  return (await fetchSession(options)) as Me;
}

export async function getPublic(options?: ApiCallOptions): Promise<PublicConfig> {
  return (await fetchPublicConfig(options)) as PublicConfig;
}

/**
 * 当前状态快照。
 *
 * 由 WatchAgentStatus 的长连接在后台持续更新,这里只读快照——上层按 tick 取值的
 * 节奏不变,但不再每个 tick 发一次请求。
 */
export async function getNodesLatestStatus(
  uuids?: string[],
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  return fetchLatestStatus(uuids, options);
}

export async function getNodes(options?: ApiCallOptions): Promise<NodeInfo[]> {
  // ListAgents 按站点的「向访客展示 IP」设置下发 ipv4/ipv6（管理员全量、访客打码），
  // 因此前端仍能显示 V4/V6。
  return (await fetchNodes(options)) as NodeInfo[];
}

export async function getAdminClients(options?: ApiCallOptions): Promise<AdminClient[]> {
  return (await apiGet("/api/admin/client/list", z.array(AdminClientSchema), options)) as AdminClient[];
}

export async function getLoadRecords(
  uuid: string,
  hours = 6,
  options?: LoadRecordsOptions,
): Promise<LoadRecordsResponse> {
  return getLoadMetricData(uuid, hours, options?.signal, options?.timeout);
}

export interface TodayTrafficMetricResponse {
  series: TrafficMetricSeries[];
  rangeStartMs: number;
  rangeEndMs: number;
  intervalSeconds?: number;
}

/**
 * 查询浏览器本地“今天”的流量增量与上下行采样峰值。服务端按 5 分钟左右聚合，
 * 流量使用 sum、速率使用 max；前端随后再汇总到每台节点，避免拉取全天原始点。
 */
export async function getTodayTrafficMetrics(
  entityIds: string[],
  startMs: number,
  endMs: number,
  options?: ApiCallOptions,
): Promise<TodayTrafficMetricResponse> {
  if (entityIds.length === 0) {
    return { series: [], rangeStartMs: startMs, rangeEndMs: endMs };
  }

  const fiveMinutesMs = 5 * 60 * 1000;
  const deadline = requestDeadline(options?.timeout);
  const maxPoints = Math.max(1, Math.ceil((endMs - startMs) / fiveMinutesMs));
  const totalMaxPoints = Math.min(TODAY_TRAFFIC_TOTAL_MAX_POINTS, maxPoints);
  const requestRange = { rangeStartMs: startMs, rangeEndMs: endMs };
  const metricPayload = await queryMetricPayload(
    {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      entity_ids: entityIds,
      metric_keys: TODAY_TRAFFIC_METRIC_KEYS,
      max_points: maxPoints,
      max_points_by_metric: {
        [TRAFFIC_UP_METRIC]: totalMaxPoints,
        [TRAFFIC_DOWN_METRIC]: totalMaxPoints,
        [RATE_UP_METRIC]: maxPoints,
        [RATE_DOWN_METRIC]: maxPoints,
      },
      aggregation_by_metric: TODAY_TRAFFIC_AGGREGATION,
      fill_empty: false,
    },
    options?.signal,
    remainingRequestTimeout(deadline),
  );
  let series: TrafficMetricSeries[] = metricPayload.series.map((item) => ({
    metricKey: item.metric_key,
    client: item.entity_id,
    intervalSeconds: item.interval_seconds,
    points: item.points,
  }));
  series = await repairMetricBoundary(
    series,
    metricPayload,
    requestRange,
    {
      entity_ids: entityIds,
      metric_keys: TODAY_TRAFFIC_METRIC_KEYS,
    },
    (item, intervalSeconds) => ({
      metricKey: item.metric_key,
      client: item.entity_id,
      intervalSeconds,
      points: rawMetricPoints(item),
    }),
    TODAY_TRAFFIC_AGGREGATION,
    options?.signal,
    remainingRequestTimeout(deadline),
  );
  const intervalSeconds = Math.max(0, ...series.map((item) => item.intervalSeconds ?? 0));
  return {
    series,
    ...getMetricPayloadRange(metricPayload, requestRange),
    intervalSeconds: intervalSeconds > 0 ? intervalSeconds : undefined,
  };
}

export async function getPingRecords(
  uuid: string,
  hours = 6,
  options?: ApiCallOptions,
): Promise<PingRecordsResponse> {
  // includeStats:records 与 stats 并行走同一次调用链,省掉实例页单独的 stats 往返;
  // stats 子请求失败会被内部吞掉,由 records 本地兜底,不影响图表主路径。
  return getPingMetricData({
    hours,
    entityIds: [uuid],
    maxPoints: DETAIL_METRIC_MAX_POINTS,
    includeStats: true,
    signal: options?.signal,
    timeout: options?.timeout,
  });
}

export async function getAdminPingTasks(options?: ApiCallOptions): Promise<PingTask[]> {
  return (await listAdminPingTasks(options)) as PingTask[];
}

export async function saveThemeSettings(
  theme: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const resp = await fetchWithTimeout(
    `/api/admin/theme/settings?theme=${encodeURIComponent(theme)}`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    },
    DEFAULT_API_TIMEOUT_MS,
  );

  if (!resp.ok) {
    let message = `Request /api/admin/theme/settings failed: ${resp.status}`;
    try {
      const json = (await resp.json()) as { message?: string };
      if (json?.message) {
        message = json.message;
      }
    } catch {
      // body 不是 JSON 时保留兜底错误信息。
    }
    throw new ApiRequestError(message, resp.status, "/api/admin/theme/settings");
  }
}

export async function getPingOverviewStats(
  hours: number,
  taskIds: number[],
  options?: ApiCallOptions & { entityIds?: string[] },
): Promise<PingTaskStats[]> {
  const normalizedTaskIds = Array.from(
    new Set(taskIds.filter((taskId) => Number.isInteger(taskId) && taskId > 0)),
  ).sort((left, right) => left - right);
  if (normalizedTaskIds.length === 0) return [];

  const payload = await queryPingMetricStatsPayload(
    {
      hours,
      task_ids: normalizedTaskIds,
      ...(options?.entityIds?.length ? { entity_ids: options.entityIds } : {}),
      max_points: OVERVIEW_METRIC_MAX_POINTS,
    },
    { signal: options?.signal, timeout: options?.timeout },
  );
  return payload ? normalizePingMetricStats(payload) : [];
}

export async function getPingOverview(
  hours = 1,
  taskId?: number,
  options?: { signal?: AbortSignal; entityIds?: string[]; includeStats?: boolean },
): Promise<PingOverviewResponse> {
  return getPingMetricData({
    hours,
    entityIds: options?.entityIds,
    taskId,
    maxPoints: OVERVIEW_METRIC_MAX_POINTS,
    includeStats: options?.includeStats ?? true,
    repairBoundary: true,
    signal: options?.signal,
  });
}
