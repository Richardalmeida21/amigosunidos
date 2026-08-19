import test from "node:test";
import assert from "node:assert/strict";
import {
  cookieMatchesAllowedHosts,
  isLoginDestination,
  validateLaunchUrl
} from "../src/browser-manager.mjs";
import { SafeAppError } from "../src/supabase.mjs";

test("validateLaunchUrl aceita HTTPS e HTTP somente em loopback", () => {
  assert.equal(validateLaunchUrl("https://app.example.com/home").protocol, "https:");
  assert.equal(validateLaunchUrl("http://127.0.0.1:4317").hostname, "127.0.0.1");
  assert.throws(
    () => validateLaunchUrl("http://app.example.com"),
    (error) => error instanceof SafeAppError && error.code === "UNSAFE_LAUNCH_URL"
  );
  assert.throws(() => validateLaunchUrl("javascript:alert(1)"), SafeAppError);
});

test("cookieMatchesAllowedHosts limita cookies ao domínio da ferramenta", () => {
  const allowed = ["app.example.com", "login.example.net"];
  assert.equal(
    cookieMatchesAllowedHosts({ domain: ".example.com" }, allowed),
    true
  );
  assert.equal(
    cookieMatchesAllowedHosts({ domain: "login.example.net" }, allowed),
    true
  );
  assert.equal(
    cookieMatchesAllowedHosts({ url: "https://app.example.com/" }, allowed),
    true
  );
  assert.equal(
    cookieMatchesAllowedHosts({ domain: ".unrelated.example" }, allowed),
    false
  );
});

test("isLoginDestination reconhece redirecionamentos para autenticação", () => {
  assert.equal(
    isLoginDestination("https://app.example.com/auth/login?redirect=%2Fdashboard", {
      loginUrl: "https://app.example.com/auth/login"
    }),
    true
  );
  assert.equal(
    isLoginDestination("https://app.example.com/#/sign-in"),
    true
  );
  assert.equal(
    isLoginDestination("https://app.example.com/dashboard", {
      loginUrl: "https://app.example.com/auth/login"
    }),
    false
  );
});
