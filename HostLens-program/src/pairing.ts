import type { PairResponse } from "../../agent/types";
import { agentRequest } from "./agentApi";
import { normalizeUrl } from "./useAgents";

// Pairing with an agent: the agent shows a QR code (or the code and address)
// for hostlens://pair?url=…&url=…&code=…&name=…; we try each address and
// trade the single-use code for this device's own token.

export interface PairingTarget {
  urls: string[];
  code: string;
  /** Agent hostname, used as the default host name. */
  name: string | null;
}

/** Strips anything but letters and digits and uppercases: "abcd-efgh" → "ABCDEFGH". */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Parses a pairing link; `null` if the text isn't one. */
export function parsePairingLink(text: string): PairingTarget | null {
  const value = text.trim();
  if (!/^hostlens:\/\/pair\?/i.test(value)) return null;
  const params = new URLSearchParams(value.slice(value.indexOf("?") + 1));
  const urls = params.getAll("url").filter((u) => /^https?:\/\//i.test(u));
  const code = normalizeCode(params.get("code") ?? "");
  if (!urls.length || code.length !== 8) return null;
  return { urls, code, name: params.get("name") };
}

/** A sensible device name for the agent's device list. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "HostLens on Android";
  if (/iPhone|iPad/i.test(ua)) return "HostLens on iOS";
  if (/Windows/i.test(ua)) return "HostLens on Windows";
  if (/Mac OS/i.test(ua)) return "HostLens on macOS";
  if (/Linux/i.test(ua)) return "HostLens on Linux";
  return "HostLens";
}

export const isMobile = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

export interface PairResult {
  url: string;
  token: string;
  hostname: string;
}

/**
 * Tries each address in order. A network error moves on to the next address;
 * an answer from the agent (e.g. "code already used") stops, since the code
 * is then spent or wrong everywhere.
 */
export async function pair(target: PairingTarget, deviceName: string): Promise<PairResult> {
  const failures: string[] = [];
  for (const raw of target.urls) {
    const url = normalizeUrl(raw);
    try {
      const res = await agentRequest<PairResponse>(url, "POST", "/api/v1/pair", null, {
        code: target.code,
        deviceName,
      });
      return { url, token: res.token, hostname: res.hostname };
    } catch (e) {
      const message = String(e);
      if (/^\d{3}\b/.test(message)) throw new Error(message.replace(/^\d{3}\s*/, ""));
      failures.push(`${url}: ${message}`);
    }
  }
  throw new Error(`Couldn't reach the agent. Is this device on the same network?\n${failures.join("\n")}`);
}

/** Opens the camera and returns the scanned QR text (Android/iOS only). */
export async function scanQrCode(): Promise<string> {
  const scanner = await import("@tauri-apps/plugin-barcode-scanner");
  let permission = await scanner.checkPermissions();
  if (permission !== "granted") permission = await scanner.requestPermissions();
  if (permission !== "granted") throw new Error("Camera permission is needed to scan the QR code.");
  const result = await scanner.scan({ formats: [scanner.Format.QRCode], windowed: false });
  return result.content;
}
