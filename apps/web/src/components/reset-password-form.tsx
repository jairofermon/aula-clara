"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function ResetPasswordForm() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    const { error } = await createClient().auth.updateUser({ password });
    if (error) {
      setMessage("O link expirou ou a senha não pôde ser alterada.");
      return;
    }
    router.replace("/dashboard");
  }
  return (
    <form className="card w-full max-w-md space-y-5 p-8" onSubmit={(event) => void submit(event)}>
      <h1 className="text-3xl font-black">Definir nova senha</h1>
      <label>
        <span className="label">Nova senha</span>
        <input
          className="field"
          type="password"
          name="password"
          minLength={8}
          required
          autoComplete="new-password"
        />
      </label>
      {message && (
        <p role="alert" className="text-sm text-red-700">
          {message}
        </p>
      )}
      <button className="btn btn-primary w-full">Salvar nova senha</button>
    </form>
  );
}
