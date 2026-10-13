import { Activity, Bell, LayoutDashboard, Server, Settings, type LucideIcon } from "lucide-react";

export type Section = "overview" | "hosts" | "monitors" | "alerts" | "settings";

interface Props {
  section: Section;
  onSelect: (section: Section) => void;
  badges: Partial<Record<Section, number>>;
  /** Sections showing a red badge (something is down). */
  alarms: Partial<Record<Section, boolean>>;
}

const ITEMS: { section: Section; label: string; icon: LucideIcon }[] = [
  { section: "overview", label: "Overview", icon: LayoutDashboard },
  { section: "hosts", label: "Hosts", icon: Server },
  { section: "monitors", label: "Monitors", icon: Activity },
  { section: "alerts", label: "Alerts", icon: Bell },
];

function RailButton({
  item,
  active,
  badge,
  alarm,
  onClick,
}: {
  item: (typeof ITEMS)[number];
  active: boolean;
  badge?: number;
  alarm?: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      className={`rail-button ${active ? "active" : ""}`}
      onClick={onClick}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={20} strokeWidth={1.8} />
      <span className="rail-caption">{item.label}</span>
      {badge ? <span className={`rail-badge ${alarm ? "alarm" : ""}`}>{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );
}

// Vertical icon bar on desktop; a bottom tab bar on narrow (phone) screens.
export function Rail({ section, onSelect, badges, alarms }: Props) {
  const settings = { section: "settings" as const, label: "Settings", icon: Settings };
  return (
    <nav className="rail">
      <div className="rail-logo" title="HostLens">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
          <defs>
            <linearGradient id="logo-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#409cff" />
              <stop offset="100%" stopColor="#bf5af2" />
            </linearGradient>
          </defs>
          <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#logo-gradient)" />
          <circle cx="14" cy="14" r="6.5" fill="none" stroke="#fff" strokeWidth="2.6" />
          <path d="M19 19l5.5 5.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M10.5 14.5h2l1.2-2.6 1.6 4.6 1.2-2h1.5" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="rail-items">
        {ITEMS.map((item) => (
          <RailButton
            key={item.section}
            item={item}
            active={section === item.section}
            badge={badges[item.section]}
            alarm={alarms[item.section]}
            onClick={() => onSelect(item.section)}
          />
        ))}
      </div>
      <div className="rail-bottom">
        <RailButton item={settings} active={section === "settings"} onClick={() => onSelect("settings")} />
      </div>
    </nav>
  );
}
