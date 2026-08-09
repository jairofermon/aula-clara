import Link from "next/link";
import { BookOpenText } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/components/logout-button";

export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return (
    <div className="min-h-screen">
      <header className="border-b border-[#dbe4df] bg-white/95">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
          <Link href="/dashboard" className="flex items-center gap-2 text-lg font-black">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#176b58] text-white">
              <BookOpenText size={20} aria-hidden />
            </span>
            Aula Clara
          </Link>
          <nav className="flex items-center gap-2" aria-label="Navegação principal">
            {profile?.role === "admin" && (
              <Link className="btn btn-secondary hidden sm:inline-flex" href="/admin/users">
                Usuários
              </Link>
            )}
            <Link className="btn btn-secondary hidden sm:inline-flex" href="/classes/new">
              Nova aula
            </Link>
            <LogoutButton />
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
