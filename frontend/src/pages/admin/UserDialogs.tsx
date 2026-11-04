import { etagFor } from '@po/contracts';
import { api } from '../../api/app-client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorState } from '../../components/ErrorState';
import { Loading } from '../../components/Loading';
import { problemFrom } from '../../errors/problem';
import { useDialogAction } from './dialog-action';
import { openOrdersSentence } from './open-orders';
import { useUserDetail } from './queries';

// Deactivate, reactivate and send a reset (ADR-0018's admin dialogs).

interface Target {
  id: string;
  name: string;
  email: string;
}

export interface UserDialogProps {
  user: Target;
  onDone: (message: string) => void;
  onClose: () => void;
}

/** Deactivate or reactivate: a versioned change of isActive. */
export function ActivationDialog({
  user,
  isActive,
  onDone,
  onClose,
}: UserDialogProps & { isActive: boolean }) {
  const detail = useUserDetail(user.id);
  const action = useDialogAction();
  const current = detail.data;

  const confirm = async () => {
    if (!current) return;
    await action.run(
      () =>
        api.PATCH('/admin/users/{id}', {
          params: { path: { id: user.id }, header: { 'If-Match': etagFor(current.version) } },
          body: { isActive },
        }),
      () => {
        onDone(isActive ? `${user.name} is active again.` : `${user.name} is deactivated.`);
      },
    );
  };

  return (
    <ConfirmDialog
      title={isActive ? `Reactivate ${user.name}?` : `Deactivate ${user.name}?`}
      confirmLabel={isActive ? 'Reactivate user' : 'Deactivate user'}
      tone={isActive ? 'default' : 'danger'}
      confirmDisabled={!current}
      onConfirm={confirm}
      onClose={onClose}
      error={action.error}
      errorActions={
        action.error?.code === 'VERSION_CONFLICT'
          ? [
              {
                label: 'Reload',
                onPress: () => {
                  action.clearError();
                  void detail.refetch();
                },
              },
            ]
          : []
      }
    >
      {detail.isError ? (
        <ErrorState problem={problemFrom(detail.error)} />
      ) : !current ? (
        <Loading label="Loading the user" />
      ) : isActive ? (
        <p>They&apos;ll be able to log in again.</p>
      ) : (
        <>
          <p>{openOrdersSentence(current)}</p>
          <p>They&apos;ll be logged out everywhere and can&apos;t log in.</p>
        </>
      )}
    </ConfirmDialog>
  );
}

/** Send password reset: the standard email; admins never see the link. */
export function ResetDialog({ user, onDone, onClose }: UserDialogProps) {
  const action = useDialogAction();
  const confirm = () =>
    action.run(
      () => api.POST('/admin/users/{id}/reset-password', { params: { path: { id: user.id } } }),
      () => {
        onDone(`Password reset email sent to ${user.name}.`);
      },
    );
  return (
    <ConfirmDialog
      title={`Send a password reset to ${user.name}?`}
      confirmLabel="Send reset email"
      onConfirm={confirm}
      onClose={onClose}
      error={action.error}
    >
      <p>
        We&apos;ll email a reset link to {user.email}. Their current password keeps working until
        they complete the reset.
      </p>
    </ConfirmDialog>
  );
}
