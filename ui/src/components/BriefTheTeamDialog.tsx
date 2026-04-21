import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@founderos/shared";
import { issuesApi } from "../api/issues";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

interface BriefTheTeamDialogProps {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  companyId: string | null;
}

interface MentionDropdownState {
  isOpen: boolean;
  searchText: string;
  selectedIndex: number;
  matchedAgents: Agent[];
  cursorPos: number;
}

const MENTION_REGEX = /@([A-Za-z][A-Za-z0-9-_]*)/g;

export function BriefTheTeamDialog({
  open,
  onClose,
  agents,
  companyId,
}: BriefTheTeamDialogProps) {
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<"medium" | "high" | "urgent">("medium");
  const [mentionDropdown, setMentionDropdown] = useState<MentionDropdownState>({
    isOpen: false,
    searchText: "",
    selectedIndex: 0,
    matchedAgents: [],
    cursorPos: 0,
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  // Extract unique mentions from body text
  const extractMentions = useCallback((text: string): string[] => {
    const matches: string[] = [];
    let match;
    const regex = new RegExp(MENTION_REGEX);
    while ((match = regex.exec(text)) !== null) {
      const mentionName = match[1];
      if (!matches.includes(mentionName)) {
        matches.push(mentionName);
      }
    }
    return matches;
  }, []);

  // Get unique agents that are mentioned (case-insensitive matching)
  const mentionedAgents = extractMentions(body)
    .map((name) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase()))
    .filter((a): a is Agent => a !== undefined);

  // Count unique mentions (min 1)
  const mentionCount = mentionedAgents.length > 0 ? mentionedAgents.length : 1;

  const createIssueMutation = useMutation({
    mutationFn: async (payload: {
      title: string;
      description: string;
      priority: "medium" | "high" | "urgent";
      assigneeAgentId?: string;
    }) => {
      if (!companyId) throw new Error("No company selected");
      return issuesApi.create(companyId, payload);
    },
    onSuccess: () => {
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      }
    },
  });

  const handleSend = async () => {
    if (!body.trim()) {
      pushToast({
        title: "Empty brief",
        body: "Write something before sending.",
        tone: "warn",
      });
      return;
    }

    // Generate title from first line of body, truncated
    const firstLine = body.split("\n")[0].trim();
    const title =
      firstLine.length > 0
        ? firstLine.slice(0, 100)
        : `Founder brief · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

    try {
      if (mentionedAgents.length === 0) {
        // Create a single issue with no assignee
        await createIssueMutation.mutateAsync({
          title,
          description: body,
          priority,
        });
      } else {
        // Create separate issues for each mentioned agent
        await Promise.all(
          mentionedAgents.map((agent) =>
            createIssueMutation.mutateAsync({
              title,
              description: body,
              priority,
              assigneeAgentId: agent.id,
            })
          )
        );
      }

      // Success feedback
      pushToast({
        title: "Brief sent",
        body: `Briefed ${mentionCount} teammate${mentionCount === 1 ? "" : "s"}.`,
        tone: "success",
      });

      // Reset and close
      setBody("");
      setPriority("medium");
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send brief";
      pushToast({
        title: "Error",
        body: message,
        tone: "error",
      });
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setBody(newText);

    // Check if we're at an @ mention
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = newText.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex !== -1) {
      const charAfterAt = newText[lastAtIndex + 1];
      // Only show dropdown if @ is followed by a letter or is at end
      if (!charAfterAt || /[A-Za-z]/.test(charAfterAt)) {
        const searchText = textBeforeCursor.slice(lastAtIndex + 1);
        const matched = agents.filter((a) =>
          a.name.toLowerCase().startsWith(searchText.toLowerCase())
        );

        setMentionDropdown({
          isOpen: matched.length > 0,
          searchText,
          selectedIndex: 0,
          matchedAgents: matched.slice(0, 6),
          cursorPos: lastAtIndex,
        });
      } else {
        setMentionDropdown((prev) => ({ ...prev, isOpen: false }));
      }
    } else {
      setMentionDropdown((prev) => ({ ...prev, isOpen: false }));
    }
  };

  const selectMentionedAgent = (agent: Agent) => {
    if (!textareaRef.current) return;

    const cursorPos = mentionDropdown.cursorPos;
    const beforeAt = body.slice(0, cursorPos);
    const afterSearch = body.slice(cursorPos + 1 + mentionDropdown.searchText.length);

    const newBody = `${beforeAt}@${agent.name} ${afterSearch}`;
    setBody(newBody);

    // Close dropdown
    setMentionDropdown((prev) => ({ ...prev, isOpen: false }));

    // Focus and position cursor after inserted mention
    setTimeout(() => {
      if (textareaRef.current) {
        const newCursorPos = cursorPos + agent.name.length + 2; // @ + name + space
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  };

  const removeMention = (agentName: string) => {
    // Remove the @name pattern from body (including trailing space)
    const newBody = body.replace(new RegExp(`@${agentName}\\s*`, "g"), "");
    setBody(newBody);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionDropdown.isOpen) return;

    const { matchedAgents, selectedIndex } = mentionDropdown;
    if (matchedAgents.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setMentionDropdown((prev) => ({
          ...prev,
          selectedIndex: (prev.selectedIndex + 1) % prev.matchedAgents.length,
        }));
        break;
      case "ArrowUp":
        e.preventDefault();
        setMentionDropdown((prev) => ({
          ...prev,
          selectedIndex: (prev.selectedIndex - 1 + prev.matchedAgents.length) % prev.matchedAgents.length,
        }));
        break;
      case "Enter":
        e.preventDefault();
        selectMentionedAgent(matchedAgents[selectedIndex]);
        break;
      case "Escape":
        e.preventDefault();
        setMentionDropdown((prev) => ({ ...prev, isOpen: false }));
        break;
    }
  };

  const isLoading = createIssueMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">Brief the team</DialogTitle>
          <DialogDescription>
            Mention teammates with @. They get a high-priority issue on their next shift.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Textarea */}
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={body}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              placeholder="What's the focus? Who needs to move?"
              className={cn(
                "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/50",
                "resize-none overflow-hidden"
              )}
              rows={6}
              style={{
                minHeight: "6rem",
                maxHeight: "14rem",
              }}
            />

            {/* @mention dropdown */}
            {mentionDropdown.isOpen && mentionDropdown.matchedAgents.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-full rounded-lg border border-border bg-background shadow-lg z-10">
                <ul className="max-h-40 overflow-y-auto">
                  {mentionDropdown.matchedAgents.map((agent, idx) => (
                    <li
                      key={agent.id}
                      className={cn(
                        "px-3 py-2 text-sm cursor-pointer",
                        idx === mentionDropdown.selectedIndex
                          ? "bg-[var(--brand)]/10 text-foreground"
                          : "hover:bg-muted text-foreground/80"
                      )}
                      onClick={() => selectMentionedAgent(agent)}
                    >
                      @{agent.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Mention pills */}
          {mentionedAgents.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {mentionedAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[13px] text-foreground"
                >
                  @{agent.name}
                  <button
                    type="button"
                    onClick={() => removeMention(agent.name)}
                    className="ml-0.5 text-foreground/60 hover:text-foreground"
                    aria-label={`Remove mention of ${agent.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Priority selector */}
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-muted-foreground">Priority:</span>
            <div className="flex gap-2">
              {(["medium", "high", "urgent"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors",
                    priority === p
                      ? "bg-[var(--brand)] text-white"
                      : "border border-border text-foreground/70 hover:text-foreground hover:border-foreground/30"
                  )}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Meta row */}
          <div className="text-[12px] text-muted-foreground">
            This will create{" "}
            <span className="font-medium text-foreground tabular-nums">{mentionCount}</span>{" "}
            issue{mentionCount === 1 ? "" : "s"}. Each mentioned teammate gets their own.
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!body.trim() || isLoading}
            className="bg-[var(--brand)] hover:bg-[var(--brand)]/90"
          >
            {isLoading ? "Sending..." : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
