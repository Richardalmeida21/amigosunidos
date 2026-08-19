import crypto from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { SafeAppError } from "./supabase.mjs";

const MACHINE_GUID_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";

export function parseMachineGuid(output) {
  const match = String(output ?? "").match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
  const value = match?.[1]?.trim();
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SafeAppError(
      "Não foi possível identificar este dispositivo.",
      "DEVICE_ID_UNAVAILABLE"
    );
  }
  return value;
}

function runRegistryQuery(execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      "reg.exe",
      ["QUERY", MACHINE_GUID_KEY, "/v", "MachineGuid"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1024
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

export async function getDeviceId({
  platform = process.platform,
  execFileImpl = nodeExecFile
} = {}) {
  if (platform !== "win32") {
    throw new SafeAppError(
      "A identificação do dispositivo está disponível somente no Windows.",
      "UNSUPPORTED_PLATFORM"
    );
  }

  try {
    const machineGuid = parseMachineGuid(await runRegistryQuery(execFileImpl));
    return crypto.createHash("sha256").update(machineGuid).digest("hex");
  } catch (error) {
    if (error instanceof SafeAppError) throw error;
    throw new SafeAppError(
      "Não foi possível identificar este dispositivo.",
      "DEVICE_ID_UNAVAILABLE"
    );
  }
}

export const __testing = { MACHINE_GUID_KEY };
