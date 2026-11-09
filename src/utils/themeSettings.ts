import type { ThemeSettings } from "@/types/komari";
import {
  DEFAULT_BACKGROUND_ALIGNMENT,
  DEFAULT_SURFACE_OPACITY,
  normalizeBackgroundAlignment,
  normalizeBackgroundUrl,
  normalizeSurfaceOpacity,
} from "@/utils/background";
import {
  DEFAULT_COST_RATE_API_URL,
  normalizeCostIgnoredNodes,
  normalizeCostPremiums,
  normalizeCostRateApiUrl,
  type CostPremiumEntry,
} from "@/utils/cost";
import { normalizeNodeIdentityList } from "@/utils/nodeIdentity";
import {
  normalizeFarmSignColors,
  type FarmSignColorMap,
} from "@/utils/farmSign";
import { normalizeHomeGroupOrder } from "@/utils/homeNodes";
import {
  HOME_SORT_NATURAL_DIRECTION,
  isHomeSortDirection,
  isHomeSortField,
  type HomeSortDirection,
  type HomeSortField,
} from "@/utils/homeSort";
import {
  normalizeHomepageMultiPingGroups,
  normalizeHomepageMultiPingTaskIds,
  normalizeHomepagePingTaskBindings,
  type HomepageMultiPingGroup,
  type HomepagePingTaskBindings,
} from "@/utils/pingTasks";

export type Appearance = "system" | "light" | "dark" | "farm";
/** farm 主题的场景：6:00–18:00 为昼，其余为夕（含夜晚）。 */
export type FarmScene = "day" | "dusk";
export type NodeViewMode = "large" | "compact" | "mini" | "list";
export type HomeOverviewDensity = "auto" | "full" | "compact";

/**
 * 顶部总览卡是否使用密集(压缩)变体。
 * - full: 强制完整(任何视图模式都不压缩)
 * - compact: 强制压缩(任何视图模式都压缩)
 * - auto(默认): 跟随视图模式——大卡/紧凑卡完整, mini/列表压缩。
 */
export function resolveHomeOverviewDense(
  density: HomeOverviewDensity,
  mode: NodeViewMode,
): boolean {
  if (density === "full") return false;
  if (density === "compact") return true;
  return mode === "mini" || mode === "list";
}

export interface ResolvedThemeSettings {
  defaultAppearance: Appearance;
  desktopNodeViewMode: NodeViewMode;
  mobileNodeViewMode: NodeViewMode;
  enableAdminButton: boolean;
  showPingChart: boolean;
  homepagePingBindings: HomepagePingTaskBindings;
  enableHomepageMultiPing: boolean;
  homepageMultiPingTaskIds: number[];
  /** 多套三网线路(每套 3 任务 + 各自选节点);空数组 = 未配置组,回落单线路。 */
  homepageMultiPingGroups: HomepageMultiPingGroup[];
  fakePingForUnbound: boolean;
  showHomeOverview: boolean;
  homeOverviewDensity: "auto" | "full" | "compact";
  homeOverviewCollapsible: boolean;
  showGroupTabs: boolean;
  showRegionBar: boolean;
  showCardGroup: boolean;
  homeGroupOrder: string[];
  enableHomeSort: boolean;
  homeSortField: HomeSortField;
  homeSortDirection: HomeSortDirection;
  showCostSummary: boolean;
  showCostSummaryFloatingButton: boolean;
  showOverviewRatings: boolean;
  showTrafficRating: boolean;
  showBandwidthRating: boolean;
  showAssetRating: boolean;
  trafficRatingLabels: string;
  bandwidthRatingLabels: string;
  assetRatingLabels: string;
  compactShowTrafficTotal: boolean;
  compactShowBilling: boolean;
  compactShowUptime: boolean;
  showConnections: boolean;
  showTodayTrafficPopover: boolean;
  hiddenNodes: string[];
  costIgnoredNodes: string[];
  costPremiums: Record<string, CostPremiumEntry>;
  costRateApiUrl: string;
  enableBackgroundImage: boolean;
  backgroundImageInFarm: boolean;
  farmSignColors: FarmSignColorMap;
  backgroundImage: string;
  backgroundImageMobile: string;
  backgroundAlignment: string;
  surfaceOpacity: number;
}

export const DEFAULT_THEME_SETTINGS: ResolvedThemeSettings = {
  defaultAppearance: "farm",
  desktopNodeViewMode: "large",
  mobileNodeViewMode: "compact",
  enableAdminButton: true,
  showPingChart: true,
  homepagePingBindings: {},
  enableHomepageMultiPing: false,
  homepageMultiPingTaskIds: [],
  homepageMultiPingGroups: [],
  fakePingForUnbound: false,
  showHomeOverview: true,
  homeOverviewDensity: "auto",
  homeOverviewCollapsible: false,
  showGroupTabs: true,
  showRegionBar: true,
  showCardGroup: true,
  homeGroupOrder: [],
  enableHomeSort: true,
  homeSortField: "default",
  homeSortDirection: HOME_SORT_NATURAL_DIRECTION.default,
  showCostSummary: true,
  showCostSummaryFloatingButton: true,
  showOverviewRatings: true,
  showTrafficRating: true,
  showBandwidthRating: true,
  showAssetRating: true,
  trafficRatingLabels: "",
  bandwidthRatingLabels: "",
  assetRatingLabels: "",
  compactShowTrafficTotal: true,
  compactShowBilling: true,
  compactShowUptime: true,
  showConnections: false,
  showTodayTrafficPopover: true,
  hiddenNodes: [],
  costIgnoredNodes: [],
  costPremiums: {},
  costRateApiUrl: DEFAULT_COST_RATE_API_URL,
  enableBackgroundImage: true,
  backgroundImageInFarm: true,
  farmSignColors: {},
  backgroundImage: "",
  backgroundImageMobile: "",
  backgroundAlignment: DEFAULT_BACKGROUND_ALIGNMENT,
  surfaceOpacity: DEFAULT_SURFACE_OPACITY,
};

export function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark" || value === "farm";
}

function normalizeAppearance(
  value: unknown,
  fallback: Appearance = DEFAULT_THEME_SETTINGS.defaultAppearance,
): Appearance {
  if (isAppearance(value)) return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "farm" || lower === "像素农场" || lower === "农场") return "farm";
    if (lower === "system" || lower === "跟随系统" || lower === "系统") return "system";
    if (lower === "light" || lower === "浅色") return "light";
    if (lower === "dark" || lower === "深色") return "dark";
  }
  return fallback;
}

export function isNodeViewMode(value: unknown): value is NodeViewMode {
  return value === "large" || value === "compact" || value === "mini" || value === "list";
}

function normalizeNodeViewMode(
  value: unknown,
  fallback: NodeViewMode,
): NodeViewMode {
  if (isNodeViewMode(value)) return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "large" || lower === "大卡片" || lower === "大卡" || lower === "大视图") return "large";
    if (lower === "compact" || lower === "紧凑卡" || lower === "小卡" || lower === "小视图") return "compact";
    if (lower === "mini" || lower === "迷你卡" || lower === "迷你" || lower === "迷你视图") return "mini";
    if (lower === "list" || lower === "表格列表" || lower === "列表" || lower === "列表视图") return "list";
    if (lower.length > 0) return "compact";
  }
  return fallback;
}

// 列表档仅桌面可用(见 useViewMode 的 MOBILE_VIEW_MODES)。移动端即便配置里存了 "list"
// (历史值/外部写入)也归一化回默认档,避免管理页无选中项、首页又强制回落 compact 的不一致。
function normalizeMobileNodeViewMode(
  value: unknown,
  fallback: NodeViewMode,
): NodeViewMode {
  const mode = normalizeNodeViewMode(value, fallback);
  return mode === "list" ? fallback : mode;
}

function enabledUnlessFalse(value: unknown): boolean {
  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }
  return true;
}

function isTruthyBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeHomeOverviewDensity(value: unknown): "auto" | "full" | "compact" {
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "full" || lower === "完整") return "full";
    if (lower === "compact" || lower === "压缩") return "compact";
  }
  return "auto";
}

function normalizePlainText(value: unknown) {
  return typeof value === "string" ? value : "";
}

// 管理员默认排序:字段非法回落 default;方向非法时回落该字段的自然方向(文本升、数值降)。
function normalizeHomeSortDefault(
  field: unknown,
  direction: unknown,
): { homeSortField: HomeSortField; homeSortDirection: HomeSortDirection } {
  const homeSortField = isHomeSortField(field) ? field : "default";
  return {
    homeSortField,
    homeSortDirection: isHomeSortDirection(direction)
      ? direction
      : HOME_SORT_NATURAL_DIRECTION[homeSortField],
  };
}

export function normalizeThemeSettings(
  settings: (ThemeSettings & Record<string, unknown>) | null | undefined,
): ResolvedThemeSettings {
  const homepageMultiPingTaskIds = normalizeHomepageMultiPingTaskIds(
    settings?.homepageMultiPingTaskIds ?? settings?.pingTasks ?? settings?.ping_tasks,
  );
  const homepageMultiPingGroups = normalizeHomepageMultiPingGroups(
    settings?.homepageMultiPingGroups,
    homepageMultiPingTaskIds,
  );
  const rawEnableMultiPing = (settings as Record<string, unknown> | null | undefined)?.enableHomepageMultiPing;
  const multiPingActive =
    isTruthyBoolean(rawEnableMultiPing ?? settings?.showModernPingStats) ||
    (homepageMultiPingTaskIds.length === 3 &&
      rawEnableMultiPing !== false &&
      rawEnableMultiPing !== "false");

  let homepagePingBindings = normalizeHomepagePingTaskBindings(settings?.homepagePingBindings);
  // 如果后台只配置了 1 个 Ping 任务，且未配置单机绑定字典，则自动作为全局单线路绑定
  if (Object.keys(homepagePingBindings).length === 0 && homepageMultiPingTaskIds.length === 1) {
    homepagePingBindings = { [String(homepageMultiPingTaskIds[0])]: [] };
  }

  return {
    defaultAppearance: normalizeAppearance(
      settings?.defaultAppearance ?? settings?.appearance,
    ),
    desktopNodeViewMode: normalizeNodeViewMode(
      settings?.desktopNodeViewMode ?? settings?.desktopDefaultViewMode ?? settings?.defaultViewMode,
      DEFAULT_THEME_SETTINGS.desktopNodeViewMode,
    ),
    mobileNodeViewMode: normalizeMobileNodeViewMode(
      settings?.mobileNodeViewMode ?? settings?.mobileDefaultViewMode ?? settings?.defaultViewMode,
      DEFAULT_THEME_SETTINGS.mobileNodeViewMode,
    ),
    enableAdminButton: enabledUnlessFalse(settings?.enableAdminButton),
    showPingChart: enabledUnlessFalse(settings?.showPingChart),
    homepagePingBindings,
    enableHomepageMultiPing: multiPingActive,
    homepageMultiPingTaskIds,
    homepageMultiPingGroups,
    fakePingForUnbound: isTruthyBoolean(settings?.fakePingForUnbound),
    showHomeOverview: enabledUnlessFalse(settings?.showHomeOverview),
    homeOverviewDensity: normalizeHomeOverviewDensity(settings?.homeOverviewDensity),
    homeOverviewCollapsible: isTruthyBoolean(settings?.homeOverviewCollapsible),
    showGroupTabs: enabledUnlessFalse(settings?.showGroupTabs),
    showRegionBar: enabledUnlessFalse(settings?.showRegionBar),
    showCardGroup: enabledUnlessFalse(settings?.showCardGroup),
    homeGroupOrder: normalizeHomeGroupOrder(settings?.homeGroupOrder),
    enableHomeSort: enabledUnlessFalse(settings?.enableHomeSort),
    ...normalizeHomeSortDefault(settings?.homeSortField, settings?.homeSortDirection),
    showCostSummary: enabledUnlessFalse(settings?.showCostSummary),
    showCostSummaryFloatingButton: enabledUnlessFalse(settings?.showCostSummaryFloatingButton),
    showOverviewRatings: enabledUnlessFalse(settings?.showOverviewRatings),
    showTrafficRating: enabledUnlessFalse(settings?.showTrafficRating),
    showBandwidthRating: enabledUnlessFalse(settings?.showBandwidthRating),
    showAssetRating: enabledUnlessFalse(settings?.showAssetRating),
    trafficRatingLabels: normalizePlainText(settings?.trafficRatingLabels),
    bandwidthRatingLabels: normalizePlainText(settings?.bandwidthRatingLabels),
    assetRatingLabels: normalizePlainText(settings?.assetRatingLabels),
    compactShowTrafficTotal: enabledUnlessFalse(settings?.compactShowTrafficTotal),
    compactShowBilling: enabledUnlessFalse(settings?.compactShowBilling),
    compactShowUptime: enabledUnlessFalse(settings?.compactShowUptime),
    showConnections: isTruthyBoolean(settings?.showConnections),
    showTodayTrafficPopover: enabledUnlessFalse(settings?.showTodayTrafficPopover),
    hiddenNodes: normalizeNodeIdentityList(settings?.hiddenNodes),
    costIgnoredNodes: normalizeCostIgnoredNodes(settings?.costIgnoredNodes),
    costPremiums: normalizeCostPremiums(settings?.costPremiums),
    costRateApiUrl: normalizeCostRateApiUrl(settings?.costRateApiUrl),
    enableBackgroundImage: enabledUnlessFalse(settings?.enableBackgroundImage),
    backgroundImageInFarm: enabledUnlessFalse(settings?.backgroundImageInFarm),
    farmSignColors: normalizeFarmSignColors(settings?.farmSignColors),
    backgroundImage: normalizeBackgroundUrl(settings?.backgroundImage),
    backgroundImageMobile: normalizeBackgroundUrl(settings?.backgroundImageMobile),
    backgroundAlignment: normalizeBackgroundAlignment(settings?.backgroundAlignment),
    surfaceOpacity: normalizeSurfaceOpacity(settings?.surfaceOpacity),
  };
}
