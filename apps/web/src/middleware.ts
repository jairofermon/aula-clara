import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

// Next.js 16 proxy.ts is Node-only. OpenNext ainda exige a fronteira Edge,
// portanto mantemos deliberadamente a convenção middleware.ts suportada.
export async function middleware(request: NextRequest) {
  // A autenticação de páginas públicas e APIs é feita pelos respectivos
  // componentes/handlers. Não inicialize o cliente Supabase nessas rotas:
  // no Workers Free, cada requisição HTTP dispõe de apenas 10 ms de CPU.
  let response = NextResponse.next({ request });
  const url = process.env.SUPABASE_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items) => {
        items.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      }
    }
  });

  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/subjects/:path*", "/classes/:path*", "/admin/:path*"]
};
