export const TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024;

export function supabaseTusEndpoint(supabaseUrl: string) {
  const url = new URL(supabaseUrl);
  const projectMatch = /^(?<project>[a-z0-9-]+)\.supabase\.co$/iu.exec(url.hostname);
  if (projectMatch?.groups?.project)
    url.hostname = `${projectMatch.groups.project}.storage.supabase.co`;
  url.pathname = "/storage/v1/upload/resumable";
  url.search = "";
  url.hash = "";
  return url.toString();
}
