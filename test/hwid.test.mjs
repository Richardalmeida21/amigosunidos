import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getDeviceId, parseMachineGuid } from "../src/hwid.mjs";

test("parseMachineGuid extrai o identificador sem expor a saída completa", () => {
  assert.equal(
    parseMachineGuid("MachineGuid    REG_SZ    laboratorio-local-01\r\n"),
    "laboratorio-local-01"
  );
  assert.throws(() => parseMachineGuid("registro ausente"), {
    code: "DEVICE_ID_UNAVAILABLE"
  });
});

test("getDeviceId usa SHA-256 do identificador real retornado pelo Windows", async () => {
  const fakeExecFile = (file, args, options, callback) => {
    assert.equal(file, "reg.exe");
    assert.ok(args.includes("MachineGuid"));
    assert.equal(options.windowsHide, true);
    callback(null, "MachineGuid    REG_SZ    guid-ficticio\r\n");
  };
  const expected = crypto.createHash("sha256").update("guid-ficticio").digest("hex");
  assert.equal(
    await getDeviceId({ platform: "win32", execFileImpl: fakeExecFile }),
    expected
  );
});

test("getDeviceId recusa plataformas sem contrato de HWID", async () => {
  await assert.rejects(() => getDeviceId({ platform: "linux" }), {
    code: "UNSUPPORTED_PLATFORM"
  });
});
