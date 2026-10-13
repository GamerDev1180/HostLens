import { useState } from "react";
import { Bell, Info, MessageSquare, Monitor, Moon, Palette, Send, Sun } from "lucide-react";
import type { AlertRuleKind, AlertSettings } from "../../types";
import type { AppSettings, ThemePreference } from "../../useSettings";
import { RULE_LABELS, RULES_WITH_THRESHOLD } from "../../useAlerts";
import { Card } from "../ui/common";

interface Props {
  appSettings: AppSettings;
  onChangeAppSettings: (settings: AppSettings) => void;
  alertSettings: AlertSettings;
  onChangeAlertSettings: (settings: AlertSettings) => void;
  notifyError: string | null;
  onSendTest: (webhookUrl: string) => Promise<unknown>;
}

const RULE_ORDER: AlertRuleKind[] = ["checkDown", "agentOffline", "cpuHigh", "memoryHigh", "diskFull"];
const RULE_HINTS: Record<AlertRuleKind, string> = {
  checkDown: "A FiveM server, website or port stops answering",
  agentOffline: "A host's agent can't be reached",
  cpuHigh: "CPU stays above the threshold",
  memoryHigh: "Memory stays above the threshold",
  diskFull: "Any disk is fuller than the threshold",
};
const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

function Webhook({ alertSettings, onChangeAlertSettings, notifyError, onSendTest }: Props) {
  const [url, setUrl] = useState(alertSettings.discordWebhookUrl);
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const dirty = url.trim() !== alertSettings.discordWebhookUrl;

  async function test() {
    setTestState("sending");
    try {
      await onSendTest(url.trim());
      setTestState("sent");
    } catch {
      setTestState("failed");
    }
  }

  return (
    <Card title="Discord notifications" icon={MessageSquare}>
      <p className="muted">
        Outages, recoveries and reports are posted to this webhook. Create one under <b>Server settings →
        Integrations → Webhooks</b> in Discord.
      </p>
      <div className="inline-form">
        <input
          className="mono"
          type="password"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setTestState("idle");
          }}
          placeholder="https://discord.com/api/webhooks/…"
          autoComplete="off"
        />
        <button className="button ghost" disabled={!url.trim() || testState === "sending"} onClick={test}>
          <Send size={14} /> {testState === "sending" ? "Sending…" : "Test"}
        </button>
        <button
          className="button primary"
          disabled={!dirty}
          onClick={() => onChangeAlertSettings({ ...alertSettings, discordWebhookUrl: url.trim() })}
        >
          Save
        </button>
      </div>
      {testState === "sent" && <p className="ok-text">Test message sent. Check your Discord channel.</p>}
      {(testState === "failed" || notifyError) && <p className="form-error">Couldn't post to Discord: {notifyError}</p>}
    </Card>
  );
}

function Rules({ alertSettings, onChangeAlertSettings }: Props) {
  const update = (kind: AlertRuleKind, patch: Partial<AlertSettings["rules"][AlertRuleKind]>) =>
    onChangeAlertSettings({
      ...alertSettings,
      rules: { ...alertSettings.rules, [kind]: { ...alertSettings.rules[kind], ...patch } },
    });

  return (
    <Card title="Alert rules" icon={Bell}>
      <p className="muted">Rules apply to every host and monitor.</p>
      <div className="rules">
        {RULE_ORDER.map((kind) => {
          const rule = alertSettings.rules[kind];
          return (
            <div className={`rule ${rule.enabled ? "" : "disabled"}`} key={kind}>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => update(kind, { enabled: e.target.checked })}
                />
                <span className="switch-track" />
              </label>
              <div className="rule-text">
                <b>{RULE_LABELS[kind]}</b>
                <span className="muted">{RULE_HINTS[kind]}</span>
              </div>
              <div className="rule-inputs">
                {RULES_WITH_THRESHOLD.includes(kind) && (
                  <label>
                    ≥
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={rule.threshold}
                      disabled={!rule.enabled}
                      onChange={(e) => update(kind, { threshold: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })}
                    />
                    %
                  </label>
                )}
                <label>
                  for
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={rule.forSeconds}
                    disabled={!rule.enabled}
                    onChange={(e) => update(kind, { forSeconds: Math.min(3600, Math.max(0, Number(e.target.value) || 0)) })}
                  />
                  s
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function SettingsPage(props: Props) {
  const { appSettings, onChangeAppSettings } = props;
  return (
    <div className="page narrow">
      <header className="page-header">
        <div className="page-title">
          <h1>Settings</h1>
          <p className="muted">Appearance, notifications and alert rules.</p>
        </div>
      </header>

      <Card title="Appearance" icon={Palette}>
        <div className="theme-picker">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              className={`theme-option ${value} ${appSettings.theme === value ? "selected" : ""}`}
              onClick={() => onChangeAppSettings({ ...appSettings, theme: value })}
            >
              <span className="theme-preview" />
              <span>
                <Icon size={14} /> {label}
              </span>
            </button>
          ))}
        </div>
      </Card>

      <Webhook {...props} />
      <Rules {...props} />

      <Card title="About" icon={Info}>
        <p className="muted">
          HostLens keeps everything on this device: hosts, monitors, reports (7 days of hourly uptime) and alert
          history are stored locally. Monitors and alerts only run while the app is open.
        </p>
      </Card>
    </div>
  );
}
