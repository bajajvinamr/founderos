import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  agentsApi,
  type AgentPermissionUpdate,
} from "../../api/agents";
import { companySkillsApi } from "../../api/companySkills";
import { assetsApi } from "../../api/assets";
import { ApiError } from "../../api/client";
import { useCompany } from "../../context/CompanyContext";
import { useSidebar } from "../../context/SidebarContext";
import { useToast } from "../../context/ToastContext";
import { useDialog } from "../../context/DialogContext";
import { queryKeys } from "../../lib/queryKeys";
import { adapterLabels, help } from "../../components/agent-config-primitives";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { MarkdownBody } from "../../components/MarkdownBody";
import { PackageFileTree, buildFileTree } from "../../components/PackageFileTree";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  MoreHorizontal,
  CheckCircle2,
  Trash2,
  Plus,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  HelpCircle,
  FolderOpen,
  Loader2,
  Copy,
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  type Agent,
  type AgentSkillEntry,
  type AgentSkillSnapshot,
} from "@founderos/shared";
import { cn } from "../../lib/utils";
import {
  applyAgentSkillSnapshot,
  arraysEqual,
  isReadOnlyUnmanagedSkillEntry,
} from "../../lib/agent-skills-state";
import { isMarkdown, setsEqual } from "../../lib/agent-detail-utils";
import { CopyText } from "../../components/CopyText";
import { PageSkeleton } from "../../components/PageSkeleton";

export function PromptsTab({
  agent,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: {
  agent: Agent;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { isMobile } = useSidebar();
  const [selectedFile, setSelectedFile] = useState<string>("AGENTS.md");
  const [showFilePanel, setShowFilePanel] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [bundleDraft, setBundleDraft] = useState<{
    mode: "managed" | "external";
    rootPath: string;
    entryFile: string;
  } | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [filePanelWidth, setFilePanelWidth] = useState(260);
  const containerRef = useRef<HTMLDivElement>(null);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const lastFileVersionRef = useRef<string | null>(null);
  const externalBundleRef = useRef<{
    rootPath: string;
    entryFile: string;
    selectedFile: string;
  } | null>(null);

  useEffect(() => {
    setSelectedFile("AGENTS.md");
    setShowFilePanel(false);
    setDraft(null);
    setBundleDraft(null);
    setNewFilePath("");
    setShowNewFileInput(false);
    setPendingFiles([]);
    setExpandedDirs(new Set());
    setAwaitingRefresh(false);
    lastFileVersionRef.current = null;
    externalBundleRef.current = null;
  }, [agent.id]);

  const isLocal =
    agent.adapterType === "claude_local" ||
    agent.adapterType === "codex_local" ||
    agent.adapterType === "opencode_local" ||
    agent.adapterType === "pi_local" ||
    agent.adapterType === "hermes_local" ||
    agent.adapterType === "cursor_local";

  const { data: bundle, isLoading: bundleLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsBundle(agent.id),
    queryFn: () => agentsApi.instructionsBundle(agent.id, companyId),
    enabled: Boolean(companyId && isLocal),
  });

  const persistedMode = bundle?.mode ?? "managed";
  const persistedRootPath = persistedMode === "managed"
    ? (bundle?.managedRootPath ?? bundle?.rootPath ?? "")
    : (bundle?.rootPath ?? "");
  const currentMode = bundleDraft?.mode ?? persistedMode;
  const currentEntryFile = bundleDraft?.entryFile ?? bundle?.entryFile ?? "AGENTS.md";
  const currentRootPath = bundleDraft?.rootPath ?? persistedRootPath;
  const fileOptions = useMemo(
    () => bundle?.files.map((file) => file.path) ?? [],
    [bundle],
  );
  const bundleMatchesDraft = Boolean(
    bundle &&
    currentMode === persistedMode &&
    currentEntryFile === bundle.entryFile &&
    currentRootPath === persistedRootPath,
  );
  const visibleFilePaths = useMemo(
    () => bundleMatchesDraft
      ? [...new Set([currentEntryFile, ...fileOptions, ...pendingFiles])]
      : [currentEntryFile, ...pendingFiles],
    [bundleMatchesDraft, currentEntryFile, fileOptions, pendingFiles],
  );
  const fileTree = useMemo(
    () => buildFileTree(Object.fromEntries(visibleFilePaths.map((filePath) => [filePath, ""]))),
    [visibleFilePaths],
  );
  const selectedOrEntryFile = selectedFile || currentEntryFile;
  const selectedFileExists = bundleMatchesDraft && fileOptions.includes(selectedOrEntryFile);
  const selectedFileSummary = bundle?.files.find((file) => file.path === selectedOrEntryFile) ?? null;

  const { data: selectedFileDetail, isLoading: fileLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsFile(agent.id, selectedOrEntryFile),
    queryFn: () => agentsApi.instructionsFile(agent.id, selectedOrEntryFile, companyId),
    enabled: Boolean(companyId && isLocal && selectedFileExists),
  });

  const updateBundle = useMutation({
    mutationFn: (data: {
      mode?: "managed" | "external";
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    }) => agentsApi.updateInstructionsBundle(agent.id, data, companyId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: () => setAwaitingRefresh(false),
  });

  const saveFile = useMutation({
    mutationFn: (data: { path: string; content: string; clearLegacyPromptTemplate?: boolean }) =>
      agentsApi.saveInstructionsFile(agent.id, data, companyId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: (_, variables) => {
      setPendingFiles((prev) => prev.filter((f) => f !== variables.path));
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, variables.path) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: () => setAwaitingRefresh(false),
  });

  const deleteFile = useMutation({
    mutationFn: (relativePath: string) => agentsApi.deleteInstructionsFile(agent.id, relativePath, companyId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: (_, relativePath) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.removeQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, relativePath) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: () => setAwaitingRefresh(false),
  });

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to upload images");
      return assetsApi.uploadImage(selectedCompanyId, file, namespace);
    },
  });

  useEffect(() => {
    if (!bundle) return;
    if (!bundleMatchesDraft) {
      if (selectedFile !== currentEntryFile) setSelectedFile(currentEntryFile);
      return;
    }
    const availablePaths = bundle.files.map((file) => file.path);
    if (availablePaths.length === 0) {
      if (selectedFile !== bundle.entryFile) setSelectedFile(bundle.entryFile);
      return;
    }
    if (!availablePaths.includes(selectedFile) && selectedFile !== currentEntryFile && !pendingFiles.includes(selectedFile)) {
      setSelectedFile(availablePaths.includes(bundle.entryFile) ? bundle.entryFile : availablePaths[0]!);
    }
  }, [bundle, bundleMatchesDraft, currentEntryFile, pendingFiles, selectedFile]);

  useEffect(() => {
    const nextExpanded = new Set<string>();
    for (const filePath of visibleFilePaths) {
      const parts = filePath.split("/");
      let currentPath = "";
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]!;
        nextExpanded.add(currentPath);
      }
    }
    setExpandedDirs((current) => (setsEqual(current, nextExpanded) ? current : nextExpanded));
  }, [visibleFilePaths]);

  useEffect(() => {
    const versionKey = selectedFileExists && selectedFileDetail
      ? `${selectedFileDetail.path}:${selectedFileDetail.content}`
      : `draft:${currentMode}:${currentRootPath}:${selectedOrEntryFile}`;
    if (awaitingRefresh) {
      setAwaitingRefresh(false);
      setBundleDraft(null);
      setDraft(null);
      lastFileVersionRef.current = versionKey;
      return;
    }
    if (lastFileVersionRef.current !== versionKey) {
      setDraft(null);
      lastFileVersionRef.current = versionKey;
    }
  }, [awaitingRefresh, currentMode, currentRootPath, selectedFileDetail, selectedFileExists, selectedOrEntryFile]);

  useEffect(() => {
    if (!bundle) return;
    setBundleDraft((current) => {
      if (current) return current;
      return {
        mode: persistedMode,
        rootPath: persistedRootPath,
        entryFile: bundle.entryFile,
      };
    });
  }, [bundle, persistedMode, persistedRootPath]);

  useEffect(() => {
    if (!bundle || currentMode !== "external") return;
    externalBundleRef.current = {
      rootPath: currentRootPath,
      entryFile: currentEntryFile,
      selectedFile: selectedOrEntryFile,
    };
  }, [bundle, currentEntryFile, currentMode, currentRootPath, selectedOrEntryFile]);

  const currentContent = selectedFileExists ? (selectedFileDetail?.content ?? "") : "";
  const displayValue = draft ?? currentContent;
  const bundleDirty = Boolean(
    bundleDraft &&
      (
        bundleDraft.mode !== persistedMode ||
        bundleDraft.rootPath !== persistedRootPath ||
        bundleDraft.entryFile !== (bundle?.entryFile ?? "AGENTS.md")
      ),
  );
  const fileDirty = draft !== null && draft !== currentContent;
  const isDirty = bundleDirty || fileDirty;
  const isSaving = updateBundle.isPending || saveFile.isPending || deleteFile.isPending || awaitingRefresh;

  useEffect(() => { onSavingChange(isSaving); }, [onSavingChange, isSaving]);
  useEffect(() => { onDirtyChange(isDirty); }, [onDirtyChange, isDirty]);

  useEffect(() => {
    onSaveActionChange(isDirty ? () => {
      const save = async () => {
        const shouldClearLegacy =
          Boolean(bundle?.legacyPromptTemplateActive) || Boolean(bundle?.legacyBootstrapPromptTemplateActive);
        if (bundleDirty && bundleDraft) {
          await updateBundle.mutateAsync({
            mode: bundleDraft.mode,
            rootPath: bundleDraft.mode === "external" ? bundleDraft.rootPath : null,
            entryFile: bundleDraft.entryFile,
          });
        }
        if (fileDirty) {
          await saveFile.mutateAsync({
            path: selectedOrEntryFile,
            content: displayValue,
            clearLegacyPromptTemplate: shouldClearLegacy,
          });
        }
      };
      void save().catch(() => undefined);
    } : null);
  }, [
    bundle,
    bundleDirty,
    bundleDraft,
    displayValue,
    fileDirty,
    isDirty,
    onSaveActionChange,
    saveFile,
    selectedOrEntryFile,
    updateBundle,
  ]);

  useEffect(() => {
    onCancelActionChange(isDirty ? () => {
      setDraft(null);
      if (bundle) {
        setBundleDraft({
          mode: persistedMode,
          rootPath: persistedRootPath,
          entryFile: bundle.entryFile,
        });
      }
    } : null);
  }, [bundle, isDirty, onCancelActionChange, persistedMode, persistedRootPath]);

  const handleSeparatorDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = filePanelWidth;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = Math.max(180, Math.min(500, startWidth + delta));
      setFilePanelWidth(next);
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [filePanelWidth]);

  if (!isLocal) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-muted-foreground">
          Instructions bundles are only available for local adapters.
        </p>
      </div>
    );
  }

  if (bundleLoading && !bundle) {
    return <PromptsTabSkeleton />;
  }

  return (
    <div className="space-y-6">
      {(bundle?.warnings ?? []).length > 0 && (
        <div className="space-y-2">
          {(bundle?.warnings ?? []).map((warning) => (
            <div key={warning} className="rounded-md border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
              {warning}
            </div>
          ))}
        </div>
      )}

      <Collapsible defaultOpen={currentMode === "external"}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4 pb-6">
          <TooltipProvider>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[auto_1fr_1fr]">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Mode
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      Managed: FounderOS stores and serves the instructions bundle. External: you provide a path on disk where the instructions live.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={currentMode === "managed" ? "default" : "outline"}
                    onClick={() => {
                      if (currentMode === "external") {
                        externalBundleRef.current = {
                          rootPath: currentRootPath,
                          entryFile: currentEntryFile,
                          selectedFile: selectedOrEntryFile,
                        };
                      }
                      const nextEntryFile = currentEntryFile || "AGENTS.md";
                      setBundleDraft({
                        mode: "managed",
                        rootPath: bundle?.managedRootPath ?? currentRootPath,
                        entryFile: nextEntryFile,
                      });
                      setSelectedFile(nextEntryFile);
                    }}
                  >
                    Managed
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={currentMode === "external" ? "default" : "outline"}
                    onClick={() => {
                      const externalBundle = externalBundleRef.current;
                      const nextEntryFile = externalBundle?.entryFile ?? currentEntryFile ?? "AGENTS.md";
                      setBundleDraft({
                        mode: "external",
                        rootPath: externalBundle?.rootPath ?? (bundle?.mode === "external" ? (bundle.rootPath ?? "") : ""),
                        entryFile: nextEntryFile,
                      });
                      setSelectedFile(externalBundle?.selectedFile ?? nextEntryFile);
                    }}
                  >
                    External
                  </Button>
                </div>
              </label>
              <label className="space-y-1.5 min-w-0">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Root path
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      The absolute directory on disk where the instructions bundle lives. In managed mode this is set by FounderOS automatically.
                    </TooltipContent>
                  </Tooltip>
                </span>
                {currentMode === "managed" ? (
                  <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground pt-1.5">
                    <span className="min-w-0 truncate" title={currentRootPath || undefined}>{currentRootPath || "(managed)"}</span>
                    {currentRootPath && (
                      <CopyText text={currentRootPath} className="shrink-0">
                        <Copy className="h-3.5 w-3.5" />
                      </CopyText>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={currentRootPath}
                      onChange={(event) => {
                        const nextRootPath = event.target.value;
                        externalBundleRef.current = {
                          rootPath: nextRootPath,
                          entryFile: currentEntryFile,
                          selectedFile: selectedOrEntryFile,
                        };
                        setBundleDraft({
                          mode: "external",
                          rootPath: nextRootPath,
                          entryFile: currentEntryFile,
                        });
                      }}
                      className="font-mono text-sm"
                      placeholder="/absolute/path/to/agent/prompts"
                    />
                    {currentRootPath && (
                      <CopyText text={currentRootPath} className="shrink-0">
                        <Copy className="h-3.5 w-3.5" />
                      </CopyText>
                    )}
                  </div>
                )}
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Entry file
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      The main file this teammate reads first when loading instructions. Defaults to AGENTS.md.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <Input
                  value={currentEntryFile}
                  onChange={(event) => {
                    const nextEntryFile = event.target.value || "AGENTS.md";
                    const nextSelectedFile = selectedOrEntryFile === currentEntryFile
                      ? nextEntryFile
                      : selectedOrEntryFile;
                    if (currentMode === "external") {
                      externalBundleRef.current = {
                        rootPath: currentRootPath,
                        entryFile: nextEntryFile,
                        selectedFile: nextSelectedFile,
                      };
                    }
                    if (selectedOrEntryFile === currentEntryFile) setSelectedFile(nextEntryFile);
                    setBundleDraft({
                      mode: currentMode,
                      rootPath: currentRootPath,
                      entryFile: nextEntryFile,
                    });
                  }}
                  className="font-mono text-sm"
                />
              </label>
            </div>
          </TooltipProvider>
        </CollapsibleContent>
      </Collapsible>

      <div ref={containerRef} className={cn("flex gap-0", isMobile && "flex-col gap-3")}>
        <div className={cn(
          "border border-border rounded-lg p-3 space-y-3 shrink-0",
          isMobile && showFilePanel && "block",
          isMobile && !showFilePanel && "hidden",
        )} style={isMobile ? undefined : { width: filePanelWidth }}>
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Files</h4>
            <div className="flex items-center gap-1">
              {!showNewFileInput && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  onClick={() => setShowNewFileInput(true)}
                >
                  +
                </Button>
              )}
              {isMobile && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setShowFilePanel(false)}
                >
                  ✕
                </Button>
              )}
            </div>
          </div>
          {showNewFileInput && (
            <div className="space-y-2">
              <Input
                value={newFilePath}
                onChange={(event) => setNewFilePath(event.target.value)}
                placeholder="TOOLS.md"
                className="font-mono text-sm"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setShowNewFileInput(false);
                    setNewFilePath("");
                  }
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  className="flex-1"
                  disabled={!newFilePath.trim() || newFilePath.includes("..")}
                  onClick={() => {
                    const candidate = newFilePath.trim();
                    if (!candidate || candidate.includes("..")) return;
                    setPendingFiles((prev) => prev.includes(candidate) ? prev : [...prev, candidate]);
                    setSelectedFile(candidate);
                    setDraft("");
                    setNewFilePath("");
                    setShowNewFileInput(false);
                  }}
                >
                  Create
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowNewFileInput(false);
                    setNewFilePath("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <PackageFileTree
            nodes={fileTree}
            selectedFile={selectedOrEntryFile}
            expandedDirs={expandedDirs}
            checkedFiles={new Set()}
            onToggleDir={(dirPath) => setExpandedDirs((current) => {
              const next = new Set(current);
              if (next.has(dirPath)) next.delete(dirPath);
              else next.add(dirPath);
              return next;
            })}
            onSelectFile={(filePath) => {
              setSelectedFile(filePath);
              if (!fileOptions.includes(filePath)) setDraft("");
              if (isMobile) setShowFilePanel(false);
            }}
            onToggleCheck={() => {}}
            showCheckboxes={false}
            renderFileExtra={(node) => {
              const file = bundle?.files.find((entry) => entry.path === node.path);
              if (!file) return null;
              if (file.deprecated) {
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="ml-3 shrink-0 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide cursor-help">
                        virtual file
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      Legacy inline prompt — this deprecated virtual file preserves the old promptTemplate content
                    </TooltipContent>
                  </Tooltip>
                );
              }
              return (
                <span className="ml-3 shrink-0 rounded border border-border text-muted-foreground px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {file.isEntryFile ? "entry" : `${file.size}b`}
                </span>
              );
            }}
          />
        </div>

        {/* Draggable separator */}
        {!isMobile && (
          <div
            className="w-1 shrink-0 cursor-col-resize hover:bg-border active:bg-primary/50 rounded transition-colors mx-1"
            onMouseDown={handleSeparatorDrag}
          />
        )}

        <div className={cn("border border-border rounded-lg p-4 space-y-3 min-w-0 flex-1", isMobile && showFilePanel && "hidden")}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {isMobile && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7 shrink-0"
                  onClick={() => setShowFilePanel(true)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              )}
              <div className="min-w-0">
                <h4 className="text-sm font-medium font-mono truncate">{selectedOrEntryFile}</h4>
                <p className="text-xs text-muted-foreground">
                  {selectedFileExists
                    ? selectedFileSummary?.deprecated
                      ? "Deprecated virtual file"
                      : `${selectedFileDetail?.language ?? "text"} file`
                    : "New file in this bundle"}
                </p>
              </div>
            </div>
            {selectedFileExists && !selectedFileSummary?.deprecated && selectedOrEntryFile !== currentEntryFile && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (confirm(`Delete ${selectedOrEntryFile}?`)) {
                    deleteFile.mutate(selectedOrEntryFile, {
                      onSuccess: () => {
                        setSelectedFile(currentEntryFile);
                        setDraft(null);
                      },
                    });
                  }
                }}
                disabled={deleteFile.isPending}
              >
                Delete
              </Button>
            )}
          </div>

          {selectedFileExists && fileLoading && !selectedFileDetail ? (
            <PromptEditorSkeleton />
          ) : isMarkdown(selectedOrEntryFile) ? (
            <MarkdownEditor
              key={selectedOrEntryFile}
              value={displayValue}
              onChange={(value) => setDraft(value ?? "")}
              placeholder="# Agent instructions"
              contentClassName="min-h-[420px] text-sm font-mono"
              imageUploadHandler={async (file) => {
                const namespace = `agents/${agent.id}/instructions/${selectedOrEntryFile.replaceAll("/", "-")}`;
                const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                return asset.contentPath;
              }}
            />
          ) : (
            <textarea
              value={displayValue}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[420px] w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm outline-none"
              placeholder="File contents"
            />
          )}
        </div>
      </div>

    </div>
  );
}

export function PromptsTabSkeleton() {
  return (
    <div className="max-w-5xl space-y-4">
      <div className="rounded-lg border border-border p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-[30rem] max-w-full" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-8 w-16" />
          </div>
          <Skeleton className="h-10 w-full" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full rounded-none" />
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
          </div>
          <PromptEditorSkeleton />
        </div>
      </div>
    </div>
  );
}

export function PromptEditorSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}

export function AgentSkillsTab({
  agent,
  companyId,
}: {
  agent: Agent;
  companyId?: string;
}) {
  type SkillRow = {
    id: string;
    key: string;
    name: string;
    description: string | null;
    detail: string | null;
    locationLabel: string | null;
    originLabel: string | null;
    linkTo: string | null;
    readOnly: boolean;
    adapterEntry: AgentSkillEntry | null;
  };

  const queryClient = useQueryClient();
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [lastSavedSkills, setLastSavedSkills] = useState<string[]>([]);
  const [unmanagedOpen, setUnmanagedOpen] = useState(false);
  const lastSavedSkillsRef = useRef<string[]>([]);
  const hasHydratedSkillSnapshotRef = useRef(false);
  const skipNextSkillAutosaveRef = useRef(true);

  const { data: skillSnapshot, isLoading } = useQuery({
    queryKey: queryKeys.agents.skills(agent.id),
    queryFn: () => agentsApi.skills(agent.id, companyId),
    enabled: Boolean(companyId),
  });

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId ?? ""),
    queryFn: () => companySkillsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  const syncSkills = useMutation({
    mutationFn: (desiredSkills: string[]) => agentsApi.syncSkills(agent.id, desiredSkills, companyId),
    onSuccess: async (snapshot) => {
      queryClient.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
      lastSavedSkillsRef.current = snapshot.desiredSkills;
      setLastSavedSkills(snapshot.desiredSkills);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
      ]);
    },
  });

  useEffect(() => {
    setSkillDraft([]);
    setLastSavedSkills([]);
    lastSavedSkillsRef.current = [];
    hasHydratedSkillSnapshotRef.current = false;
    skipNextSkillAutosaveRef.current = true;
  }, [agent.id]);

  useEffect(() => {
    if (!skillSnapshot) return;
    const nextState = applyAgentSkillSnapshot(
      {
        draft: skillDraft,
        lastSaved: lastSavedSkillsRef.current,
        hasHydratedSnapshot: hasHydratedSkillSnapshotRef.current,
      },
      skillSnapshot.desiredSkills,
    );
    skipNextSkillAutosaveRef.current = nextState.shouldSkipAutosave;
    hasHydratedSkillSnapshotRef.current = nextState.hasHydratedSnapshot;
    setSkillDraft(nextState.draft);
    lastSavedSkillsRef.current = nextState.lastSaved;
    setLastSavedSkills(nextState.lastSaved);
  }, [skillDraft, skillSnapshot]);

  useEffect(() => {
    if (!skillSnapshot) return;
    if (skipNextSkillAutosaveRef.current) {
      skipNextSkillAutosaveRef.current = false;
      return;
    }
    if (syncSkills.isPending) return;
    if (arraysEqual(skillDraft, lastSavedSkillsRef.current)) return;

    const timeout = window.setTimeout(() => {
      if (!arraysEqual(skillDraft, lastSavedSkillsRef.current)) {
        syncSkills.mutate(skillDraft);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [skillDraft, skillSnapshot, syncSkills.isPending, syncSkills.mutate]);

  const companySkillByKey = useMemo(
    () => new Map((companySkills ?? []).map((skill) => [skill.key, skill])),
    [companySkills],
  );
  const companySkillKeys = useMemo(
    () => new Set((companySkills ?? []).map((skill) => skill.key)),
    [companySkills],
  );
  const adapterEntryByKey = useMemo(
    () => new Map((skillSnapshot?.entries ?? []).map((entry) => [entry.key, entry])),
    [skillSnapshot],
  );
  const optionalSkillRows = useMemo<SkillRow[]>(
    () =>
      (companySkills ?? [])
        .filter((skill) => !adapterEntryByKey.get(skill.key)?.required)
        .map((skill) => ({
          id: skill.id,
          key: skill.key,
          name: skill.name,
          description: skill.description,
          detail: adapterEntryByKey.get(skill.key)?.detail ?? null,
          locationLabel: adapterEntryByKey.get(skill.key)?.locationLabel ?? null,
          originLabel: adapterEntryByKey.get(skill.key)?.originLabel ?? null,
          linkTo: `/skills/${skill.id}`,
          readOnly: false,
          adapterEntry: adapterEntryByKey.get(skill.key) ?? null,
        })),
    [adapterEntryByKey, companySkills],
  );
  const requiredSkillRows = useMemo<SkillRow[]>(
    () =>
      (skillSnapshot?.entries ?? [])
        .filter((entry) => entry.required)
        .map((entry) => {
          const companySkill = companySkillByKey.get(entry.key);
          return {
            id: companySkill?.id ?? `required:${entry.key}`,
            key: entry.key,
            name: companySkill?.name ?? entry.key,
            description: companySkill?.description ?? null,
            detail: entry.detail ?? null,
            locationLabel: entry.locationLabel ?? null,
            originLabel: entry.originLabel ?? null,
            linkTo: companySkill ? `/skills/${companySkill.id}` : null,
            readOnly: false,
            adapterEntry: entry,
          };
        }),
    [companySkillByKey, skillSnapshot],
  );
  const unmanagedSkillRows = useMemo<SkillRow[]>(
    () =>
      (skillSnapshot?.entries ?? [])
        .filter((entry) => isReadOnlyUnmanagedSkillEntry(entry, companySkillKeys))
        .map((entry) => ({
          id: `external:${entry.key}`,
          key: entry.key,
          name: entry.runtimeName ?? entry.key,
          description: null,
          detail: entry.detail ?? null,
          locationLabel: entry.locationLabel ?? null,
          originLabel: entry.originLabel ?? null,
          linkTo: null,
          readOnly: true,
          adapterEntry: entry,
        })),
    [companySkillKeys, skillSnapshot],
  );
  const desiredOnlyMissingSkills = useMemo(
    () => skillDraft.filter((key) => !companySkillByKey.has(key)),
    [companySkillByKey, skillDraft],
  );
  const skillApplicationLabel = useMemo(() => {
    switch (skillSnapshot?.mode) {
      case "persistent":
        return "Kept in the workspace";
      case "ephemeral":
        return "Applied when this teammate runs";
      case "unsupported":
        return "Tracked only";
      default:
        return "Unknown";
    }
  }, [skillSnapshot?.mode]);
  const unsupportedSkillMessage = useMemo(() => {
    if (skillSnapshot?.mode !== "unsupported") return null;
    if (agent.adapterType === "openclaw_gateway") {
      return "FounderOS cannot manage OpenClaw skills here. Visit your OpenClaw instance to manage this agent's skills.";
    }
    return "FounderOS cannot manage skills for this adapter yet. Manage them in the adapter directly.";
  }, [agent.adapterType, skillSnapshot?.mode]);
  const hasUnsavedChanges = !arraysEqual(skillDraft, lastSavedSkills);
  const saveStatusLabel = syncSkills.isPending
    ? "Saving changes..."
    : hasUnsavedChanges
      ? "Saving soon..."
      : null;

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/skills"
          className="text-sm font-medium text-foreground underline-offset-4 no-underline transition-colors hover:text-foreground/70 hover:underline"
        >
          View company skills library
        </Link>
        {saveStatusLabel ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {syncSkills.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>{saveStatusLabel}</span>
          </div>
        ) : null}
      </div>

      {skillSnapshot?.warnings.length ? (
        <div className="space-y-1 rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
          {skillSnapshot.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      {unsupportedSkillMessage ? (
        <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
          {unsupportedSkillMessage}
        </div>
      ) : null}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        <>
          {(() => {
            const renderSkillRow = (skill: SkillRow) => {
              const adapterEntry = skill.adapterEntry ?? adapterEntryByKey.get(skill.key);
              const required = Boolean(adapterEntry?.required);
              const rowClassName = cn(
                "flex items-start gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0",
                skill.readOnly ? "bg-muted/20" : "hover:bg-accent/20",
              );
              const body = (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="truncate font-medium">{skill.name}</span>
                    </div>
                    {skill.linkTo ? (
                      <Link
                        to={skill.linkTo}
                        className="shrink-0 text-xs text-muted-foreground no-underline hover:text-foreground"
                      >
                        View
                      </Link>
                    ) : null}
                  </div>
                  {skill.description && (
                    <MarkdownBody className="mt-1 text-xs text-muted-foreground prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      {skill.description}
                    </MarkdownBody>
                  )}
                  {skill.readOnly && skill.originLabel && (
                    <p className="mt-1 text-xs text-muted-foreground">{skill.originLabel}</p>
                  )}
                  {skill.readOnly && skill.locationLabel && (
                    <p className="mt-1 text-xs text-muted-foreground">Location: {skill.locationLabel}</p>
                  )}
                  {skill.detail && (
                    <p className="mt-1 text-xs text-muted-foreground">{skill.detail}</p>
                  )}
                </div>
              );

              if (skill.readOnly) {
                return (
                  <div key={skill.id} className={rowClassName}>
                    <span className="mt-1 h-2 w-2 rounded-full bg-muted-foreground/40" />
                    {body}
                  </div>
                );
              }

              const checked = required || skillDraft.includes(skill.key);
              const disabled = required || skillSnapshot?.mode === "unsupported";
              const checkbox = (
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? Array.from(new Set([...skillDraft, skill.key]))
                      : skillDraft.filter((value) => value !== skill.key);
                    setSkillDraft(next);
                  }}
                  className="mt-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                />
              );

              return (
                <label key={skill.id} className={rowClassName}>
                  {required && adapterEntry?.requiredReason ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{checkbox}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top">{adapterEntry.requiredReason}</TooltipContent>
                    </Tooltip>
                  ) : skillSnapshot?.mode === "unsupported" ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{checkbox}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {unsupportedSkillMessage ?? "Manage skills in the adapter directly."}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    checkbox
                  )}
                  {body}
                </label>
              );
            };

            if (optionalSkillRows.length === 0 && requiredSkillRows.length === 0 && unmanagedSkillRows.length === 0) {
              return (
                <section className="border-y border-border">
                  <div className="px-3 py-6 text-sm text-muted-foreground">
                    Import skills into the company library first, then attach them here.
                  </div>
                </section>
              );
            }

            return (
              <>
                {optionalSkillRows.length > 0 && (
                  <section className="border-y border-border">
                    {optionalSkillRows.map(renderSkillRow)}
                  </section>
                )}

                {requiredSkillRows.length > 0 && (
                  <section className="border-y border-border">
                    <div className="border-b border-border bg-muted/40 px-3 py-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Required by FounderOS
                      </span>
                    </div>
                    {requiredSkillRows.map(renderSkillRow)}
                  </section>
                )}

                {unmanagedSkillRows.length > 0 && (
                  <section className="border-y border-border">
                    <div
                      role="button"
                      tabIndex={0}
                      className="flex cursor-pointer items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 select-none"
                      onClick={() => setUnmanagedOpen((v) => !v)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setUnmanagedOpen((v) => !v); } }}
                    >
                      <span className="text-xs font-medium text-muted-foreground">
                        ({unmanagedSkillRows.length}) User-installed skills, not managed by FounderOS
                      </span>
                      {unmanagedOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                    </div>
                    {unmanagedOpen && unmanagedSkillRows.map(renderSkillRow)}
                  </section>
                )}
              </>
            );
          })()}

          {desiredOnlyMissingSkills.length > 0 && (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="font-medium">Requested skills missing from the company library</div>
              <div className="mt-1 text-xs">
                {desiredOnlyMissingSkills.join(", ")}
              </div>
            </div>
          )}

          <section className="border-t border-border pt-4">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                <span className="text-muted-foreground">Adapter</span>
                <span className="font-medium">{adapterLabels[agent.adapterType] ?? agent.adapterType}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                <span className="text-muted-foreground">Skills applied</span>
                <span>{skillApplicationLabel}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                <span className="text-muted-foreground">Selected skills</span>
                <span>{skillDraft.length}</span>
              </div>
            </div>

            {syncSkills.isError && (
              <p className="mt-3 text-xs text-destructive">
                {syncSkills.error instanceof Error ? syncSkills.error.message : "Failed to update skills"}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
