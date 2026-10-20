"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import {
  ADMIN_ROLES,
  adminRoleLabels,
  type AdminRole,
  type AdminUser,
} from "@/lib/admin";
import { changeUserRole } from "./actions";

/**
 * The user list and its role selector. Every change goes through a confirmation
 * dialog, and the server action checks the admin role again. The current admin
 * never gets a selector, which makes the self role rule visible before a click.
 */
export function AdminUsers({
  users: initialUsers,
  currentUserId,
}: {
  users: AdminUser[] | null;
  currentUserId: string;
}) {
  const [users, setUsers] = useState<AdminUser[]>(initialUsers ?? []);
  const [selected, setSelected] = useState<Record<string, AdminRole>>(() =>
    Object.fromEntries(
      (initialUsers ?? []).map((user) => [user.userId, user.role]),
    ),
  );
  const [confirming, setConfirming] = useState<{
    user: AdminUser;
    role: AdminRole;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const dialogErrorId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirming && !dialog.open) dialog.showModal();
    if (!confirming && dialog.open) dialog.close();
  }, [confirming]);

  if (initialUsers === null) {
    return (
      <Card className="max-w-3xl">
        <CardTitle>Users</CardTitle>
        <p className="mt-4 text-body-sm text-error">
          The user list could not be read. Reload the page in a moment.
        </p>
      </Card>
    );
  }

  function openConfirm(user: AdminUser) {
    const role = selected[user.userId] ?? user.role;
    if (role === user.role) return;
    setDialogError(null);
    setConfirming({ user, role });
  }

  async function confirmChange() {
    if (!confirming || pending) return;

    setPending(true);
    setDialogError(null);
    setMessage(null);
    setError(null);

    const result = await changeUserRole({
      userId: confirming.user.userId,
      role: confirming.role,
    });
    setPending(false);

    if (result.status === "error") {
      setDialogError(result.message);
      return;
    }

    if (result.users) {
      setUsers(result.users);
      setSelected(
        Object.fromEntries(
          result.users.map((user) => [user.userId, user.role]),
        ),
      );
    } else {
      setUsers((current) =>
        current.map((user) =>
          user.userId === confirming.user.userId
            ? { ...user, role: confirming.role }
            : user,
        ),
      );
      setSelected((current) => ({
        ...current,
        [confirming.user.userId]: confirming.role,
      }));
    }

    setConfirming(null);
    setMessage(result.message);
  }

  return (
    <Card className="max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <CardTitle>Users</CardTitle>
        <span className="text-caption tabular-nums text-mute">
          {users.length} {users.length === 1 ? "account" : "accounts"}
        </span>
      </div>
      <p className="mt-1 text-body-sm text-body">
        Every account with its role and contribution count. A role change
        applies immediately. You cannot change your own role.
      </p>

      <div aria-live="polite">
        {message ? (
          <p role="status" className="mt-3 text-body-sm text-body">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-body-sm text-error">
            {error}
          </p>
        ) : null}
      </div>

      {users.length === 0 ? (
        <p className="mt-4 text-body-sm text-mute">No accounts found.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {users.map((user) => {
            const isSelf = user.userId === currentUserId;
            const choice = selected[user.userId] ?? user.role;
            const name = user.displayName ?? user.email;

            return (
              <li
                key={user.userId}
                className="rounded-md bg-surface-2/60 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-body-sm font-medium text-ink">
                      {name}
                      {isSelf ? (
                        <span className="ml-2 text-caption font-normal text-mute">
                          This is you
                        </span>
                      ) : null}
                    </p>
                    {user.displayName ? (
                      <p className="break-all text-caption text-mute">
                        {user.email}
                      </p>
                    ) : null}
                    <p className="mt-1 text-caption text-mute">
                      Joined {user.createdLabel} · {user.totalCount}{" "}
                      {user.totalCount === 1 ? "contribution" : "contributions"}
                      {" · "}
                      Consent{" "}
                      {user.consentAt
                        ? `recorded ${user.consentLabel}`
                        : "not recorded"}
                    </p>
                    <p className="mt-1 text-caption text-mute">
                      {user.instructionCount} instructions,{" "}
                      {user.conversationCount} conversations, {user.textCount}{" "}
                      text, {user.ocrPageCount} OCR pages
                    </p>
                  </div>
                  <Badge tone={user.role === "admin" ? "accent" : "neutral"}>
                    {adminRoleLabels[user.role]}
                  </Badge>
                </div>

                <div className="mt-3 flex flex-wrap items-end gap-2">
                  {isSelf ? (
                    <p className="text-body-sm text-mute">
                      You cannot change your own role. Ask another admin.
                    </p>
                  ) : (
                    <>
                      <label className="flex min-w-[10rem] flex-col gap-1 text-caption text-mute">
                        Role for {name}
                        <select
                          value={choice}
                          onChange={(event) => {
                            const role = event.target.value as AdminRole;
                            setSelected((current) => ({
                              ...current,
                              [user.userId]: role,
                            }));
                            setMessage(null);
                            setError(null);
                          }}
                          className="min-h-11 rounded-md bg-surface px-3 text-body-sm text-ink shadow-elev-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {ADMIN_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {adminRoleLabels[role]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-11"
                        onClick={() => openConfirm(user)}
                        disabled={pending || choice === user.role}
                      >
                        Save role
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={dialogError ? dialogErrorId : undefined}
        onCancel={(event) => {
          event.preventDefault();
          if (!pending) setConfirming(null);
        }}
        onClose={() => {
          if (confirming && !pending) setConfirming(null);
        }}
        className="fixed inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-md rounded-lg bg-surface p-6 text-ink shadow-elev-5 backdrop:bg-black/50"
      >
        {confirming ? (
          <>
            <h2 id={titleId} className="text-display-sm font-semibold">
              Change role
            </h2>
            <p className="mt-2 text-body-sm text-body">
              Change{" "}
              <span className="font-medium text-ink">
                {confirming.user.displayName ?? confirming.user.email}
              </span>{" "}
              from {adminRoleLabels[confirming.user.role]} to{" "}
              {adminRoleLabels[confirming.role]}? This applies immediately.
            </p>
            {dialogError ? (
              <p
                id={dialogErrorId}
                role="alert"
                className="mt-3 text-caption text-error"
              >
                {dialogError}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                className="h-11"
                onClick={() => setConfirming(null)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="h-11"
                onClick={() => void confirmChange()}
                disabled={pending}
              >
                {pending ? "Saving" : "Change role"}
              </Button>
            </div>
          </>
        ) : null}
      </dialog>
    </Card>
  );
}
