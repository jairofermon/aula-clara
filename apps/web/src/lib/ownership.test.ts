import { describe, expect, it } from "vitest";
import { ownsClass } from "./ownership";

describe("ownsClass", () => {
  it("aplica filtros de aula e usuário antes de autorizar", async () => {
    const calls: Array<[string, unknown]> = [];
    const chain = {
      select: (value: string) => {
        calls.push(["select", value]);
        return chain;
      },
      eq: (field: string, value: unknown) => {
        calls.push([field, value]);
        return chain;
      },
      is: (field: string, value: unknown) => {
        calls.push([field, value]);
        return chain;
      },
      maybeSingle: async () => ({ data: { id: "class-1" } })
    };
    const supabase = {
      from: (table: string) => {
        calls.push(["from", table]);
        return chain;
      }
    };
    await expect(ownsClass(supabase as never, "class-1", "user-1")).resolves.toBe(true);
    expect(calls).toContainEqual(["id", "class-1"]);
    expect(calls).toContainEqual(["user_id", "user-1"]);
  });
});
