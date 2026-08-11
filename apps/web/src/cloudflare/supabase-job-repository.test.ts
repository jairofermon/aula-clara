import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseJobRepository } from "./supabase-job-repository";

describe("SupabaseJobRepository.readyJobIds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("consulta a função que inclui jobs prontos e locks vencidos", async () => {
    const jobId = "00000000-0000-4000-8000-000000000001";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: jobId }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseJobRepository({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
      WORKER_ID: "worker-test",
      WORKER_LOCK_TTL_SECONDS: "120"
    });

    await expect(repository.readyJobIds(3)).resolves.toEqual([jobId]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.supabase.co/rest/v1/rpc/get_ready_processing_job_ids",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ p_limit: 3, p_lock_ttl_seconds: 120 })
      })
    );
  });

  it("renova o lock usando o worker que fez o claim", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("true", { status: 200, headers: { "content-type": "application/json" } })
      );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseJobRepository({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
      WORKER_ID: "worker-test",
      WORKER_LOCK_TTL_SECONDS: "120"
    });

    await expect(repository.renew("00000000-0000-4000-8000-000000000001")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.supabase.co/rest/v1/rpc/renew_job_lock",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          p_job_id: "00000000-0000-4000-8000-000000000001",
          p_worker_id: "worker-test"
        })
      })
    );
  });
});
