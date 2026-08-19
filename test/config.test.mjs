import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "../src/config.mjs";

function jwt(claims) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode(claims),
    "assinatura-ficticia"
  ].join(".");
}

test("validateAccessToken aceita JWT de usuário ainda válido", () => {
  const token = jwt({
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  assert.equal(__testing.validateAccessToken(token), token);
});

test("validateAccessToken recusa papéis privilegiados, anon e expirados", () => {
  for (const role of ["service_role", "supabase_admin", "anon"]) {
    assert.throws(
      () =>
        __testing.validateAccessToken(
          jwt({ role, exp: Math.floor(Date.now() / 1000) + 3600 })
        ),
      /usuário autenticado/
    );
  }
  assert.throws(
    () =>
      __testing.validateAccessToken(
        jwt({ role: "authenticated", exp: Math.floor(Date.now() / 1000) - 1 })
      ),
    /expirado/
  );
});
