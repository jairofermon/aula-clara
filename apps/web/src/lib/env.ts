import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1)
});

export function getPublicEnv() {
  return publicEnvSchema.parse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  });
}

export function getServerEnv() {
  const publicEnv = getPublicEnv();
  const legacyMaxUploadMb = process.env.MAX_UPLOAD_SIZE_MB;
  return {
    ...publicEnv,
    supabaseServerUrl: z
      .url()
      .parse(process.env.SUPABASE_INTERNAL_URL ?? publicEnv.NEXT_PUBLIC_SUPABASE_URL),
    signedUrlTtl: Number(process.env.SIGNED_URL_TTL_SECONDS ?? 300),
    maxAudioUploadBytes:
      Number(process.env.MAX_AUDIO_UPLOAD_SIZE_MB ?? legacyMaxUploadMb ?? 15) * 1024 * 1024,
    maxMaterialUploadBytes:
      Number(process.env.MAX_MATERIAL_UPLOAD_SIZE_MB ?? legacyMaxUploadMb ?? 50) * 1024 * 1024
  };
}
