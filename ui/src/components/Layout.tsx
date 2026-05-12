import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Moon, Settings, Sun } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
import { CompanyRail } from "./CompanyRail";
import { Sidebar } from "./Sidebar";
import { SidebarNew } from "./SidebarNew";
import { AskBar } from "./AskBar";
import {
  useAskSuggestions,
  type AskCommandSuggestion,
  type AskPageSuggestion,
  type AskSuggestion,
} from "../hooks/useAskSuggestions";
import { InstanceSidebar } from "./InstanceSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { CommandPalette } from "./CommandPalette";
import { isAskFirstShellEnabled } from "../lib/feature-flags";
// Lazy-load the three "Add" dialogs that statically import MarkdownEditor
// (and through it, `@mdxeditor/editor` + `lexical` — ~459 KB gzip combined).
// Layout renders on every authenticated page, so eager imports here drag
// `vendor-mdxeditor` + `vendor-lexical` onto the cold critical path for the
// ~95% of users who never open one of these dialogs. We pair `React.lazy` +
// `Suspense` with conditional rendering on the dialog's open-state from
// `useDialog()` so the chunk only downloads on first open. Ticket L2-E01.
const NewIssueDialog = lazy(() =>
  import("./NewIssueDialog").then((m) => ({ default: m.NewIssueDialog })),
);
const NewProjectDialog = lazy(() =>
  import("./NewProjectDialog").then((m) => ({ default: m.NewProjectDialog })),
);
const NewGoalDialog = lazy(() =>
  import("./NewGoalDialog").then((m) => ({ default: m.NewGoalDialog })),
);
// NewAgentDialog stays eager — it does NOT import MarkdownEditor.
import { NewAgentDialog } from "./NewAgentDialog";
import { KeyboardShortcutsCheatsheet } from "./KeyboardShortcutsCheatsheet";
import { ToastViewport } from "./ToastViewport";
import { MobileBottomNav } from "./MobileBottomNav";
import { WorktreeBanner } from "./WorktreeBanner";
import { DevRestartBanner } from "./DevRestartBanner";
import { AppRunnerBanner } from "./AppRunnerBanner";
import { useDialog } from "../context/DialogContext";
import { GeneralSettingsProvider } from "../context/GeneralSettingsContext";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useTheme } from "../context/ThemeContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { bootstrapStateApi, diagnosticsApi, healthApi } from "../api/health";
import { instanceSettingsApi } from "../api/instanceSettings";
import { shouldSyncCompanySelectionFromRoute } from "../lib/company-selection";
import {
  DEFAULT_INSTANCE_SETTINGS_PATH,
  normalizeRememberedInstanceSettingsPath,
} from "../lib/instance-settings";
import {
  resetNavigationScroll,
  SIDEBAR_SCROLL_RESET_STATE,
  shouldResetScrollOnNavigation,
} from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { scheduleMainContentFocus } from "../lib/main-content-focus";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

const INSTANCE_SETTINGS_MEMORY_KEY = "founderos.lastInstanceSettingsPath";

function readRememberedInstanceSettingsPath(): string {
  if (typeof window === "undefined") return DEFAULT_INSTANCE_SETTINGS_PATH;
  try {
    return normalizeRememberedInstanceSettingsPath(window.localStorage.getItem(INSTANCE_SETTINGS_MEMORY_KEY));
  } catch {
    return DEFAULT_INSTANCE_SETTINGS_PATH;
  }
}

export function Layout() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  // `newIssueOpen` / `newProjectOpen` / `newGoalOpen` gate the lazy chunk
  // download for the dialogs — only mount them once the user opens one.
  // After first mount React keeps the chunk in memory; subsequent opens are
  // instant. See lazy() imports above. Ticket L2-E01.
  const {
    openNewIssue,
    openOnboarding,
    newIssueOpen,
    newProjectOpen,
    newGoalOpen,
  } = useDialog();
  const { togglePanelVisible } = usePanel();
  // P3 Wave 1 — Ask-First shell feature flag. Default OFF; flip via
  // `VITE_FOUNDEROS_ASK_FIRST_SHELL=true` env var or `?shell=new` query
  // param. Drives sidebar swap + AskBar render. See ui/src/lib/feature-flags.ts.
  const askFirstShell = isAskFirstShellEnabled();
  // AskBar state — lives at Layout scope so the typed query survives
  // route changes within the same shell session (F-06 preserves the
  // sentence; Esc + ⌘K must restore it across pages).
  const [askBarValue, setAskBarValue] = useState("");
  const {
    companies,
    loading: companiesLoading,
    selectedCompany,
    selectedCompanyId,
    selectionSource,
    setSelectedCompanyId,
  } = useCompany();
  const { theme, toggleTheme } = useTheme();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const previousPathname = useRef<string | null>(null);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [instanceSettingsTarget, setInstanceSettingsTarget] = useState<string>(() => readRememberedInstanceSettingsPath());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // L2-E01: track "has the user ever opened this dialog?" so we can keep the
  // lazy chunk mounted after first open. Without this, closing the dialog
  // would unmount the lazy component, which is fine functionally but the
  // browser keeps the JS chunk in memory either way — keeping the component
  // mounted preserves any in-progress form state if the user reopens.
  const [newIssueDialogMounted, setNewIssueDialogMounted] = useState(false);
  const [newProjectDialogMounted, setNewProjectDialogMounted] = useState(false);
  const [newGoalDialogMounted, setNewGoalDialogMounted] = useState(false);
  useEffect(() => {
    if (newIssueOpen) setNewIssueDialogMounted(true);
  }, [newIssueOpen]);
  useEffect(() => {
    if (newProjectOpen) setNewProjectDialogMounted(true);
  }, [newProjectOpen]);
  useEffect(() => {
    if (newGoalOpen) setNewGoalDialogMounted(true);
  }, [newGoalOpen]);

  const nextTheme = theme === "dark" ? "light" : "dark";
  const matchedCompany = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix) ?? null;
  }, [companies, companyPrefix]);
  const hasUnknownCompanyPrefix =
    Boolean(companyPrefix) && !companiesLoading && companies.length > 0 && !matchedCompany;
  // Task #139 split: deploymentMode lives on /api/health/bootstrap-state
  // (public), devServer + features live on /api/health/diagnostics
  // (admin-gated; local_trusted short-circuits via local_implicit).
  // Server version (for the v-tooltip) lives on /api/health ROOT.
  const { data: health } = useQuery({
    queryKey: queryKeys.bootstrapState,
    queryFn: () => bootstrapStateApi.get(),
    retry: false,
  });
  const { data: healthRoot } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const { data: diagnostics } = useQuery({
    queryKey: queryKeys.diagnostics,
    queryFn: () => diagnosticsApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.devServer?.enabled ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });
  const keyboardShortcutsEnabled = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  }).data?.keyboardShortcuts === true;

  useEffect(() => {
    if (companiesLoading || onboardingTriggered.current) return;
    if (health?.deploymentMode === "authenticated") return;
    if (companies.length === 0) {
      onboardingTriggered.current = true;
      openOnboarding();
    }
  }, [companies, companiesLoading, openOnboarding, health?.deploymentMode]);

  useEffect(() => {
    if (!companyPrefix || companiesLoading || companies.length === 0) return;

    if (!matchedCompany) {
      const fallback = (selectedCompanyId ? companies.find((company) => company.id === selectedCompanyId) : null)
        ?? companies[0]
        ?? null;
      if (fallback && selectedCompanyId !== fallback.id) {
        setSelectedCompanyId(fallback.id, { source: "route_sync" });
      }
      return;
    }

    if (companyPrefix !== matchedCompany.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${matchedCompany.issuePrefix}${suffix}${location.search}`, { replace: true });
      return;
    }

    if (
      shouldSyncCompanySelectionFromRoute({
        selectionSource,
        selectedCompanyId,
        routeCompanyId: matchedCompany.id,
      })
    ) {
      setSelectedCompanyId(matchedCompany.id, { source: "route_sync" });
    }
  }, [
    companyPrefix,
    companies,
    companiesLoading,
    matchedCompany,
    location.pathname,
    location.search,
    navigate,
    selectionSource,
    selectedCompanyId,
    setSelectedCompanyId,
  ]);

  const togglePanel = togglePanelVisible;
  const openSearch = useCallback(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  useCompanyPageMemory();

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    onNewIssue: () => openNewIssue(),
    onSearch: openSearch,
    onToggleSidebar: toggleSidebar,
    onTogglePanel: togglePanel,
    onShowShortcuts: () => setShortcutsOpen(true),
  });

  // AskBar suggestions — built from in-memory page + command lists.
  // No new server call in Wave 1; Wave 2-3 will add agents + recent
  // entities via the existing api/agents + api/issues queries.
  const askCommands: AskCommandSuggestion[] = useMemo(
    () => [
      {
        kind: "command",
        id: "cmd-new-issue",
        domId: "askbar-cmd-new-issue",
        label: "New issue",
        subtitle: "Open the New Issue dialog (legacy fallback)",
        shortcut: "C",
        onSelect: () => openNewIssue(),
      },
    ],
    [openNewIssue],
  );
  const askPages: AskPageSuggestion[] = useMemo(
    () => [
      { kind: "page", id: "page-today", domId: "askbar-page-today", label: "Today", to: "/today", shortcut: "T" },
      { kind: "page", id: "page-work", domId: "askbar-page-work", label: "Work", to: "/work", shortcut: "W" },
      { kind: "page", id: "page-team", domId: "askbar-page-team", label: "Team", to: "/team", shortcut: "E" },
      { kind: "page", id: "page-library", domId: "askbar-page-library", label: "Library", to: "/library", shortcut: "L" },
      { kind: "page", id: "page-settings", domId: "askbar-page-settings", label: "Settings", to: "/settings", shortcut: "S" },
    ],
    [],
  );
  const askGroups = useAskSuggestions({
    query: askBarValue,
    commands: askCommands,
    agents: [],
    pages: askPages,
    recent: [],
  });

  const handleAskBarSelect = useCallback(
    (suggestion: AskSuggestion) => {
      if (suggestion.kind === "command") {
        suggestion.onSelect();
      } else if (suggestion.kind === "page" || suggestion.kind === "agent" || suggestion.kind === "recent") {
        navigate(suggestion.to);
      }
      setAskBarValue("");
    },
    [navigate],
  );

  const handleAskTeam = useCallback(
    (sentence: string) => {
      // OQ-1 resolution — pre-fill the existing IssueDialog with the
      // typed sentence as the title. Wave 4 may promote this to a real
      // POST /api/companies/:id/ask endpoint once we measure how often
      // founders reach for it.
      openNewIssue({ title: sentence });
      setAskBarValue("");
    },
    [openNewIssue],
  );

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      return;
    }
    lastMainScrollTop.current = 0;
    setMobileNavVisible(true);
  }, [isMobile]);

  // Swipe gesture to open/close sidebar on mobile
  useEffect(() => {
    if (!isMobile) return;

    const EDGE_ZONE = 30; // px from left edge to start open-swipe
    const MIN_DISTANCE = 50; // minimum horizontal swipe distance
    const MAX_VERTICAL = 75; // max vertical drift before we ignore

    let startX = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]!;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);

      if (dy > MAX_VERTICAL) return; // vertical scroll, ignore

      // Swipe right from left edge → open
      if (!sidebarOpen && startX < EDGE_ZONE && dx > MIN_DISTANCE) {
        setSidebarOpen(true);
        return;
      }

      // Swipe left when open → close
      if (sidebarOpen && dx < -MIN_DISTANCE) {
        setSidebarOpen(false);
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, sidebarOpen, setSidebarOpen]);

  const updateMobileNavVisibility = useCallback((currentTop: number) => {
    const delta = currentTop - lastMainScrollTop.current;

    if (currentTop <= 24) {
      setMobileNavVisible(true);
    } else if (delta > 8) {
      setMobileNavVisible(false);
    } else if (delta < -8) {
      setMobileNavVisible(true);
    }

    lastMainScrollTop.current = currentTop;
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      lastMainScrollTop.current = 0;
      return;
    }

    const onScroll = () => {
      updateMobileNavVisibility(window.scrollY || document.documentElement.scrollTop || 0);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, [isMobile, updateMobileNavVisibility]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = isMobile ? "visible" : "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  useEffect(() => {
    if (!location.pathname.startsWith("/instance/settings/")) return;

    const nextPath = normalizeRememberedInstanceSettingsPath(
      `${location.pathname}${location.search}${location.hash}`,
    );
    setInstanceSettingsTarget(nextPath);

    try {
      window.localStorage.setItem(INSTANCE_SETTINGS_MEMORY_KEY, nextPath);
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [location.hash, location.pathname, location.search]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const mainContent = mainContentRef.current;
    return scheduleMainContentFocus(mainContent);
  }, [location.pathname]);

  useEffect(() => {
    const shouldResetScroll = shouldResetScrollOnNavigation({
      previousPathname: previousPathname.current,
      pathname: location.pathname,
      navigationType,
      state: location.state,
    });

    previousPathname.current = location.pathname;

    if (!shouldResetScroll) return;
    resetNavigationScroll(mainContentRef.current);
  }, [location.pathname, navigationType]);

  return (
    <GeneralSettingsProvider value={{ keyboardShortcutsEnabled }}>
      <div
      className={cn(
        "bg-background text-foreground pt-[env(safe-area-inset-top)]",
        isMobile ? "min-h-dvh" : "flex h-dvh flex-col overflow-hidden",
      )}
      >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to Main Content
      </a>
      <WorktreeBanner />
      <DevRestartBanner devServer={diagnostics?.devServer} />
      <AppRunnerBanner />
      <div className={cn("min-h-0 flex-1", isMobile ? "w-full" : "flex overflow-hidden")}>
        {isMobile && sidebarOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          />
        )}

        {isMobile ? (
          <div
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] transition-transform duration-100 ease-out",
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <CompanyRail />
              {isInstanceSettingsRoute ? <InstanceSidebar /> : askFirstShell ? <SidebarNew /> : <Sidebar />}
            </div>
            <div className="border-t border-r border-border px-3 py-2 bg-background">
              <div className="flex items-center gap-1">
                <a
                  href="https://docs.founderos.ai/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors text-foreground/80 hover:bg-accent/50 hover:text-foreground flex-1 min-w-0"
                >
                  <BookOpen className="h-4 w-4 shrink-0" />
                  <span className="truncate">Documentation</span>
                </a>
                {healthRoot?.version && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="px-2 text-xs text-muted-foreground shrink-0 cursor-default">v</span>
                    </TooltipTrigger>
                    <TooltipContent>v{healthRoot.version}</TooltipContent>
                  </Tooltip>
                )}
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground shrink-0" asChild>
                  <Link
                    to={instanceSettingsTarget}
                    state={SIDEBAR_SCROLL_RESET_STATE}
                    aria-label="Instance settings"
                    title="Instance settings"
                    onClick={() => {
                      if (isMobile) setSidebarOpen(false);
                    }}
                  >
                    <Settings className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  onClick={toggleTheme}
                  aria-label={`Switch to ${nextTheme} mode`}
                  title={`Switch to ${nextTheme} mode`}
                >
                  {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col shrink-0">
            <div className="flex flex-1 min-h-0">
              <CompanyRail />
              <div
                className={cn(
                  "overflow-hidden transition-[width] duration-100 ease-out",
                  sidebarOpen ? "w-60" : "w-0"
                )}
              >
                {isInstanceSettingsRoute ? <InstanceSidebar /> : askFirstShell ? <SidebarNew /> : <Sidebar />}
              </div>
            </div>
            <div className="border-t border-r border-border px-3 py-2">
              <div className="flex items-center gap-1">
                <a
                  href="https://docs.founderos.ai/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors text-foreground/80 hover:bg-accent/50 hover:text-foreground flex-1 min-w-0"
                >
                  <BookOpen className="h-4 w-4 shrink-0" />
                  <span className="truncate">Documentation</span>
                </a>
                {healthRoot?.version && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="px-2 text-xs text-muted-foreground shrink-0 cursor-default">v</span>
                    </TooltipTrigger>
                    <TooltipContent>v{healthRoot.version}</TooltipContent>
                  </Tooltip>
                )}
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground shrink-0" asChild>
                  <Link
                    to={instanceSettingsTarget}
                    state={SIDEBAR_SCROLL_RESET_STATE}
                    aria-label="Instance settings"
                    title="Instance settings"
                    onClick={() => {
                      if (isMobile) setSidebarOpen(false);
                    }}
                  >
                    <Settings className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  onClick={toggleTheme}
                  aria-label={`Switch to ${nextTheme} mode`}
                  title={`Switch to ${nextTheme} mode`}
                >
                  {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
          {/*
           * P3 Wave 1 — AskBar lives at the top of the chrome content
           * column on every page. When the Ask-First flag is on, this
           * replaces the legacy header-toolbar search affordance. The
           * legacy CommandPalette still mounts below for non-flag users
           * (Cmd+K continues to work in legacy mode); the AskBar's own
           * Cmd+K listener wins via preventDefault when both are mounted.
           */}
          {askFirstShell && (
            <div
              className={cn(
                "flex h-14 shrink-0 items-center justify-center border-b border-border px-4",
                isMobile && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
              )}
              data-testid="askbar-header-slot"
            >
              <AskBar
                groups={askGroups}
                value={askBarValue}
                onChange={setAskBarValue}
                onSelectSuggestion={handleAskBarSelect}
                onAskTeam={handleAskTeam}
                variant={isMobile ? "compact" : "default"}
              />
            </div>
          )}
          <div
            className={cn(
              isMobile && !askFirstShell && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
            )}
          >
            <BreadcrumbBar />
          </div>
          <div className={cn(isMobile ? "block" : "flex flex-1 min-h-0")}>
            <main
              id="main-content"
              ref={mainContentRef}
              tabIndex={-1}
              className={cn(
                "flex-1 p-4 outline-none md:p-6",
                isMobile ? "overflow-visible pb-[calc(5rem+env(safe-area-inset-bottom))]" : "overflow-auto",
              )}
            >
              {hasUnknownCompanyPrefix ? (
                <NotFoundPage
                  scope="invalid_company_prefix"
                  requestedPrefix={companyPrefix ?? selectedCompany?.issuePrefix}
                />
              ) : (
                <Outlet />
              )}
            </main>
            <PropertiesPanel />
          </div>
        </div>
      </div>
      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      {/*
        Lazy-mounted dialogs: each chunk only downloads when the user first
        opens that dialog. Once mounted, we keep it rendered so close/reopen
        is instant (dialog hides itself via its own `open` prop). Fallback is
        `null` because the closed-state DOM is empty anyway. Ticket L2-E01.
      */}
      {(newIssueOpen || newIssueDialogMounted) && (
        <Suspense fallback={null}>
          <NewIssueDialog />
        </Suspense>
      )}
      {(newProjectOpen || newProjectDialogMounted) && (
        <Suspense fallback={null}>
          <NewProjectDialog />
        </Suspense>
      )}
      {(newGoalOpen || newGoalDialogMounted) && (
        <Suspense fallback={null}>
          <NewGoalDialog />
        </Suspense>
      )}
      <NewAgentDialog />
      <KeyboardShortcutsCheatsheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ToastViewport />
      </div>
    </GeneralSettingsProvider>
  );
}
