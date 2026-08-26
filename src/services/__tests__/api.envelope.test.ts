import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdminClients } from "@/services/api";

// 公开数据已改走 Connect，信封解析只剩下 /api/admin/client/list 这类仍为 REST 的
// 后台接口，因此改用它来覆盖同一段解析逻辑。
describe("API envelope parsing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves a server error message when an error envelope omits data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "error", message: "forbidden" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(getAdminClients()).rejects.toMatchObject({
      name: "ApiRequestError",
      message: "forbidden",
      status: 200,
      path: "/api/admin/client/list",
    });
  });

  it("still validates successful envelope data with the endpoint schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "success",
            data: [{ uuid: "node-a", name: "Node A" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await getAdminClients();
    expect(result).toHaveLength(1);
    expect(result[0]?.uuid).toBe("node-a");
  });
});
