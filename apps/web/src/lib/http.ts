import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function apiError(message: string, status = 400, code = "bad_request") {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function validationError(error: ZodError) {
  return NextResponse.json(
    {
      error: {
        code: "validation_error",
        message: "Revise os campos informados.",
        details: error.issues
      }
    },
    { status: 422 }
  );
}

export async function safeJson(request: Request): Promise<unknown | null> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}
