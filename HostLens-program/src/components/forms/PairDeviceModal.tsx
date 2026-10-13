import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { CircleCheck, Copy, RefreshCw, TriangleAlert } from "lucide-react";
import type { DeviceInfo, PairingCodeResponse } from "../../../../agent/types";
import { agentRequest, fetchAgent } from "../../agentApi";
import type { Subscription } from "../../types";
import { Modal } from "../ui/Modal";

interface Props {
  subscription: Subscription;
  onClose: () => void;
}

const formatCode = (code: string) => code.replace(/^(.{4})(.{4})$/, "$1-$2");
const DEVICE_POLL_MS = 2000;

// Shows a single-use pairing QR code for another device (usually a phone) and
// watches the agent's device list to confirm when it has paired.
export function PairDeviceModal({ subscription, onClose }: Props) {
  const [pairing, setPairing] = useState<PairingCodeResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [knownDevices, setKnownDevices] = useState<Set<string> | null>(null);
  const [paired, setPaired] = useState<DeviceInfo | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  const newCode = useCallback(async () => {
    setError(null);
    setPaired(null);
    setQr(null);
    try {
      const devices = await fetchAgent<DeviceInfo[]>(subscription, "/api/v1/devices");
      setKnownDevices(new Set(devices.map((d) => d.id)));
      const res = await agentRequest<PairingCodeResponse>(
        subscription.url,
        "POST",
        "/api/v1/pairing-codes",
        subscription.token ?? null,
      );
      setPairing(res);
      setQr(
        await QRCode.toString(res.link, {
          type: "svg",
          margin: 1,
          errorCorrectionLevel: "M",
          color: { dark: "#0a0a0b", light: "#ffffff" },
        }),
      );
    } catch (e) {
      setError(/^404\b/.test(String(e)) ? "This agent is too old for pairing. Update it to 1.2 or later." : String(e));
    }
  }, [subscription]);

  useEffect(() => {
    void newCode();
  }, [newCode]);

  // Countdown, plus watching for the new device to appear.
  useEffect(() => {
    if (!pairing || paired) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const watch = setInterval(async () => {
      try {
        const devices = await fetchAgent<DeviceInfo[]>(subscription, "/api/v1/devices");
        const added = devices.find((d) => !knownDevices?.has(d.id));
        if (added) setPaired(added);
      } catch {
        // Keep waiting; the agent may be briefly unreachable.
      }
    }, DEVICE_POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(watch);
    };
  }, [pairing, paired, subscription, knownDevices]);

  const remaining = pairing ? Math.max(0, Date.parse(pairing.expiresAt) - now) : 0;
  const expired = pairing !== null && remaining === 0;

  async function copyLink() {
    if (!pairing) return;
    await navigator.clipboard.writeText(pairing.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal title={`Pair a device with ${subscription.name}`} onClose={onClose}>
      <div className="form pair-modal">
        {error ? (
          <div className="banner danger">
            <TriangleAlert size={18} />
            <span>{error}</span>
          </div>
        ) : paired ? (
          <div className="pair-success">
            <CircleCheck size={44} />
            <h3>Paired with {paired.name}</h3>
            <p className="muted">It can now see this host. You can remove it any time under Devices.</p>
            <button className="button primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <p className="hint">
              In the HostLens app on your phone, tap <b>Add host → Scan QR code</b>. The code works once.
            </p>
            <div className={`qr-frame ${expired ? "expired" : ""}`}>
              {qr ? <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} /> : <div className="qr placeholder" />}
              {expired && (
                <button className="button primary" onClick={newCode}>
                  <RefreshCw size={15} /> New code
                </button>
              )}
            </div>
            {pairing && (
              <>
                <div className="pair-code">
                  <span className="mono">{formatCode(pairing.code)}</span>
                  <span className="muted">
                    {expired
                      ? "expired"
                      : `expires in ${Math.floor(remaining / 60_000)}:${String(Math.floor(remaining / 1000) % 60).padStart(2, "0")}`}
                  </span>
                </div>
                <p className="hint center">
                  Or enter the code with the address{pairing.urls.length > 1 ? "es" : ""}{" "}
                  <span className="mono">{pairing.urls.join(", ")}</span>
                  {" · "}
                  <button className="link-button" onClick={copyLink}>
                    <Copy size={12} /> {copied ? "Copied" : "Copy link"}
                  </button>
                </p>
                {pairing.localOnly && (
                  <div className="banner warn">
                    <TriangleAlert size={18} />
                    <span>
                      The agent only listens on 127.0.0.1, so a phone can't reach it. Restart it with{" "}
                      <code>HOSTLENS_HOST=0.0.0.0</code> (trusted networks only) and make a new code.
                    </span>
                  </div>
                )}
                {!expired && <p className="hint center waiting">Waiting for the device to pair…</p>}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
