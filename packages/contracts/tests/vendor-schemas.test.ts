import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ADVANCE_PERCENT_MAX,
  ADVANCE_PERCENT_MIN,
  CONTACT_NAME_MAX,
  CONTACT_PHONE_MAX,
  EMAIL_MAX_LENGTH,
  NET_DAYS_MAX,
  normaliseVendorName,
  PAGE_SIZE_DEFAULT,
  PAYMENT_TERM_TYPES,
  paymentTerms,
  VENDOR_NAME_MAX,
  VENDOR_STATUS_FILTER_DEFAULT,
  VENDOR_STATUS_FILTERS,
  VENDOR_STATUSES,
  vendor,
  vendorBody,
  vendorHistoryItem,
  vendorListQuery,
} from '../src/index.js';

// The slice 2 vendor schemas (contracts/api.md), reviewed before any service code.

/**
 * Each failure as "path CODE", with the field code the API's mapper gives it (ADR-0007):
 * missing → REQUIRED, extra key → UNKNOWN_FIELD, string length → TOO_SHORT/TOO_LONG,
 * number bounds → OUT_OF_RANGE, anything else → INVALID_FORMAT. Like the API, one per
 * field: the first reported.
 */
function failures(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value, { reportInput: true });
  if (result.success) return [];
  const all = result.error.issues.flatMap((issue) => {
    const path = issue.path.map(String).join('.');
    switch (issue.code) {
      case 'unrecognized_keys':
        return issue.keys.map((key) => `${path ? `${path}.` : ''}${key} UNKNOWN_FIELD`);
      case 'invalid_type':
        return [`${path} ${issue.input === undefined ? 'REQUIRED' : 'INVALID_FORMAT'}`];
      case 'too_small':
        return [`${path} ${issue.origin === 'string' ? 'TOO_SHORT' : 'OUT_OF_RANGE'}`];
      case 'too_big':
        return [`${path} ${issue.origin === 'string' ? 'TOO_LONG' : 'OUT_OF_RANGE'}`];
      default:
        return [`${path} INVALID_FORMAT`];
    }
  });
  const seen = new Set<string>();
  return all.filter((failure) => {
    const path = failure.slice(0, failure.lastIndexOf(' '));
    return !seen.has(path) && seen.add(path);
  });
}

const body = {
  name: 'Acme Supplies',
  contactName: 'Ravi Shah',
  contactEmail: 'ravi@acme.example',
  contactPhone: '+91 (22) 4000-1000',
  paymentTerms: { type: 'NET', netDays: 30 },
};

describe('[FR-VEN-01] vendor constants', () => {
  it('[FR-VEN-01] holds the reviewed numbers and lists', () => {
    expect({
      VENDOR_NAME_MAX,
      CONTACT_NAME_MAX,
      CONTACT_PHONE_MAX,
      NET_DAYS_MAX,
      ADVANCE_PERCENT_MIN,
      ADVANCE_PERCENT_MAX,
    }).toEqual({
      VENDOR_NAME_MAX: 200,
      CONTACT_NAME_MAX: 200,
      CONTACT_PHONE_MAX: 30,
      NET_DAYS_MAX: 180,
      ADVANCE_PERCENT_MIN: 1,
      ADVANCE_PERCENT_MAX: 99,
    });
    expect([...PAYMENT_TERM_TYPES]).toEqual(['NET', 'ADVANCE', 'PARTIAL_ADVANCE']);
    expect([...VENDOR_STATUSES]).toEqual(['ACTIVE', 'INACTIVE']);
    expect([...VENDOR_STATUS_FILTERS]).toEqual(['ACTIVE', 'INACTIVE', 'ALL']);
    expect(VENDOR_STATUS_FILTER_DEFAULT).toBe('ACTIVE');
  });

  it('[FR-VEN-01] normaliseVendorName: NFC, whitespace runs to one space, trimmed, lower-case', () => {
    expect(normaliseVendorName('  ACME \t  Supplies Ltd ')).toBe('acme supplies ltd');
    expect(normaliseVendorName('\tAcme')).toBe('acme');
    expect(normaliseVendorName('Café Co')).toBe('café co');
    expect(normaliseVendorName('50%_off')).toBe('50%_off');
  });
});

describe('[FR-VEN-01] vendorBody', () => {
  it('[FR-VEN-01] accepts each payment-term variant at its bounds', () => {
    const variants = [
      { type: 'NET', netDays: 0 },
      { type: 'NET', netDays: NET_DAYS_MAX },
      { type: 'ADVANCE' },
      { type: 'PARTIAL_ADVANCE', advancePercent: ADVANCE_PERCENT_MIN, netDays: 0 },
      { type: 'PARTIAL_ADVANCE', advancePercent: ADVANCE_PERCENT_MAX, netDays: NET_DAYS_MAX },
    ];
    for (const terms of variants) {
      expect(failures(vendorBody, { ...body, paymentTerms: terms }), terms.type).toEqual([]);
    }
  });

  it('[NFR-VAL-01] refuses out-of-range, cross-variant and non-integer payment terms', () => {
    const cases: [unknown, string[]][] = [
      [{ type: 'NET', netDays: -1 }, ['paymentTerms.netDays OUT_OF_RANGE']],
      [{ type: 'NET', netDays: NET_DAYS_MAX + 1 }, ['paymentTerms.netDays OUT_OF_RANGE']],
      [{ type: 'NET', netDays: 30.5 }, ['paymentTerms.netDays INVALID_FORMAT']],
      [{ type: 'NET', netDays: '30' }, ['paymentTerms.netDays INVALID_FORMAT']],
      [{ type: 'NET' }, ['paymentTerms.netDays REQUIRED']],
      [
        { type: 'NET', netDays: 30, advancePercent: 10 },
        ['paymentTerms.advancePercent UNKNOWN_FIELD'],
      ],
      [{ type: 'ADVANCE', netDays: 0 }, ['paymentTerms.netDays UNKNOWN_FIELD']],
      [
        { type: 'PARTIAL_ADVANCE', advancePercent: 0, netDays: 30 },
        ['paymentTerms.advancePercent OUT_OF_RANGE'],
      ],
      [
        { type: 'PARTIAL_ADVANCE', advancePercent: 100, netDays: 30 },
        ['paymentTerms.advancePercent OUT_OF_RANGE'],
      ],
      [{ type: 'PARTIAL_ADVANCE', netDays: 30 }, ['paymentTerms.advancePercent REQUIRED']],
    ];
    for (const [terms, expected] of cases) {
      expect(failures(vendorBody, { ...body, paymentTerms: terms }), JSON.stringify(terms)).toEqual(
        expected,
      );
    }
    expect(failures(vendorBody, { ...body, paymentTerms: { type: 'COD' } })).toEqual([
      'paymentTerms.type INVALID_FORMAT',
    ]);
  });

  it('[FR-VEN-01] contactPhone: omitted or null accepted, "" too short, letters invalid, 31 characters too long', () => {
    const withoutPhone: Partial<typeof body> = { ...body };
    delete withoutPhone.contactPhone;
    expect(failures(vendorBody, withoutPhone)).toEqual([]);
    expect(vendorBody.parse(withoutPhone).contactPhone).toBeUndefined();
    expect(vendorBody.parse({ ...body, contactPhone: null }).contactPhone).toBeNull();
    expect(failures(vendorBody, { ...body, contactPhone: '' })).toEqual(['contactPhone TOO_SHORT']);
    expect(failures(vendorBody, { ...body, contactPhone: '   ' })).toEqual([
      'contactPhone TOO_SHORT',
    ]);
    expect(failures(vendorBody, { ...body, contactPhone: 'call me' })).toEqual([
      'contactPhone INVALID_FORMAT',
    ]);
    expect(failures(vendorBody, { ...body, contactPhone: '+() -' })).toEqual([
      'contactPhone INVALID_FORMAT',
    ]);
    expect(
      failures(vendorBody, { ...body, contactPhone: '1'.repeat(CONTACT_PHONE_MAX + 1) }),
    ).toEqual(['contactPhone TOO_LONG']);
    expect(vendorBody.parse({ ...body, contactPhone: ' 022 4000 ' }).contactPhone).toBe('022 4000');
  });

  it('[FR-VEN-01] trims names, lower-cases the contact email and bounds their lengths', () => {
    const parsed = vendorBody.parse({
      ...body,
      name: '  Acme Supplies ',
      contactName: ' Ravi ',
      contactEmail: 'Ravi@Acme.Example',
    });
    expect(parsed).toMatchObject({
      name: 'Acme Supplies',
      contactName: 'Ravi',
      contactEmail: 'ravi@acme.example',
    });
    expect(failures(vendorBody, { ...body, name: '  ' })).toEqual(['name TOO_SHORT']);
    expect(failures(vendorBody, { ...body, name: 'n'.repeat(VENDOR_NAME_MAX + 1) })).toEqual([
      'name TOO_LONG',
    ]);
    expect(
      failures(vendorBody, { ...body, contactName: 'c'.repeat(CONTACT_NAME_MAX + 1) }),
    ).toEqual(['contactName TOO_LONG']);
    expect(failures(vendorBody, { ...body, contactEmail: 'not an email' })).toEqual([
      'contactEmail INVALID_FORMAT',
    ]);
    const long = `${'r'.repeat(EMAIL_MAX_LENGTH)}@acme.example`;
    expect(failures(vendorBody, { ...body, contactEmail: long })).not.toEqual([]);
  });

  it('[NFR-VAL-01] requires name, contactName, contactEmail and paymentTerms', () => {
    expect(failures(vendorBody, {}).sort()).toEqual(
      [
        'name REQUIRED',
        'contactName REQUIRED',
        'contactEmail REQUIRED',
        'paymentTerms REQUIRED',
      ].sort(),
    );
  });

  it('[NFR-VAL-01] system-assigned fields are unknown fields', () => {
    for (const field of ['id', 'status', 'version', 'createdAt', 'updatedAt', 'nameKey']) {
      expect(failures(vendorBody, { ...body, [field]: 'x' }), field).toEqual([
        `${field} UNKNOWN_FIELD`,
      ]);
    }
  });
});

describe('[FR-VEN-01] vendor list query and responses', () => {
  it('[FR-VEN-01] the list defaults to ACTIVE and the first page', () => {
    expect(vendorListQuery.parse({})).toEqual({
      page: 1,
      pageSize: PAGE_SIZE_DEFAULT,
      status: 'ACTIVE',
    });
    expect(vendorListQuery.parse({ status: 'ALL', q: ' acm ' })).toMatchObject({
      status: 'ALL',
      q: 'acm',
    });
  });

  it('[NFR-VAL-01] refuses a lower-case status, an empty q and unknown filters', () => {
    expect(failures(vendorListQuery, { status: 'active' })).toEqual(['status INVALID_FORMAT']);
    expect(failures(vendorListQuery, { q: '  ' })).toEqual(['q TOO_SHORT']);
    expect(failures(vendorListQuery, { q: 'q'.repeat(VENDOR_NAME_MAX + 1) })).toEqual([
      'q TOO_LONG',
    ]);
    expect(failures(vendorListQuery, { sort: 'name' })).toEqual(['sort UNKNOWN_FIELD']);
  });

  it('[FR-VEN-01] a vendor carries its payment terms as the union and its phone as string or null', () => {
    const item = {
      id: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f',
      name: 'Acme Supplies',
      contactName: 'Ravi Shah',
      contactEmail: 'ravi@acme.example',
      contactPhone: null,
      paymentTerms: { type: 'ADVANCE' },
      status: 'INACTIVE',
      deactivatedAt: '2026-11-06T10:00:00.000Z',
      version: 2,
      createdAt: '2026-11-06T09:00:00.000Z',
      updatedAt: '2026-11-06T10:00:00.000Z',
    };
    expect(failures(vendor, item)).toEqual([]);
    expect(failures(vendor, { ...item, nameKey: 'acme supplies' })).toEqual([
      'nameKey UNKNOWN_FIELD',
    ]);
    expect(failures(paymentTerms, { type: 'ADVANCE' })).toEqual([]);

    const snapshot = {
      name: item.name,
      contactName: item.contactName,
      contactEmail: item.contactEmail,
      contactPhone: null,
      paymentTerms: item.paymentTerms,
      status: 'ACTIVE',
    };
    expect(
      failures(vendorHistoryItem, {
        id: '42',
        action: 'VENDOR_CREATED',
        occurredAt: item.createdAt,
        actor: { type: 'USER', name: 'Asha', email: 'asha@example.local', role: 'BUYER' },
        before: null,
        after: snapshot,
      }),
    ).toEqual([]);
  });
});
