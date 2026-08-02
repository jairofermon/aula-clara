import type { SupabaseClient } from "@supabase/supabase-js";

export async function ownsClass(supabase: SupabaseClient, classId: string, userId: string) {
  const { data } = await supabase
    .from("classes")
    .select("id")
    .eq("id", classId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return Boolean(data);
}
