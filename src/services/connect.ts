/**
 * Komari Connect 传输层。
 *
 * 主题的全部数据读取都经由 Connect：BrowserService（站点信息、会话、节点列表、
 * 状态推送）、MetricsService（指标查询与延迟统计）、admin.v1.PingTaskService
 * （后台延迟任务）。旧的 JSON-RPC 2.0 通道与其能力探测已整体移除。
 *
 * 这里只做「Connect 消息 ↔ 主题既有数据形状」的转换，聚合、补点、排序等展示逻辑
 * 仍留在 services/api.ts 与 wsStore.ts 里，不随传输层改动。
 */
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { Duration, Timestamp } from "@bufbuild/protobuf/wkt";
import {
  AgentStatus,
  BrowserService,
} from "@komari/proto/komari/browser/v1/browser_pb";
import type {
  AgentSummary,
  GetPublicInfoResponse,
} from "@komari/proto/komari/browser/v1/browser_pb";
import { MetricsService } from "@komari/proto/komari/metrics/v1/metrics_pb";
import { PingTaskService } from "@komari/proto/komari/admin/v1/ping_pb";
import type { AgentReport } from "@komari/proto/komari/report/v1/report_pb";
import {
  isDevMock,
  mockGetLatestStatus,
  mockGetNodes,
  mockGetPingStats,
  mockGetPingTasks,
  mockGetPublicConfig,
  mockGetSession,
  mockQueryMetrics,
} from "@/dev/mockApi";

const transport = createConnectTransport({
  baseUrl:
    typeof window === "undefined" ? "http://localhost" : window.location.origin,
  useBinaryFormat: true,
  // 站点可能开启私有访问，凭据必须随请求发出，否则会被判为访客。
  fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }),
});

export const browserClient = createClient(BrowserService, transport);
export const metricsClient = createClient(MetricsService, transport);
export const pingTaskClient = createClient(PingTaskService, transport);

export interface ConnectCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

const callOptions = (options?: ConnectCallOptions) => ({
  signal: options?.signal,
  ...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
});

/** protobuf 的 uint64 在 TS 里是 bigint，主题各处按 number 计算。 */
const asNumber = (value?: bigint) => Number(value ?? 0n);

const isoOf = (value?: Timestamp) =>
  value ? timestampDate(value).toISOString() : "";

const secondsOf = (value?: Duration) =>
  value ? Number(value.seconds) : 0;

// ---------------------------------------------------------------- 站点与会话

export async function fetchPublicConfig(options?: ConnectCallOptions) {
  if (isDevMock()) return mockGetPublicConfig();
  const info: GetPublicInfoResponse = await browserClient.getPublicInfo(
    {},
    callOptions(options),
  );
  return {
    sitename: info.siteName,
    description: info.siteDescription,
    theme: info.defaultTheme,
    allow_cors: info.corsOriginCheckEnabled,
    disable_password_login: info.disablePasswordLogin,
    oauth_enable: info.oauthEnabled,
    private_site: info.privateSite,
    // 采集开关不在公开契约里；保留期为 0 时上层按「未限制」处理。
    record_enabled: true,
    record_preserve_time: info.metricRetentionDays * 24,
    ping_record_preserve_time: info.metricRetentionDays * 24,
    metric_retention_days: info.metricRetentionDays,
    custom_head: info.customHead,
    custom_body: info.customBody,
    theme_settings: (info.themeSettings ?? {}) as Record<string, unknown>,
  };
}

export async function fetchSession(options?: ConnectCallOptions) {
  if (isDevMock()) return mockGetSession();
  const session = await browserClient.getSession({}, callOptions(options));
  return {
    logged_in: session.loggedIn,
    username: session.username,
    uuid: session.userId,
  };
}

// ---------------------------------------------------------------- 节点列表

const nodeInfoOf = (agent: AgentSummary) => {
  const basic = agent.basicInfo;
  return {
    uuid: agent.agentId,
    name: agent.name,
    group: basic?.group ?? "",
    region: basic?.region ?? "",
    // 隐藏节点由服务端对访客直接过滤，能取到的一律是可见节点。
    hidden: false,
    cpu_name: basic?.cpuName ?? "",
    cpu_cores: basic?.cpuCores ?? 0,
    arch: basic?.architecture ?? "",
    virtualization: basic?.virtualization ?? "",
    os: basic?.os ?? "",
    kernel_version: basic?.kernelVersion ?? "",
    gpu_name: basic?.gpuName ?? "",
    mem_total: asNumber(basic?.memoryTotalBytes),
    swap_total: asNumber(basic?.swapTotalBytes),
    disk_total: asNumber(basic?.diskTotalBytes),
    weight: basic?.weight ?? 0,
    price: basic?.price ?? 0,
    // 一次性付费在数据模型里是负周期，无符号的 billing_cycle_days 装不下，
    // 服务端改用独立标志下发，这里还原成主题沿用的 "-1"。
    billing_cycle: basic?.billingOneTime ? "-1" : String(basic?.billingCycleDays ?? 0),
    auto_renewal: basic?.autoRenewal ?? false,
    currency: basic?.currency ?? "",
    expired_at: isoOf(basic?.expiresAt),
    tags: basic?.tags ?? "",
    public_remark: basic?.publicRemark ?? "",
    traffic_limit: asNumber(basic?.trafficLimitBytes),
    traffic_limit_type: basic?.trafficLimitType ?? "",
    traffic_next_reset:
      isoOf(
        (agent as unknown as { trafficAccounting?: { nextReset?: Timestamp } })
          .trafficAccounting?.nextReset,
      ) ||
      isoOf(
        (basic as unknown as { trafficNextReset?: Timestamp })?.trafficNextReset,
      ) ||
      "",
    // ListAgents 按站点的「向访客展示 IP」设置决定是否下发，管理员拿到完整值。
    ipv4: basic?.ipv4 ?? "",
    ipv6: basic?.ipv6 ?? "",
    created_at: isoOf(basic?.createdAt),
    updated_at: isoOf(basic?.updatedAt),
  };
};

export async function fetchNodes(options?: ConnectCallOptions) {
  if (isDevMock()) return mockGetNodes();
  const response = await browserClient.listAgents({}, callOptions(options));
  return response.agents.map(nodeInfoOf);
}

// ---------------------------------------------------------------- 实时状态

/** Agent 会额外上报一条名为 aggregate 的汇总项；没有时退回第一块网卡/磁盘。 */
const realtimeOf = (agent: AgentSummary, report?: AgentReport) => {
  const resources = report?.resources;
  const network =
    report?.networkInterfaces.find((item) => item.name === "aggregate") ??
    report?.networkInterfaces[0];
  const disk =
    report?.disks.find((item) => item.mountPoint === "aggregate") ??
    report?.disks[0];

  const gpus = resources?.gpus ?? [];
  let gpu:
    | {
        usage: number;
        memUsed: number;
        memTotal: number;
        count?: number;
        name?: string;
      }
    | undefined = undefined;
  if (gpus.length > 0) {
    const memTotal = gpus.reduce((acc, g) => acc + asNumber(g.memoryTotalBytes), 0);
    const memUsed = gpus.reduce((acc, g) => acc + asNumber(g.memoryUsedBytes), 0);
    const measuredGpus = gpus.filter((g) => g.utilizationPercent !== undefined);
    const usage =
      measuredGpus.length > 0
        ? measuredGpus.reduce((acc, g) => acc + (g.utilizationPercent ?? 0), 0) / measuredGpus.length
        : 0;
    gpu = {
      usage,
      memUsed,
      memTotal,
      count: gpus.length,
      name: gpus[0]?.name || agent.basicInfo?.gpuName || "",
    };
  }

  return {
    cpu: { usage: resources?.cpuPercent ?? 0 },
    gpu,
    ram: {
      total: asNumber(report?.system?.memoryTotalBytes),
      used: asNumber(resources?.memoryUsedBytes),
    },
    swap: {
      total: asNumber(resources?.swapTotalBytes),
      used: asNumber(resources?.swapUsedBytes),
    },
    load: {
      load1: resources?.loadAverage[0] ?? 0,
      load5: resources?.loadAverage[1] ?? 0,
      load15: resources?.loadAverage[2] ?? 0,
    },
    disk: { total: asNumber(disk?.totalBytes), used: asNumber(disk?.usedBytes) },
    network: {
      up: asNumber(network?.bytesSentPerSecond),
      down: asNumber(network?.bytesReceivedPerSecond),
      totalUp: asNumber(network?.bytesSent),
      totalDown: asNumber(network?.bytesReceived),
    },
    connections: {
      tcp: asNumber(resources?.tcpConnectionCount),
      udp: asNumber(resources?.udpConnectionCount),
    },
    uptime: secondsOf(report?.system?.uptime),
    process: asNumber(resources?.processCount),
    online: agent.status === AgentStatus.ONLINE,
    updated_at: isoOf(report?.observedAt),
  };
};

/**
 * 由 WatchAgentStatus 维护的最新状态快照。
 *
 * 上层的 wsStore 按 tick 读取当前状态，这里用一条长连接持续接收推送并就地更新
 * 快照，取代过去每个 tick 一次的轮询请求：既少了往返，也不会在后端安静时空转。
 */
const snapshot = new Map<string, ReturnType<typeof realtimeOf>>();
let streamStarted = false;
let firstEvent: Promise<void> | null = null;

const startLiveStatusStream = () => {
  if (streamStarted) return;
  streamStarted = true;

  const pendingFirst: { resolve?: () => void } = {};
  firstEvent = new Promise<void>((resolve) => {
    pendingFirst.resolve = resolve;
  });

  void (async () => {
    let afterEventId = "";
    for (;;) {
      try {
        for await (const event of browserClient.watchAgentStatus(
          { agentIds: [], afterEventId },
          { timeoutMs: 0 },
        )) {
          const agent = event.agent;
          if (!agent) continue;
          // 记住事件位点，重连时不必从头重放。
          afterEventId = agent.eventId || afterEventId;
          snapshot.set(agent.agentId, realtimeOf(agent, event.latestReport));
          pendingFirst.resolve?.();
          pendingFirst.resolve = undefined;
        }
      } catch {
        // 断开按重连处理；首个事件的等待者不会被永久挂住，见下面的超时。
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
  })();
};

/**
 * 读取当前状态快照。
 *
 * 首次调用要等第一条推送到达才有数据；等待有上限，超时后返回空快照交由上层的
 * 失败退避处理，避免首屏被一条迟迟不来的流卡住。
 */
export async function fetchLatestStatus(
  uuids?: string[],
  options?: ConnectCallOptions,
): Promise<Record<string, unknown>> {
  if (isDevMock()) return mockGetLatestStatus(uuids);
  startLiveStatusStream();
  if (snapshot.size === 0 && firstEvent) {
    const budget = options?.timeout ?? 10_000;
    await Promise.race([
      firstEvent,
      new Promise<void>((resolve) => setTimeout(resolve, budget)),
    ]);
  }
  if (!uuids || uuids.length === 0) return Object.fromEntries(snapshot);
  const result: Record<string, unknown> = {};
  for (const uuid of uuids) {
    const value = snapshot.get(uuid);
    if (value) result[uuid] = value;
  }
  return result;
}

// ---------------------------------------------------------------- 指标查询

export interface MetricQueryParams {
  entity_ids?: string[];
  // 调用方常以 as const 声明指标集合，这里接受只读数组。
  metric_keys?: readonly string[];
  hours?: number;
  start?: string;
  end?: string;
  max_points?: number;
  max_points_by_metric?: Record<string, number>;
  aggregation?: string;
  aggregation_by_metric?: Record<string, string>;
  fill_empty?: boolean;
  downsample?: boolean;
  tags?: Record<string, string>;
}

const rangeOf = (params: MetricQueryParams) => {
  const end = params.end ? new Date(params.end) : new Date();
  const start = params.start
    ? new Date(params.start)
    : new Date(end.getTime() - (params.hours ?? 6) * 3_600_000);
  return { start, end };
};

export interface MetricQueryPayload {
  start: string;
  end: string;
  series: Array<{
    metric_key: string;
    entity_id: string;
    tags: Record<string, string>;
    interval_seconds: number;
    points: Array<{
      time: string;
      value: number | null;
      count: number;
    }>;
  }>;
}

/**
 * 指标查询。
 *
 * QueryMetrics 的聚合方式与点数上限是整次请求级的，而主题会按指标区分（流量用
 * sum、速率用 max，且两者点数上限不同）。因此把指标按 (聚合方式, 点数上限) 分组，
 * 每组发一次请求并并发执行——HTTP/2 多路复用下这比放弃逐指标精度更划算。
 */
export async function queryMetrics(
  params: MetricQueryParams,
  options?: ConnectCallOptions,
): Promise<MetricQueryPayload> {
  if (isDevMock()) return mockQueryMetrics(params);
  const { start, end } = rangeOf(params);
  const metricKeys = params.metric_keys ?? [];
  const defaultMaxPoints = params.max_points ?? 500;
  const defaultAggregation = params.aggregation ?? "avg";

  const groups = new Map<string, { metrics: string[]; maxPoints: number; aggregation: string }>();
  for (const metric of metricKeys) {
    const maxPoints = params.max_points_by_metric?.[metric] ?? defaultMaxPoints;
    const aggregation = params.aggregation_by_metric?.[metric] ?? defaultAggregation;
    const key = `${aggregation}:${maxPoints}`;
    const group = groups.get(key) ?? { metrics: [], maxPoints, aggregation };
    group.metrics.push(metric);
    groups.set(key, group);
  }
  if (groups.size === 0) {
    groups.set(`${defaultAggregation}:${defaultMaxPoints}`, {
      metrics: [],
      maxPoints: defaultMaxPoints,
      aggregation: defaultAggregation,
    });
  }

  const responses = await Promise.all(
    [...groups.values()].map((group) =>
      metricsClient.queryMetrics(
        {
          agentIds: params.entity_ids ?? [],
          metrics: group.metrics,
          startTime: timestampFromDate(start),
          endTime: timestampFromDate(end),
          maxPoints: group.maxPoints,
          aggregation: group.aggregation,
          fillEmpty: params.fill_empty ?? false,
          ...(params.downsample !== undefined ? { downsample: params.downsample } : {}),
          ...(params.tags ? { tags: params.tags } : {}),
        },
        callOptions(options),
      ),
    ),
  );

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    series: responses.flatMap((response) =>
      response.series.map((item) => ({
        metric_key: item.metric,
        entity_id: item.agentId,
        tags: item.labels,
        interval_seconds: secondsOf(item.interval),
        points: item.queryPoints.map((point) => ({
          time: isoOf(point.observedAt),
          value: point.value ?? null,
          count: point.sampleCount,
        })),
      })),
    ),
  };
}

/** 指标查询结果的形状由适配层决定，上层直接沿用推断出的类型。 */
export type MetricPayloadSeries = MetricQueryPayload["series"][number];

// ---------------------------------------------------------------- 延迟

export interface PingStatsParams {
  entity_ids?: string[];
  task_ids?: Array<number | string>;
  hours?: number;
  start?: string;
  end?: string;
  max_points?: number;
}

export async function queryPingStats(
  params: PingStatsParams,
  options?: ConnectCallOptions,
) {
  if (isDevMock()) return mockGetPingStats(params);
  const { start, end } = rangeOf(params);
  const response = await metricsClient.getPingStats(
    {
      agentIds: params.entity_ids ?? [],
      taskIds: (params.task_ids ?? []).map((id) => BigInt(id)),
      startTime: timestampFromDate(start),
      endTime: timestampFromDate(end),
      ...(params.max_points !== undefined ? { maxPoints: params.max_points } : {}),
    },
    callOptions(options),
  );
  return {
    stats: response.stats.map((stat) => ({
      entity_id: stat.agentId,
      task_id: stat.taskId.toString(),
      name: stat.name,
      type: stat.type,
      interval: secondsOf(stat.probeInterval),
      total: stat.total,
      valid: stat.valid,
      loss: stat.lossPercent,
      min: stat.minimum ?? null,
      max: stat.maximum ?? null,
      avg: stat.average ?? null,
      latest: stat.latest ?? null,
      p50: stat.p50 ?? null,
      p99: stat.p99 ?? null,
      stddev: stat.standardDeviation ?? null,
      p99_p50_ratio: stat.p99P50Ratio,
    })),
  };
}

export type PingStatsPayload = Awaited<ReturnType<typeof queryPingStats>>;

/** 公开的延迟任务：只含名称与周期，不含探测目标地址。 */
export async function listPublicPingTasks(options?: ConnectCallOptions) {
  if (isDevMock()) return mockGetPingTasks();
  const response = await metricsClient.listPingTasks({}, callOptions(options));
  return response.tasks.map((task) => ({
    id: Number(task.taskId),
    name: task.name,
    type: task.type,
    interval: secondsOf(task.interval),
    loss: 0,
    clients: [] as string[],
    target: "",
    weight: 0,
  }));
}

/** 后台的延迟任务：含探测目标与关联节点，需要管理员会话。 */
export async function listAdminPingTasks(options?: ConnectCallOptions) {
  if (isDevMock()) return mockGetPingTasks();
  const response = await pingTaskClient.listPingTasks({}, callOptions(options));
  return response.tasks.map((task) => ({
    id: task.id,
    name: task.name,
    type: task.type,
    interval: task.intervalSeconds,
    loss: 0,
    clients: task.clients,
    target: task.target,
    weight: task.weight,
  }));
}
