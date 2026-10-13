import { FormEvent, useState } from "react";
import { CircleCheck, KeyRound, QrCode, ScanLine } from "lucide-react";
import { Modal } from "../ui/Modal";
import {
  defaultDeviceName,
  isMobile,
  normalizeCode,
  pair,
  parsePairingLink,
  scanQrCode,
  type PairingTarget,
} from "../../pairing";

interface Props {
  onAdd: (name: string, url: string, token: string) => void;
  onClose: () => void;
}

const formatCode = (code: string) => code.replace(/^(.{4})(.{4})$/, "$1-$2");

function PairForm({ onAdd, onClose, onUseToken }: Props & { onUseToken: () => void }) {
  const [input, setInput] = useState("");
  const [url, setUrl] = useState("http://");
  const [name, setName] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"scanning" | "pairing" | null>(null);

  const link = parsePairingLink(input);
  // Without a link, the code is typed by hand and the address entered separately.
  const typedCode = !link && normalizeCode(input).length === 8 ? normalizeCode(input) : null;

  async function connect(target: PairingTarget) {
    setBusy("pairing");
    setError(null);
    try {
      const result = await pair(target, deviceName.trim() || defaultDeviceName());
      onAdd(name.trim() || target.name || result.hostname, result.url, result.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function scan() {
    setBusy("scanning");
    setError(null);
    try {
      const text = await scanQrCode();
      const scanned = parsePairingLink(text);
      if (!scanned) throw new Error("That QR code isn't a HostLens pairing code.");
      setInput(text);
      await connect(scanned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (link) return void connect(link);
    if (typedCode) {
      if (!/^https?:\/\/.+/i.test(url.trim())) return setError("Enter the agent's address, e.g. http://192.168.1.10:47821");
      return void connect({ urls: [url.trim()], code: typedCode, name: null });
    }
    setError("Paste the pairing link, or type the 8-character code.");
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="hint">
        The agent shows a pairing QR code the first time it starts, and whenever you run <code>pnpm pair</code>. You
        can also use <b>Pair device</b> on a host that's already added. Each code works once, for 10 minutes.
      </p>

      {isMobile() && (
        <button type="button" className="button primary scan-button" onClick={scan} disabled={busy !== null}>
          <ScanLine size={20} /> {busy === "scanning" ? "Opening camera…" : "Scan QR code"}
        </button>
      )}

      <label className="field">
        <span>{isMobile() ? "Or paste the pairing link or code" : "Pairing link or code"}</span>
        <input
          className="mono"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          placeholder="hostlens://pair?… or ABCD-EFGH"
          autoFocus={!isMobile()}
        />
        {link && (
          <small className="ok-text pair-preview">
            <CircleCheck size={13} /> Code {formatCode(link.code)} for {link.name ?? "agent"} at {link.urls.join(" or ")}
          </small>
        )}
      </label>

      {typedCode && (
        <label className="field">
          <span>Agent address</span>
          <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:47821" />
        </label>
      )}

      <div className="field-row">
        <label className="field">
          <span>Host name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={link?.name ?? "Taken from the agent"} />
        </label>
        <label className="field">
          <span>This device's name</span>
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </label>
      </div>

      {error && <p className="form-error pre-line">{error}</p>}
      <div className="form-actions spread">
        <button type="button" className="link-button" onClick={onUseToken}>
          <KeyRound size={13} /> Use the master token instead
        </button>
        <span>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>{" "}
          <button type="submit" className="button primary" disabled={busy !== null}>
            <QrCode size={15} /> {busy === "pairing" ? "Pairing…" : "Pair"}
          </button>
        </span>
      </div>
    </form>
  );
}

function TokenForm({ onAdd, onClose, onUsePairing }: Props & { onUsePairing: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("http://localhost:47821");
  const [token, setToken] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    onAdd(name, url, token);
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="hint">
        The master token is in the file the agent names on startup. It has full access and can't be revoked per
        device, so prefer pairing.
      </p>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Game server box" autoFocus />
      </label>
      <label className="field">
        <span>Agent URL</span>
        <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:47821" required />
      </label>
      <label className="field">
        <span>Master token</span>
        <input className="mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      </label>
      <div className="form-actions spread">
        <button type="button" className="link-button" onClick={onUsePairing}>
          <QrCode size={13} /> Pair with a code instead
        </button>
        <span>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>{" "}
          <button type="submit" className="button primary">
            Add host
          </button>
        </span>
      </div>
    </form>
  );
}

export function AddHostForm(props: Props) {
  const [mode, setMode] = useState<"pair" | "token">("pair");
  return (
    <Modal title="Add host" onClose={props.onClose}>
      {mode === "pair" ? (
        <PairForm {...props} onUseToken={() => setMode("token")} />
      ) : (
        <TokenForm {...props} onUsePairing={() => setMode("pair")} />
      )}
    </Modal>
  );
}
