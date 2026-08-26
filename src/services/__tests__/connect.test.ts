import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMetricsRpc } = vi.hoisted(() => ({ queryMetricsRpc: vi.fn() }));

// 只替换生成客户端本身，保留 connect.ts 里真正要验证的分组与形状转换逻辑。
vi.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    queryMetrics: queryMetricsRpc,
    getPingStats: vi.fn(),
    listPingTasks: vi.fn(),
    getPublicInfo: vi.fn(),
    getSession: vi.fn(),
    listAgents: vi.fn(),
    watchAgentStatus: vi.fn(),
  }),
}));
vi.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: () => ({}),
}));

import { queryMetrics } from "@/services/connect";

describe("Connect 指标查询", () => {
  beforeEach(() => {
    queryMetricsRpc.mockReset();
    queryMetricsRpc.mockResolvedValue({ series: [] });
  });

  it("按聚合方式与点数上限分组请求，逐指标精度不丢", async () => {
    await queryMetrics({
      entity_ids: ["node-a"],
      metric_keys: ["traffic.up", "traffic.down", "net.out.rate", "net.in.rate"],
      start: "2026-07-15T00:00:00Z",
      end: "2026-07-15T12:00:00Z",
      max_points: 144,
      max_points_by_metric: {
        "traffic.up": 12,
        "traffic.down": 12,
        "net.out.rate": 144,
        "net.in.rate": 144,
      },
      aggregation_by_metric: {
        "traffic.up": "sum",
        "traffic.down": "sum",
        "net.out.rate": "max",
        "net.in.rate": "max",
      },
    });

    // QueryMetrics 的聚合方式与点数上限是整次请求级的，两组参数必须拆成两次请求。
    expect(queryMetricsRpc).toHaveBeenCalledTimes(2);
    const requests = queryMetricsRpc.mock.calls.map(([request]) => request);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metrics: ["traffic.up", "traffic.down"],
          aggregation: "sum",
          maxPoints: 12,
        }),
        expect.objectContaining({
          metrics: ["net.out.rate", "net.in.rate"],
          aggregation: "max",
          maxPoints: 144,
        }),
      ]),
    );
  });

  it("同一聚合方式与上限只发一次请求", async () => {
    await queryMetrics({
      entity_ids: ["node-a"],
      metric_keys: ["cpu.usage", "memory.used"],
      hours: 1,
      max_points: 500,
    });

    expect(queryMetricsRpc).toHaveBeenCalledTimes(1);
    expect(queryMetricsRpc.mock.calls[0][0]).toMatchObject({
      metrics: ["cpu.usage", "memory.used"],
      aggregation: "avg",
      maxPoints: 500,
    });
  });

  it("把服务端序列转成主题沿用的扁平点位", async () => {
    queryMetricsRpc.mockResolvedValue({
      series: [
        {
          metric: "cpu.usage",
          agentId: "node-a",
          labels: { task_id: "7" },
          interval: { seconds: 60n, nanos: 0 },
          queryPoints: [
            {
              observedAt: { seconds: 1_784_000_000n, nanos: 0 },
              value: 12.5,
              sampleCount: 3,
            },
            // 缺值与 0 必须区分：空桶的 value 为 undefined，转换后是 null。
            { observedAt: { seconds: 1_784_000_060n, nanos: 0 }, sampleCount: 0 },
          ],
        },
      ],
    });

    const payload = await queryMetrics({
      entity_ids: ["node-a"],
      metric_keys: ["cpu.usage"],
      hours: 1,
    });

    expect(payload.series).toHaveLength(1);
    expect(payload.series[0]).toMatchObject({
      metric_key: "cpu.usage",
      entity_id: "node-a",
      tags: { task_id: "7" },
      interval_seconds: 60,
    });
    expect(payload.series[0].points[0]).toMatchObject({ value: 12.5, count: 3 });
    expect(payload.series[0].points[1]?.value).toBeNull();
  });
});
