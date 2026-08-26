import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMetricsMock, queryPingStatsMock, listPublicPingTasksMock } = vi.hoisted(() => ({
  queryMetricsMock: vi.fn(),
  queryPingStatsMock: vi.fn(),
  listPublicPingTasksMock: vi.fn(),
}));

// 在 Connect 适配层打桩：api.ts 只负责聚合与补点，传输细节（分组请求、消息编码）
// 由 services/connect.ts 承担并在 connect.test.ts 单独覆盖。
vi.mock("@/services/connect", () => ({
  queryMetrics: queryMetricsMock,
  queryPingStats: queryPingStatsMock,
  listPublicPingTasks: listPublicPingTasksMock,
  fetchLatestStatus: vi.fn(),
  fetchNodes: vi.fn(),
  fetchPublicConfig: vi.fn(),
  fetchSession: vi.fn(),
  listAdminPingTasks: vi.fn(),
}));

import {
  getLoadRecords,
  getPingOverview,
  getPingOverviewStats,
  getPingRecords,
  getTodayTrafficMetrics,
} from "@/services/api";

const START = "2026-07-15T03:00:00Z";
const END = "2026-07-15T04:00:00Z";
const TAGS = { task_id: "7" };

function metricSeries(
  metricKey: string,
  points: Array<{ time: string; value: number | null; count?: number }>,
) {
  return {
    metric_key: metricKey,
    entity_id: "node-a",
    tags: TAGS,
    interval_seconds: 60,
    points,
  };
}

function aggregatePayload(hasGap: boolean) {
  const latency = hasGap
    ? [
        { time: "2026-07-15T03:43:00Z", value: 20, count: 1 },
        { time: "2026-07-15T03:44:00Z", value: null, count: 0 },
        { time: "2026-07-15T03:45:00Z", value: 30, count: 1 },
      ]
    : [
        { time: "2026-07-15T03:43:00Z", value: 20, count: 1 },
        { time: "2026-07-15T03:44:00Z", value: 25, count: 1 },
        { time: "2026-07-15T03:45:00Z", value: 30, count: 1 },
      ];
  const loss = latency.map((point) => ({
    ...point,
    value: point.count === 0 ? null : 0,
  }));
  return {
    start: START,
    end: END,
    series: [
      metricSeries("ping.latency_ms", latency),
      metricSeries("ping.loss", loss),
    ],
  };
}

function installResponses({
  hasGap,
  rawFails = false,
  rawCount,
}: {
  hasGap: boolean;
  rawFails?: boolean;
  rawCount?: number;
}) {
  queryPingStatsMock.mockResolvedValue({
    stats: [
      {
        entity_id: "node-a",
        task_id: 7,
        name: "广州探测",
        interval: 60,
        total: hasGap ? 2 : 3,
        valid: hasGap ? 2 : 3,
        loss: 0,
        avg: 25,
        latest: 30,
      },
    ],
  });
  listPublicPingTasksMock.mockResolvedValue([
    { id: 7, interval: 60, name: "广州探测", clients: ["node-a"] },
  ]);
  queryMetricsMock.mockImplementation((params: Record<string, unknown>) => {
    // downsample=false 只出现在边界补点的那次原始窗口查询上。
    if (params.downsample === false) {
      if (rawFails) return Promise.reject(new Error("raw query failed"));
      return Promise.resolve({
        start: "2026-07-15T03:40:00Z",
        end: "2026-07-15T03:46:00Z",
        series: [
          metricSeries("ping.latency_ms", [
            {
              time: "2026-07-15T03:44:15Z",
              value: 50,
              ...(rawCount == null ? {} : { count: rawCount }),
            },
          ]),
          metricSeries("ping.loss", [
            {
              time: "2026-07-15T03:44:15Z",
              value: 0,
              ...(rawCount == null ? {} : { count: rawCount }),
            },
          ]),
        ],
      });
    }
    return Promise.resolve(aggregatePayload(hasGap));
  });
}

function metricDataCalls() {
  return queryMetricsMock.mock.calls.filter(([params]) => {
    const keys = (params as Record<string, unknown>)?.metric_keys;
    return Array.isArray(keys) && keys.length > 0;
  });
}

describe("metric boundary repair in the API adapter", () => {
  beforeEach(() => {
    queryMetricsMock.mockReset();
    queryPingStatsMock.mockReset();
    listPublicPingTasksMock.mockReset();
  });

  it("does not request raw data when the aggregate boundary is continuous", async () => {
    installResponses({ hasGap: false });
    const result = await getPingOverview(1, 7, { entityIds: ["node-a"] });

    expect(result.records).toHaveLength(3);
    expect(metricDataCalls()).toHaveLength(1);
  });

  it("requests only the bounded raw window and fills the empty bucket", async () => {
    installResponses({ hasGap: true });
    const result = await getPingOverview(1, 7, { entityIds: ["node-a"] });

    expect(result.records).toHaveLength(3);
    expect(result.records.find((record) => record.time === "2026-07-15T03:44:00Z"))
      .toMatchObject({ value: 50, count: 1, loss: 0 });
    expect(result.stats?.[0]).toMatchObject({ total: 3, valid: 3, loss: 0 });

    const metricCalls = metricDataCalls();
    expect(metricCalls).toHaveLength(2);
    expect(metricCalls[1][0]).toMatchObject({
      entity_ids: ["node-a"],
      tags: TAGS,
      downsample: false,
      start: "2026-07-15T03:40:00.000Z",
      end: "2026-07-15T03:46:00.000Z",
    });
  });

  it("keeps the aggregate result when the optional raw repair fails", async () => {
    installResponses({ hasGap: true, rawFails: true });
    const result = await getPingOverview(1, 7, { entityIds: ["node-a"] });

    expect(result.records).toHaveLength(2);
    expect(result.records.map((record) => record.time)).not.toContain(
      "2026-07-15T03:44:00Z",
    );
  });

  it("preserves hybrid rollup counts", async () => {
    installResponses({ hasGap: true, rawCount: 4 });
    const result = await getPingOverview(1, 7, { entityIds: ["node-a"] });

    expect(result.records.find((record) => record.time === "2026-07-15T03:44:00Z"))
      .toMatchObject({ value: 50, count: 4, loss: 0 });
  });

  it("fetches stats in the same call chain on the ping detail path, without boundary repair", async () => {
    installResponses({ hasGap: true });

    const result = await getPingRecords("node-a", 24);

    expect(result.records).toHaveLength(2);
    expect(result.stats).toHaveLength(1);
    expect(result.stats?.[0]).toMatchObject({ total: 2, valid: 2 });
    const metricCalls = metricDataCalls();
    expect(metricCalls).toHaveLength(1);
    expect(metricCalls[0][0]).toMatchObject({
      entity_ids: ["node-a"],
      fill_empty: false,
    });
    expect(queryPingStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({ entity_ids: ["node-a"], hours: 24 }),
      expect.anything(),
    );
  });

  it("batches homepage Ping statistics by task id", async () => {
    queryPingStatsMock.mockResolvedValue({ stats: [] });

    await getPingOverviewStats(1, [9, 7, 9], {
      entityIds: ["node-a", "node-b"],
    });

    expect(queryPingStatsMock).toHaveBeenCalledTimes(1);
    expect(queryPingStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hours: 1,
        task_ids: [7, 9],
        entity_ids: ["node-a", "node-b"],
      }),
      expect.anything(),
    );
  });

  it("does not send removed Komari 1.3.0 total metrics in load queries", async () => {
    queryMetricsMock.mockResolvedValue({
      start: START,
      end: END,
      series: [
        metricSeries("memory.used", [
          { time: "2026-07-15T03:30:00Z", value: 512, count: 1 },
        ]),
      ],
    });

    const result = await getLoadRecords("node-a", 1);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ client: "node-a", ram: 512 });
    expect(metricDataCalls()).toHaveLength(1);
    expect(queryMetricsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_ids: ["node-a"],
        metric_keys: expect.not.arrayContaining([
          "memory.total",
          "swap.total",
          "disk.total",
        ]),
      }),
      expect.anything(),
    );
  });

  it("uses a small point budget for traffic totals while preserving rate chart detail", async () => {
    queryMetricsMock.mockResolvedValue({ start: START, end: END, series: [] });

    await getTodayTrafficMetrics(
      ["node-a"],
      Date.parse("2026-07-15T00:00:00Z"),
      Date.parse("2026-07-15T12:00:00Z"),
    );

    expect(queryMetricsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        max_points: 144,
        max_points_by_metric: {
          "traffic.up": 12,
          "traffic.down": 12,
          "net.out.rate": 144,
          "net.in.rate": 144,
        },
      }),
      expect.anything(),
    );
  });
});
