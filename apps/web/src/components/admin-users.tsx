"use client";

import { useEffect, useState } from "react";

type UserRow = {
  id: string;
  display_name: string;
  email: string;
  role: "admin" | "member";
  approval_status: "pending" | "approved" | "rejected";
  created_at: string;
};

export function AdminUsers({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    const body = (await response.json()) as { users?: UserRow[]; error?: string };
    if (response.ok) setUsers(body.users ?? []);
    else setMessage(body.error ?? "Falha ao carregar usuários.");
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: form.get("displayName"),
        email: form.get("email"),
        password: form.get("password"),
        role: form.get("role")
      })
    });
    const body = (await response.json()) as { error?: string };
    setMessage(response.ok ? "Usuário criado." : (body.error ?? "Falha ao criar usuário."));
    if (response.ok) {
      event.currentTarget.reset();
      await load();
    }
    setBusy(false);
  }

  async function update(userId: string, data: object) {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, ...data })
    });
    const body = (await response.json()) as { error?: string };
    setMessage(response.ok ? "Usuário atualizado." : (body.error ?? "Falha ao atualizar usuário."));
    if (response.ok) await load();
    setBusy(false);
  }

  async function remove(user: UserRow) {
    if (!window.confirm(`Excluir permanentemente o membro ${user.email} e todos os dados dele?`))
      return;
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/admin/users?userId=${encodeURIComponent(user.id)}`, {
      method: "DELETE"
    });
    const body = (await response.json()) as { error?: string };
    setMessage(response.ok ? "Membro excluído." : (body.error ?? "Falha ao excluir membro."));
    if (response.ok) await load();
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <form className="card grid gap-4 p-5 md:grid-cols-2" onSubmit={(event) => void create(event)}>
        <h2 className="text-xl font-black md:col-span-2">Criar usuário</h2>
        <label>
          <span className="label">Nome</span>
          <input className="field" name="displayName" minLength={2} required />
        </label>
        <label>
          <span className="label">E-mail</span>
          <input className="field" name="email" type="email" required />
        </label>
        <label>
          <span className="label">Senha temporária</span>
          <input className="field" name="password" type="password" minLength={8} required />
        </label>
        <label>
          <span className="label">Perfil</span>
          <select className="field" name="role">
            <option value="member">Membro (aguarda aprovação)</option>
            <option value="admin">Administrador</option>
          </select>
        </label>
        <button className="btn btn-primary md:col-span-2" disabled={busy}>
          Criar usuário
        </button>
      </form>
      {message && (
        <p role="status" className="rounded-lg bg-[#fff4dc] p-3">
          {message}
        </p>
      )}
      <div className="grid gap-3">
        {users.map((user) => (
          <article
            className="card flex flex-wrap items-center justify-between gap-4 p-5"
            key={user.id}
          >
            <div>
              <p className="font-black">{user.display_name || "Sem nome"}</p>
              <p className="text-sm text-[#61736f]">{user.email}</p>
              <p className="mt-1 text-xs font-bold uppercase">
                {user.role} · {user.approval_status}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {user.id !== currentUserId && user.approval_status !== "approved" && (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void update(user.id, { approvalStatus: "approved" })}
                >
                  Aprovar
                </button>
              )}
              {user.id !== currentUserId && (
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    void update(user.id, { role: user.role === "admin" ? "member" : "admin" })
                  }
                >
                  {user.role === "admin" ? "Tornar membro" : "Tornar administrador"}
                </button>
              )}
              {user.id !== currentUserId && user.role === "member" && (
                <button
                  className="btn btn-secondary text-red-700"
                  disabled={busy}
                  onClick={() => void remove(user)}
                >
                  Excluir membro
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
