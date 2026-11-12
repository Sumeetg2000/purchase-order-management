import {
  ASSIGNABLE_ROLE_SETS,
  etagFor,
  ROLE,
  USER_STATUS,
  type AssignableRoleSet,
  type UserRole,
} from '@po/contracts';
import { useState } from 'react';
import { Label, RadioButton, RadioField, RadioGroup } from 'react-aria-components';
import { api } from '../../api/app-client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorState } from '../../components/ErrorState';
import { Loading } from '../../components/Loading';
import { failureFrom } from '../../errors/problem';
import { roleSetLabel } from '../../format/roles';
import { classes } from '../../styles/classes';
import css from './admin.module.css';
import { useDialogAction } from './dialog-action';
import { useActiveApproverCount, useUserDetail } from './queries';

const styles = classes(css, 'radios', 'warning');

const keyOf = (set: readonly string[]) => set.join('+');

export interface RoleDialogProps {
  user: { id: string; name: string };
  onDone: (message: string) => void;
  onClose: () => void;
}

/**
 * Change role (ADR-0018): old → new, the user's open orders, and that their sessions end;
 * assigning a first role says it resolves the access request, and making the only
 * Approver a Buyer too warns that their own orders above the threshold can't be approved.
 */
export function RoleDialog({ user, onDone, onClose }: RoleDialogProps) {
  const detail = useUserDetail(user.id);
  const current = detail.data;
  const [choice, setChoice] = useState<AssignableRoleSet>();
  const action = useDialogAction();
  const approverNow =
    current?.roles.includes(ROLE.APPROVER) === true && current.status === USER_STATUS.ACTIVE;
  const approvers = useActiveApproverCount(approverNow);
  const changed = current && choice && keyOf(choice) !== keyOf(current.roles);
  const chosen: readonly UserRole[] = choice ?? [];
  const onlyApproverWarning =
    chosen.includes(ROLE.BUYER) &&
    chosen.includes(ROLE.APPROVER) &&
    approverNow &&
    approvers.data === 1;

  const confirm = async () => {
    if (!current || !choice) return;
    await action.run(
      () =>
        api.PATCH('/admin/users/{id}', {
          params: { path: { id: user.id }, header: { 'If-Match': etagFor(current.version) } },
          body: { roles: [...choice] },
        }),
      () => {
        onDone(`${user.name}'s role is now ${roleSetLabel(choice)}.`);
      },
    );
  };

  return (
    <ConfirmDialog
      title={`Change role for ${user.name}?`}
      confirmLabel="Change role"
      confirmDisabled={!changed}
      onConfirm={confirm}
      onClose={onClose}
      error={action.error}
      errorActions={
        action.error?.problem.code === 'VERSION_CONFLICT'
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
        <ErrorState {...failureFrom(detail.error)} />
      ) : !current ? (
        <Loading label="Loading the user" />
      ) : (
        <>
          <RadioGroup
            className={styles.radios}
            value={choice ? keyOf(choice) : null}
            onChange={(value) => {
              setChoice(ASSIGNABLE_ROLE_SETS.find((set) => keyOf(set) === value));
            }}
          >
            <Label>New role</Label>
            {ASSIGNABLE_ROLE_SETS.map((set) => (
              <RadioField key={keyOf(set)} value={keyOf(set)}>
                <RadioButton>{roleSetLabel(set)}</RadioButton>
              </RadioField>
            ))}
          </RadioGroup>
          {changed && (
            <p>
              {roleSetLabel(current.roles)} → {roleSetLabel(choice)}
            </p>
          )}
          <p>Their sessions will end and they&apos;ll need to log in again.</p>
          {current.roles.length === 0 && <p>This also resolves their access request.</p>}
          {onlyApproverWarning && (
            <p className={styles.warning}>
              {user.name} is the only Approver, so their own orders above the approval threshold
              can&apos;t be approved.
            </p>
          )}
        </>
      )}
    </ConfirmDialog>
  );
}
