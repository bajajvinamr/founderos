import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

// P3 Wave 1 — updated shortcut sheet for the Ask-First shell.
// Source: 01-shell-revised.md §10.4 + 05-design-system.md §5.
//
// Two new entries surface the AskBar reflex (⌘K, ⌘+Enter); the Inbox
// shortcut block survives because the Inbox surface still exists for now
// (Wave 2 collapses it into Today).
//
// RV-005 MED: the previous "Go to (chrome)" section documented g+t / g+w /
// g+m / g+l / g+s chords that are NOT yet wired in `useKeyboardShortcuts`.
// Documenting unimplemented shortcuts is a trust regression — removed here
// until the chord handler lands. The `g <letter>` chord block from
// 05-design-system §5.1 was already deferred to P4 by F-18, so this is
// the resolved interim version.
const sections: ShortcutSection[] = [
  {
    title: "AskBar",
    shortcuts: [
      { keys: ["⌘", "K"], label: "Open AskBar from anywhere" },
      { keys: ["Esc"], label: "Close AskBar (typed query preserved)" },
      { keys: ["⌘", "Enter"], label: "Ask the team this — submit typed query" },
      { keys: ["↑"], label: "Previous suggestion" },
      { keys: ["↓"], label: "Next suggestion" },
    ],
  },
  {
    title: "Inbox",
    shortcuts: [
      { keys: ["j"], label: "Move down" },
      { keys: ["k"], label: "Move up" },
      { keys: ["Enter"], label: "Open selected item" },
      { keys: ["a"], label: "Archive item" },
      { keys: ["y"], label: "Archive item" },
      { keys: ["r"], label: "Mark as read" },
      { keys: ["U"], label: "Mark as unread" },
    ],
  },
  {
    title: "Issue detail",
    shortcuts: [
      { keys: ["y"], label: "Quick-archive back to inbox" },
      { keys: ["g", "i"], label: "Go to inbox" },
      { keys: ["g", "c"], label: "Focus comment composer" },
    ],
  },
  {
    title: "Global",
    shortcuts: [
      { keys: ["/"], label: "Search current page or quick search" },
      { keys: ["c"], label: "New issue" },
      { keys: ["["], label: "Toggle sidebar" },
      { keys: ["]"], label: "Toggle panel" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
    ],
  },
];

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-[0_1px_0_1px_hsl(var(--border))]">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="divide-y divide-border border-t border-border">
          {sections.map((section) => (
            <div key={section.title} className="px-5 py-3">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h3>
              <div className="space-y-1.5">
                {section.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.label + shortcut.keys.join()}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-sm text-foreground/90">{shortcut.label}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <span key={key} className="flex items-center gap-1">
                          {i > 0 && <span className="text-xs text-muted-foreground">then</span>}
                          <KeyCap>{key}</KeyCap>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">
            Press <KeyCap>Esc</KeyCap> to close &middot; Shortcuts are disabled in text fields
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
