import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NodeGrid } from "@/components/node/NodeGrid";
import { FloatingControls } from "@/components/shell/FloatingControls";
import { useNodeStoreStatus } from "@/hooks/useNode";
import { useThemeSettings } from "@/hooks/useThemeSettings";

export function Home() {
  const [searchParams] = useSearchParams();
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const themeSettings = useThemeSettings();
  const { hydrated: storeHydrated } = useNodeStoreStatus();
  const homeReady = themeSettings.isReady && storeHydrated;

  const isThemeManageView = searchParams.get("view") === "theme-manage";

  useEffect(() => {
    if (isThemeManageView) {
      window.location.replace("/admin/theme_managed");
    }
  }, [isThemeManageView]);

  if (isThemeManageView) {
    return null;
  }

  return (
    <div
      className={`home-dashboard relative pb-2${controlsExpanded ? " is-controls-expanded" : ""}`}
    >
      {homeReady && <FloatingControls onExpandedChange={setControlsExpanded} />}
      <NodeGrid />
    </div>
  );
}
