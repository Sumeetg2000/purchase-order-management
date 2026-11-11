import {
  CONTACT_NAME_MAX,
  CONTACT_PHONE_MAX,
  EMAIL_MAX_LENGTH,
  PAYMENT_TERM_TYPES,
  VENDOR_NAME_MAX,
  type PaymentTermType,
} from '@po/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type SyntheticEvent } from 'react';
import {
  FieldError,
  Input,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  TextField,
} from 'react-aria-components';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/app-client';
import type { paths } from '../../api/schema';
import { failureMessage, fieldFailure, submit, type ApiFailure } from '../../api/submit';
import { messageFor } from '../../errors/messages';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { PAYMENT_TERM_LABELS } from './payment-terms';
import { VENDORS_KEY, vendorKey } from './queries';
import css from './vendors.module.css';

const styles = classes(css, 'form', 'field', 'fieldError', 'radios', 'alert');
const controls = classes(controlsCss, 'primary');

/** The form's text, field by field; numbers stay text until sent. */
interface Draft {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  type: PaymentTermType;
  netDays: string;
  advancePercent: string;
}

type TextKey = Exclude<keyof Draft, 'type'>;

/** Each field's error message, if it has one. */
type FieldErrors = Partial<Record<TextKey, string | undefined>>;

type CreateVendorBody = NonNullable<
  paths['/vendors']['post']['requestBody']
>['content']['application/json'];

const EMPTY: Draft = {
  name: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  type: 'NET',
  netDays: '',
  advancePercent: '',
};

/** Where the API reports each field's error (ADR-0007 paths). */
const FIELD_PATHS = {
  name: 'body.name',
  contactName: 'body.contactName',
  contactEmail: 'body.contactEmail',
  contactPhone: 'body.contactPhone',
  netDays: 'body.paymentTerms.netDays',
  advancePercent: 'body.paymentTerms.advancePercent',
} as const satisfies Record<TextKey, string>;

const TEXT_KEYS = Object.keys(FIELD_PATHS) as TextKey[];

/** Whole numbers are sent as numbers; anything else as typed, for the API to name. */
function numberOrText(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function bodyOf(draft: Draft): CreateVendorBody {
  const netDays = numberOrText(draft.netDays);
  const advancePercent = numberOrText(draft.advancePercent);
  const paymentTerms =
    draft.type === 'NET'
      ? { type: draft.type, netDays }
      : draft.type === 'ADVANCE'
        ? { type: draft.type }
        : { type: draft.type, advancePercent, netDays };
  // The API checks every field and names any it refuses; the form doesn't repeat that.
  return {
    name: draft.name,
    contactName: draft.contactName,
    contactEmail: draft.contactEmail,
    // A blank phone is no phone: null, never "" (research R6).
    contactPhone: draft.contactPhone.trim() === '' ? null : draft.contactPhone,
    paymentTerms,
  } as CreateVendorBody;
}

/** Each field's own error from a failure; a duplicate name is the name field's. */
function fieldErrorsOf(failure: ApiFailure): FieldErrors {
  const errors: FieldErrors = {};
  for (const key of TEXT_KEYS) {
    const message = fieldFailure(failure, FIELD_PATHS[key]);
    if (message) errors[key] = message;
  }
  if (failure.problem.code === 'DUPLICATE_VENDOR_NAME') {
    errors.name = messageFor('DUPLICATE_VENDOR_NAME').message;
  }
  return errors;
}

/** Add a vendor, Buyers only (specs/003-vendors/contracts/ui.md). Saves with no dialog. */
export function NewVendor() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [existing, setExisting] = useState<{ id: string; name: string }>();
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const dirty = TEXT_KEYS.some((key) => draft[key].trim() !== '') || draft.type !== EMPTY.type;
  const guard = useUnsavedChangesGuard(dirty);

  function change(key: TextKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    // An edited field's earlier error no longer applies.
    setErrors((current) => ({ ...current, [key]: undefined }));
    if (key === 'name') setExisting(undefined);
  }

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setFailure(undefined);
    setErrors({});
    setExisting(undefined);
    const outcome = await submit(() => api.POST('/vendors', { body: bodyOf(draft) }));
    sending.current = false;
    setPending(false);
    if (!outcome.ok) {
      const found = fieldErrorsOf(outcome);
      setErrors(found);
      setExisting(outcome.problem.existingVendor);
      if (Object.keys(found).length === 0) setFailure(failureMessage(outcome));
      return;
    }
    guard.release();
    queryClient.setQueryData(vendorKey(outcome.data.id), outcome.data);
    void queryClient.invalidateQueries({ queryKey: [...VENDORS_KEY, 'list'] });
    void navigate(`/vendors/${outcome.data.id}`);
  }

  const text = (key: TextKey, label: string, options: TextOptions = {}) => (
    <TextField
      className={styles.field}
      value={draft[key]}
      onChange={(value) => {
        change(key, value);
      }}
      isInvalid={errors[key] !== undefined}
      isRequired={options.required ?? true}
      {...(options.maxLength === undefined ? {} : { maxLength: options.maxLength })}
      {...(options.type === undefined ? {} : { type: options.type })}
    >
      <Label>{label}</Label>
      <Input
        {...(options.autoComplete === undefined ? {} : { autoComplete: options.autoComplete })}
        {...(options.inputMode === undefined ? {} : { inputMode: options.inputMode })}
      />
      <FieldError className={styles.fieldError}>{errors[key]}</FieldError>
      {key === 'name' && existing && (
        <Link to={`/vendors/${existing.id}`}>Open {existing.name}</Link>
      )}
    </TextField>
  );

  return (
    <>
      <title>Add vendor · Purchase Orders</title>
      <h1>Add vendor</h1>
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        {text('name', 'Vendor name', { maxLength: VENDOR_NAME_MAX, autoComplete: 'off' })}
        {text('contactName', 'Contact name', { maxLength: CONTACT_NAME_MAX, autoComplete: 'off' })}
        {text('contactEmail', 'Contact email', {
          maxLength: EMAIL_MAX_LENGTH,
          type: 'email',
          autoComplete: 'off',
        })}
        {text('contactPhone', 'Contact phone (optional)', {
          required: false,
          maxLength: CONTACT_PHONE_MAX,
          type: 'tel',
          autoComplete: 'off',
        })}
        <RadioGroup
          className={styles.radios}
          value={draft.type}
          orientation="horizontal"
          onChange={(value) => {
            const type = PAYMENT_TERM_TYPES.find((known) => known === value);
            if (type) setDraft((current) => ({ ...current, type }));
          }}
        >
          <Label>Payment terms</Label>
          {PAYMENT_TERM_TYPES.map((type) => (
            <RadioField key={type} value={type}>
              <RadioButton>{PAYMENT_TERM_LABELS[type]}</RadioButton>
            </RadioField>
          ))}
        </RadioGroup>
        {draft.type === 'PARTIAL_ADVANCE' &&
          text('advancePercent', 'Advance percent', { inputMode: 'numeric' })}
        {draft.type !== 'ADVANCE' && text('netDays', 'Net days', { inputMode: 'numeric' })}
        {failure && (
          <p role="alert" className={styles.alert}>
            {failure}
          </p>
        )}
        <div>
          <button type="submit" className={controls.primary} disabled={pending}>
            Add vendor
          </button>
        </div>
      </form>
      {guard.dialog}
    </>
  );
}

interface TextOptions {
  required?: boolean;
  maxLength?: number;
  type?: 'email' | 'tel';
  autoComplete?: string;
  inputMode?: 'numeric';
}

export function EditVendor() {
  return (
    <>
      <title>Edit vendor · Purchase Orders</title>
      <h1>Edit vendor</h1>
    </>
  );
}
