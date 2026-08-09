import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export async function requireUser(): Promise<User> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");
  const { data: profile } = await supabase
    .from("profiles")
    .select("approval_status")
    .eq("id", data.user.id)
    .single();
  if (profile?.approval_status !== "approved") redirect("/pending-approval");
  return data.user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") redirect("/dashboard");
  return user;
}

export async function getApiContext() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role,approval_status")
    .eq("id", data.user.id)
    .single();
  if (profile?.approval_status !== "approved") return null;
  return { supabase, user: data.user, profile };
}
