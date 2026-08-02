"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "login" | "register" | "forgot";

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const displayName = String(form.get("display_name") ?? "");
    const supabase = createClient();

    if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/auth/callback?next=/reset-password`
      });
      setMessage(
        error
          ? "Não foi possível enviar o e-mail."
          : "Se a conta existir, enviaremos as instruções."
      );
      setBusy(false);
      return;
    }

    const result =
      mode === "register"
        ? await supabase.auth.signUp({
            email,
            password,
            options: { data: { display_name: displayName } }
          })
        : await supabase.auth.signInWithPassword({ email, password });

    if (result.error) {
      setMessage(
        mode === "login" ? "E-mail ou senha inválidos." : "Não foi possível criar a conta."
      );
      setBusy(false);
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <form
      className="card w-full max-w-md space-y-5 p-7 sm:p-9"
      method="post"
      onSubmit={(event) => void submit(event)}
    >
      <div>
        <p className="text-sm font-bold text-[#176b58]">Aula Clara</p>
        <h1 className="mt-2 text-3xl font-black">
          {mode === "login"
            ? "Bem-vindo de volta"
            : mode === "register"
              ? "Crie sua conta"
              : "Recuperar acesso"}
        </h1>
      </div>
      {mode === "register" && (
        <label>
          <span className="label">Como devemos chamar você?</span>
          <input className="field" name="display_name" required minLength={2} autoComplete="name" />
        </label>
      )}
      <label>
        <span className="label">E-mail</span>
        <input className="field" type="email" name="email" required autoComplete="email" />
      </label>
      {mode !== "forgot" && (
        <label>
          <span className="label">Senha</span>
          <input
            className="field"
            type="password"
            name="password"
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>
      )}
      {message && (
        <p role="status" className="rounded-lg bg-[#fff4dc] p-3 text-sm">
          {message}
        </p>
      )}
      <button className="btn btn-primary w-full" disabled={busy}>
        {busy
          ? "Aguarde…"
          : mode === "login"
            ? "Entrar"
            : mode === "register"
              ? "Criar conta"
              : "Enviar instruções"}
      </button>
    </form>
  );
}
