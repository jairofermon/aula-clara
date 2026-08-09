import { processingJobSchema, type ProcessingJob } from "./contracts";
import type { QueueRepository } from "./queue-consumer";

interface RepositoryEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  WORKER_ID: string;
  WORKER_LOCK_TTL_SECONDS: string;
}

export class SupabaseJobRepository implements QueueRepository {
  constructor(private readonly env: RepositoryEnv) {}

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.env.SUPABASE_URL}${path}`, {
      ...init,
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) throw new Error(`supabase_${response.status}`);
    return response;
  }

  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.request(`/rest/v1/rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    return response.status === 204 ? null : response.json();
  }

  async prepareCloudAudio(jobId: string, maxBytes: number): Promise<unknown> {
    return this.rpc("prepare_cloud_audio_job", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID,
      p_max_bytes: maxBytes
    });
  }

  async transcriptionInput(jobId: string): Promise<unknown> {
    return this.rpc("get_cloud_transcription_input", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID
    });
  }

  async persistCloudTranscription(
    jobId: string,
    segments: ReadonlyArray<Record<string, unknown>>,
    modelName: string,
    durationMs: number,
    provider = "cloudflare"
  ): Promise<unknown> {
    const result = await this.rpc("persist_cloud_transcription", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID,
      p_segments: segments,
      p_model_name: modelName,
      p_duration_ms: durationMs
    });
    if (provider !== "cloudflare") await this.correctUsageProvider(jobId, provider, modelName);
    return result;
  }

  async assembleCloudTranscript(jobId: string): Promise<unknown> {
    return this.rpc("assemble_cloud_transcript", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID
    });
  }

  async reviewBatch(jobId: string, limit = 24): Promise<unknown> {
    return this.rpc("get_cloud_review_batch", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID,
      p_limit: limit
    });
  }

  async applyReviewBatch(
    jobId: string,
    segments: ReadonlyArray<Record<string, unknown>>,
    modelName: string,
    metrics: {
      durationMs: number;
      inputUnits?: number;
      outputUnits?: number;
      requestId?: string;
    }
  ): Promise<unknown> {
    const result = await this.rpc("apply_cloud_review_batch", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID,
      p_segments: segments,
      p_model_name: modelName,
      p_duration_ms: metrics.durationMs,
      p_input_units: metrics.inputUnits ?? null,
      p_output_units: metrics.outputUnits ?? null,
      p_request_id: metrics.requestId ?? null
    });
    if (!modelName.startsWith("@cf/")) await this.correctUsageProvider(jobId, "groq", modelName);
    return result;
  }

  async materialInput(jobId: string): Promise<unknown> {
    return this.rpc("get_cloud_material_input", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID
    });
  }

  async finishMaterial(
    jobId: string,
    structuredContent: Record<string, unknown>,
    markdownContent: string | null,
    modelName: string,
    metrics: {
      durationMs: number;
      inputUnits?: number;
      outputUnits?: number;
      requestId?: string;
    }
  ): Promise<unknown> {
    const result = await this.rpc("finish_cloud_material", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID,
      p_structured_content: structuredContent,
      p_markdown_content: markdownContent,
      p_model_name: modelName,
      p_duration_ms: metrics.durationMs,
      p_input_units: metrics.inputUnits ?? null,
      p_output_units: metrics.outputUnits ?? null,
      p_request_id: metrics.requestId ?? null
    });
    if (!modelName.startsWith("@cf/")) await this.correctUsageProvider(jobId, "groq", modelName);
    return result;
  }

  private async correctUsageProvider(jobId: string, provider: string, modelName: string) {
    const query = new URLSearchParams({ processing_job_id: `eq.${jobId}` });
    await this.request(`/rest/v1/usage_records?${query}`, {
      method: "PATCH",
      body: JSON.stringify({ provider, model_name: modelName.slice(0, 200) })
    });
  }

  async downloadAudio(storagePath: string): Promise<ArrayBuffer> {
    const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(
      `/storage/v1/object/authenticated/class-audio/${encodedPath}`,
      { method: "GET" }
    );
    return response.arrayBuffer();
  }

  async claim(jobId: string): Promise<ProcessingJob | null> {
    const value = await this.rpc("claim_processing_job_by_id", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID,
      p_lock_ttl_seconds: Number(this.env.WORKER_LOCK_TTL_SECONDS)
    });
    const rows = processingJobSchema.array().parse(value);
    return rows[0] ?? null;
  }

  async complete(jobId: string, output: Record<string, unknown>): Promise<void> {
    await this.rpc("complete_processing_job", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID,
      p_output: output
    });
  }

  async continue(jobId: string, output: Record<string, unknown>): Promise<void> {
    await this.rpc("continue_processing_job", {
      p_job_id: jobId,
      p_worker_id: this.env.WORKER_ID,
      p_output: output
    });
  }

  async fail(
    job: ProcessingJob,
    failure: {
      code: string;
      publicMessage: string;
      transient: boolean;
      retryDelaySeconds?: number;
    }
  ): Promise<"retry_wait" | "failed" | "ignored"> {
    const value = await this.rpc("fail_processing_job", {
      p_job_id: job.id,
      p_worker_id: this.env.WORKER_ID,
      p_error_code: failure.code,
      p_public_message: failure.publicMessage,
      p_transient: failure.transient,
      p_retry_delay_seconds: failure.retryDelaySeconds ?? null
    });
    if (value !== "retry_wait" && value !== "failed" && value !== "ignored")
      throw new Error("invalid_fail_status");
    return value;
  }

  async readyJobIds(limit = 20): Promise<string[]> {
    const query = new URLSearchParams({
      select: "id",
      status: "in.(pending,retry_wait,running)",
      next_attempt_at: `lte.${new Date().toISOString()}`,
      order: "next_attempt_at.asc,created_at.asc",
      limit: String(limit)
    });
    const response = await this.request(`/rest/v1/processing_jobs?${query}`, { method: "GET" });
    const value = (await response.json()) as unknown;
    if (!Array.isArray(value)) throw new Error("invalid_pending_jobs_response");
    return value.flatMap((item) =>
      typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
        ? [(item as { id: string }).id]
        : []
    );
  }
}
