"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="btn btn-secondary"
      onClick={() =>
        void createClient()
          .auth.signOut()
          .then(() => {
            router.replace("/login");
            router.refresh();
          })
      }
    >
      <LogOut size={17} aria-hidden /> Sair
    </button>
  );
}
