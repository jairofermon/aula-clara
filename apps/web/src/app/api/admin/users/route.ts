import { z } from "zod";
import { getApiContext } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

const createUserSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  email: z.email(),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "member"])
});

const updateUserSchema = z.object({
  userId: z.uuid(),
  role: z.enum(["admin", "member"]).optional(),
  approvalStatus: z.enum(["pending", "approved", "rejected"]).optional()
});

async function adminContext() {
  const context = await getApiContext();
  return context?.profile.role === "admin" ? context : null;
}

export async function GET() {
  const context = await adminContext();
  if (!context)
    return Response.json({ error: "Acesso restrito a administradores." }, { status: 403 });
  const service = createServiceClient();
  const [{ data: profiles, error }, { data: authData, error: authError }] = await Promise.all([
    service
      .from("profiles")
      .select("id,display_name,role,approval_status,created_at")
      .order("created_at"),
    service.auth.admin.listUsers({ page: 1, perPage: 1000 })
  ]);
  if (error || authError)
    return Response.json({ error: "Não foi possível listar os usuários." }, { status: 500 });
  const emailById = new Map(authData.users.map((user) => [user.id, user.email ?? ""]));
  return Response.json({
    users: profiles.map((profile) => ({ ...profile, email: emailById.get(profile.id) ?? "" }))
  });
}

export async function POST(request: Request) {
  const context = await adminContext();
  if (!context)
    return Response.json({ error: "Acesso restrito a administradores." }, { status: 403 });
  const parsed = createUserSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Dados do usuário inválidos." }, { status: 400 });
  const service = createServiceClient();
  const { data, error } = await service.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: { display_name: parsed.data.displayName }
  });
  if (error || !data.user)
    return Response.json(
      { error: "Não foi possível criar o usuário. Verifique se o e-mail já existe." },
      { status: 409 }
    );
  const approved = parsed.data.role === "admin";
  const { error: profileError } = await service
    .from("profiles")
    .update({
      display_name: parsed.data.displayName,
      role: parsed.data.role,
      approval_status: approved ? "approved" : "pending",
      approved_at: approved ? new Date().toISOString() : null,
      approved_by: approved ? context.user.id : null
    })
    .eq("id", data.user.id);
  if (profileError) {
    await service.auth.admin.deleteUser(data.user.id);
    return Response.json({ error: "Não foi possível configurar o perfil." }, { status: 500 });
  }
  return Response.json({ id: data.user.id }, { status: 201 });
}

export async function PATCH(request: Request) {
  const context = await adminContext();
  if (!context)
    return Response.json({ error: "Acesso restrito a administradores." }, { status: 403 });
  const parsed = updateUserSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.userId === context.user.id)
    return Response.json({ error: "Alteração inválida." }, { status: 400 });
  const changes: Record<string, string | null> = {};
  if (parsed.data.role) changes.role = parsed.data.role;
  if (parsed.data.approvalStatus) {
    changes.approval_status = parsed.data.approvalStatus;
    changes.approved_at =
      parsed.data.approvalStatus === "approved" ? new Date().toISOString() : null;
    changes.approved_by = parsed.data.approvalStatus === "approved" ? context.user.id : null;
  }
  const { error } = await createServiceClient()
    .from("profiles")
    .update(changes)
    .eq("id", parsed.data.userId);
  return error
    ? Response.json({ error: "Não foi possível atualizar o usuário." }, { status: 500 })
    : Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const context = await adminContext();
  if (!context)
    return Response.json({ error: "Acesso restrito a administradores." }, { status: 403 });
  const userId = new URL(request.url).searchParams.get("userId");
  const parsedId = z.uuid().safeParse(userId);
  if (!parsedId.success || parsedId.data === context.user.id)
    return Response.json({ error: "Usuário inválido." }, { status: 400 });
  const service = createServiceClient();
  const { data: target } = await service
    .from("profiles")
    .select("role")
    .eq("id", parsedId.data)
    .single();
  if (target?.role !== "member")
    return Response.json(
      { error: "Somente usuários membros podem ser excluídos." },
      { status: 400 }
    );
  const [{ data: files }, { data: exports }] = await Promise.all([
    service.from("class_files").select("file_type,storage_path").eq("user_id", parsedId.data),
    service
      .from("materials")
      .select("storage_path")
      .eq("user_id", parsedId.data)
      .not("storage_path", "is", null)
  ]);
  const groups = new Map<string, string[]>([
    ["class-audio", []],
    ["class-materials", []],
    ["generated-exports", []]
  ]);
  for (const file of files ?? [])
    groups
      .get(file.file_type === "audio" ? "class-audio" : "class-materials")!
      .push(file.storage_path);
  for (const item of exports ?? [])
    if (item.storage_path) groups.get("generated-exports")!.push(item.storage_path);
  for (const [bucket, paths] of groups)
    if (paths.length) await service.storage.from(bucket).remove(paths);
  const { error } = await service.auth.admin.deleteUser(parsedId.data);
  return error
    ? Response.json({ error: "Não foi possível excluir o usuário." }, { status: 500 })
    : Response.json({ ok: true });
}
