/**
 * D78: auto-issue asks before it arms.
 *
 * The OFF-to-ON flip of the auto-issue checkbox is the one edit in this form whose consequence is
 * unattended posting from the next tick, so it alone is gated behind the shared confirm idiom. This
 * suite pins the whole of that law: the confirm appears ONLY on that transition (never on ON-to-OFF
 * and never on an unrelated edit), cancelling leaves auto-issue off, and confirming enables it.
 *
 * COPY IS ASSERTED THROUGH THE CATALOGUE, never as a literal typed here, so the D56 du-register
 * conversion and every future rewording keep this suite green without edits.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { RecurringEditor, EMPTY_EDITOR, nextFirstOfMonth, type EditorValue } from './RecurringEditor';
import de from './messages.de-CH.json';

const MESSAGES = de.recurring.form;

function renderEditor(initial: EditorValue = EMPTY_EDITOR, onSave: (v: EditorValue) => void = () => {}) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <RecurringEditor
          contacts={[{ id: 'contact_1', name: 'Muster AG' }]}
          taxCodes={[]}
          initial={initial}
          busy={false}
          errorCode={null}
          onSave={onSave}
          onCancel={() => {}}
        />
      </MemoryRouter>
    </I18nProvider>,
  );
}

/**
 * Open a migrated shared <Select> combobox by its accessible name and click the option carrying
 * `value`. The listbox is portaled to <body>, so the option is read from `screen` by its data-value.
 */
async function chooseOption(comboName: string, value: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: comboName }));
  const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === value);
  if (option === undefined) throw new Error(`no option with data-value ${value}`);
  await userEvent.click(option);
}

describe('RecurringEditor: the auto-issue confirm (D78)', () => {
  it('the OFF-to-ON flip asks first, naming the consequence, and the box stays off meanwhile', async () => {
    renderEditor();
    const box = screen.getByRole('checkbox', { name: MESSAGES.autoIssue });
    expect(box).not.toBeChecked();

    await userEvent.click(box);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(MESSAGES.autoIssueConfirm);
    // Not armed yet: the value moves only when the person confirms.
    expect(box).not.toBeChecked();
  });

  it('cancelling leaves auto-issue off and closes the dialog', async () => {
    renderEditor();
    const box = screen.getByRole('checkbox', { name: MESSAGES.autoIssue });
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: MESSAGES.autoIssueConfirmCancel }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(box).not.toBeChecked();
  });

  it('confirming enables auto-issue, and the enabled value reaches the save payload', async () => {
    let saved: EditorValue | null = null;
    // The anchor date is a required field: without it the native form validation swallows the
    // submit and the assertion would measure that, not the confirm.
    renderEditor({ ...EMPTY_EDITOR, anchorDate: '2026-08-01' }, (v) => {
      saved = v;
    });
    const box = screen.getByRole('checkbox', { name: MESSAGES.autoIssue });
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: MESSAGES.autoIssueConfirmAction }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(box).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: MESSAGES.save }));
    expect(saved).not.toBeNull();
    expect((saved as unknown as EditorValue).autoIssue).toBe(true);
  });

  it('ON-to-OFF flips immediately, with no dialog', async () => {
    renderEditor({ ...EMPTY_EDITOR, autoIssue: true });
    const box = screen.getByRole('checkbox', { name: MESSAGES.autoIssue });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(box).not.toBeChecked();
  });

  it('unrelated edits never raise the dialog, whether auto-issue is on or off', async () => {
    const { unmount } = renderEditor({ ...EMPTY_EDITOR, autoIssue: true });
    await userEvent.type(screen.getByLabelText(MESSAGES.name), 'Retainer');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    unmount();

    renderEditor();
    await userEvent.type(screen.getByLabelText(MESSAGES.name), 'Retainer');
    await chooseOption(MESSAGES.customer, 'contact_1');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('turning it back ON after a cancel asks again: the confirm guards the transition, not the first click', async () => {
    renderEditor();
    const box = screen.getByRole('checkbox', { name: MESSAGES.autoIssue });
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: MESSAGES.autoIssueConfirmCancel }));
    await userEvent.click(box);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(MESSAGES.autoIssueConfirm);
  });
});

describe('RecurringEditor defaults (F-03, J3.8)', () => {
  it('nextFirstOfMonth is the first of the following month, across a year end, in LOCAL time', () => {
    // Local-time constructions: the person's clock, not UTC's (critic F10).
    expect(nextFirstOfMonth(new Date(2026, 8, 5, 10, 0))).toBe('2026-10-01');
    expect(nextFirstOfMonth(new Date(2026, 11, 31, 23, 0))).toBe('2027-01-01');
    expect(nextFirstOfMonth(new Date(2026, 0, 1, 0, 0))).toBe('2026-02-01');
    // 00:30 local on the first: under Europe/Zurich the UTC month is still December, and the UTC
    // version answered 2026-01-01 (today). Run this file with TZ=Europe/Zurich to see it bite.
    expect(nextFirstOfMonth(new Date(2026, 0, 1, 0, 30))).toBe('2026-02-01');
  });

  it('a blank position description shows the series name as its placeholder', async () => {
    renderEditor({ ...EMPTY_EDITOR, anchorDate: '2026-10-01' }, () => undefined);
    await userEvent.type(screen.getByLabelText(MESSAGES.name), 'Retainer Hotel Blaustern');
    expect(screen.getByLabelText(MESSAGES.lineDescription)).toHaveAttribute('placeholder', 'Retainer Hotel Blaustern');
  });
});
