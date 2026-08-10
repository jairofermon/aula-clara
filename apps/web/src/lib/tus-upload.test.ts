import { describe, expect, it } from "vitest";
import { supabaseTusEndpoint, TUS_CHUNK_SIZE_BYTES } from "./tus-upload";

describe("upload TUS do Supabase", () => {
  it("usa partes retomáveis de 6 MB", () => {
    expect(TUS_CHUNK_SIZE_BYTES).toBe(6 * 1024 * 1024);
    expect(Math.ceil((39 * 1024 * 1024) / TUS_CHUNK_SIZE_BYTES)).toBe(7);
  });

  it("monta o endpoint oficial sem preservar paths ou queries", () => {
    expect(supabaseTusEndpoint("https://example.supabase.co/rest/v1?x=1")).toBe(
      "https://example.storage.supabase.co/storage/v1/upload/resumable"
    );
  });
});
