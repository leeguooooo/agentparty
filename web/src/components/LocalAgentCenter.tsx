import { useState } from "react";
import { useT } from "../i18n/useT";
import { desktopAgentAdapter, type DesktopAgentAdapter } from "../lib/desktopAgent";
import { DesktopAgentPanel } from "./DesktopAgentPanel";
import { LocalAgentsOverview } from "./LocalAgentsOverview";
import { ResidentDutyLogs } from "./ResidentDutyLogs";
import { SectionedDialog, type SectionedDialogSection } from "./SectionedDialog";
import "../i18n/strings/LocalAgentCenter";

export type LocalAgentCenterSection = "overview" | "launcher" | "logs";

interface Props {
  onClose(): void;
  adapter?: DesktopAgentAdapter;
  initialSection?: LocalAgentCenterSection;
}

/**
 * Cross-channel local-agent operations belong to a dedicated control center,
 * not to personal/global settings. Modules stay mounted so in-progress filters
 * and launch drafts survive navigation; inactive modules pause their I/O.
 */
export function LocalAgentCenter({
  onClose,
  adapter = desktopAgentAdapter,
  initialSection = "overview",
}: Props) {
  const t = useT();
  const [activeSection, setActiveSection] = useState<LocalAgentCenterSection>(initialSection);
  const sections: readonly SectionedDialogSection<LocalAgentCenterSection>[] = [
    {
      id: "overview",
      label: t("LocalAgentCenter.section.overview"),
      content: <LocalAgentsOverview t={t} adapter={adapter} active={activeSection === "overview"} />,
    },
    {
      id: "launcher",
      label: t("LocalAgentCenter.section.launcher"),
      content: <DesktopAgentPanel t={t} adapter={adapter} active={activeSection === "launcher"} />,
    },
    {
      id: "logs",
      label: t("LocalAgentCenter.section.logs"),
      content: <ResidentDutyLogs t={t} adapter={adapter} active={activeSection === "logs"} />,
    },
  ];

  return (
    <SectionedDialog<LocalAgentCenterSection>
      idPrefix="local-agent-center"
      title={t("LocalAgentCenter.title")}
      closeLabel={t("LocalAgentCenter.close")}
      navigationLabel={t("LocalAgentCenter.navigation")}
      sections={sections}
      initialSection={initialSection}
      onClose={onClose}
      onActiveSectionChange={setActiveSection}
      panelClassName="settings-panel--agent-center"
    />
  );
}
