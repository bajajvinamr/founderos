import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Mail, Trash2, ShieldCheck } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { authApi } from "../api/auth";
import {
  instanceInvitesApi,
  type CreateInviteResponse,
  type InstanceInviteRole,
} from "../api/instanceInvites";

const INVITES_KEY = ["instance", "invites"] as const;
const MEMBERS_KEY = ["instance", "members"] as const;

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    const d = new Date(value);
    return d.toLocaleString();
  } catch {
    return value;
  }
}

export function InstanceAdminMembers() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InstanceInviteRole>("instance_member");
  const [lastCreated, setLastCreated] = useState<CreateInviteResponse | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Members" }]);
  }, [setBreadcrumbs]);

  const sessionQuery = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => authApi.getSession(),
  });

  const membersQuery = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: () => instanceInvitesApi.listMembers(),
  });

  const invitesQuery = useQuery({
    queryKey: INVITES_KEY,
    queryFn: () => instanceInvitesApi.list(),
  });

  const createInviteMutation = useMutation({
    mutationFn: (body: { email: string; role: InstanceInviteRole }) =>
      instanceInvitesApi.create(body),
    onSuccess: async (response) => {
      setActionError(null);
      setLastCreated(response);
      setInviteEmail("");
      setInviteRole("instance_member");
      await queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to create invite.");
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (id: string) => instanceInvitesApi.revoke(id),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to revoke invite.");
    },
  });

  // Gate: only instance admins can see the create/revoke controls. Anyone
  // authenticated can still view the members + invites list (parity with
  // the existing /instance/settings/general page).
  // The server ultimately enforces admin-only for POST/DELETE — this is
  // purely a UX gate that hides the buttons for non-admins.
  const currentUserId = sessionQuery.data?.user?.id ?? null;
  const currentUserIsAdmin = Boolean(
    currentUserId &&
      membersQuery.data?.some(
        (m) => m.userId === currentUserId && m.role === "instance_admin",
      ),
  );

  const handleSubmit = () => {
    const email = inviteEmail.trim();
    if (!email) {
      setActionError("Email is required.");
      return;
    }
    createInviteMutation.mutate({ email, role: inviteRole });
  };

  const handleClose = () => {
    setDialogOpen(false);
    setLastCreated(null);
    setActionError(null);
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Members</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Current instance members and pending email invites. Invites auto-grant
          the right role as soon as the teammate completes signup.
        </p>
      </div>

      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Current members</h2>
            <p className="text-sm text-muted-foreground">
              People with an instance role — admins can invite others and change
              instance-wide settings.
            </p>
          </div>
          {currentUserIsAdmin ? (
            <Button
              size="sm"
              onClick={() => {
                setDialogOpen(true);
                setLastCreated(null);
                setActionError(null);
              }}
            >
              <Mail className="size-4" />
              Invite teammate
            </Button>
          ) : null}
        </div>
        <div className="mt-4 divide-y divide-border">
          {membersQuery.isLoading ? (
            <p className="py-3 text-sm text-muted-foreground">Loading members...</p>
          ) : membersQuery.error ? (
            <p className="py-3 text-sm text-destructive">
              {membersQuery.error instanceof Error
                ? membersQuery.error.message
                : "Failed to load members."}
            </p>
          ) : (membersQuery.data ?? []).length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No members yet.</p>
          ) : (
            (membersQuery.data ?? []).map((member) => (
              <div
                key={member.userId}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {member.name ?? member.email ?? member.userId}
                    </span>
                    {member.role === "instance_admin" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-accent/40 px-2 py-0.5 text-xs text-muted-foreground">
                        <ShieldCheck className="size-3" />
                        Admin
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                        Member
                      </span>
                    )}
                  </div>
                  {member.email ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {member.email}
                    </div>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  Since {formatDate(member.roleCreatedAt)}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold">Pending invites</h2>
          <p className="text-sm text-muted-foreground">
            Email invites that haven&apos;t been accepted yet. Revoking deletes
            the invite; the teammate will need a new link to join.
          </p>
        </div>
        <div className="mt-4 divide-y divide-border">
          {invitesQuery.isLoading ? (
            <p className="py-3 text-sm text-muted-foreground">Loading invites...</p>
          ) : invitesQuery.error ? (
            <p className="py-3 text-sm text-destructive">
              {invitesQuery.error instanceof Error
                ? invitesQuery.error.message
                : "Failed to load invites."}
            </p>
          ) : (invitesQuery.data ?? []).length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No pending invites.</p>
          ) : (
            (invitesQuery.data ?? []).map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{invite.email}</div>
                  <div className="text-xs text-muted-foreground">
                    Role:{" "}
                    {invite.role === "instance_admin" ? "Admin" : "Member"} • Expires{" "}
                    {formatDate(invite.expiresAt)}
                  </div>
                </div>
                {currentUserIsAdmin ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revokeInviteMutation.isPending}
                    onClick={() => revokeInviteMutation.mutate(invite.id)}
                  >
                    <Trash2 className="size-4" />
                    Revoke
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : handleClose())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a teammate</DialogTitle>
            <DialogDescription>
              We&apos;ll send them a signup link. When they finish signing up the
              right role is granted automatically.
            </DialogDescription>
          </DialogHeader>

          {lastCreated ? (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-accent/20 px-3 py-2 text-sm">
                Invite sent to <strong>{lastCreated.email}</strong>.
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Signup link (share if email didn&apos;t arrive)
                </label>
                <Input
                  readOnly
                  value={lastCreated.signupUrl}
                  onClick={(event) => {
                    (event.target as HTMLInputElement).select();
                  }}
                />
              </div>
              <DialogFooter>
                <Button onClick={handleClose}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Email</label>
                <Input
                  type="email"
                  autoFocus
                  placeholder="teammate@example.com"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Role</label>
                <Select
                  value={inviteRole}
                  onValueChange={(value) => setInviteRole(value as InstanceInviteRole)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="instance_member">Member</SelectItem>
                    <SelectItem value="instance_admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={createInviteMutation.isPending || !inviteEmail.trim()}
                >
                  {createInviteMutation.isPending ? "Sending..." : "Send invite"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
