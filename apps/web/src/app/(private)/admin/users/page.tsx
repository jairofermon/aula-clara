import { requireAdmin } from "@/lib/auth";
import { AdminUsers } from "@/components/admin-users";

export const metadata = { title: "Usuários" };

export default async function UsersPage() {
  const user = await requireAdmin();
  return (
    <main className="mx-auto max-w-5xl px-5 py-9">
      <h1 className="text-4xl font-black">Usuários</h1>
      <p className="mt-2 mb-7 text-[#61736f]">Aprove membros e controle os perfis de acesso.</p>
      <AdminUsers currentUserId={user.id} />
    </main>
  );
}
