import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RateManagementDialog } from '@/features/time/components/rate-management-dialog';
import { IdentityBoundary } from '@/components/providers/identity-boundary';

/** Fixture-only DOM events; not a trusted browser-input or transport proof. */
const userEvent = {
  setup() {
    return {
      async click(element: HTMLElement) {
        await act(async () => { element.focus(); fireEvent.click(element); });
      },
      async clear(element: HTMLElement) {
        await act(async () => { element.focus(); fireEvent.change(element, { target: { value: '' } }); });
      },
      async type(element: HTMLElement, text: string) {
        if (!('value' in element)) throw Error('Fixture requires a public input value');
        await act(async () => { element.focus(); fireEvent.change(element, { target: { value: String(element.value) + text } }); });
      },
      async keyboard(spelling: string) {
        const key = spelling === '{Enter}' ? 'Enter' : spelling === '{Escape}' ? 'Escape' : undefined;
        if (!key) throw Error('Fixture supports only its owned Enter/Escape actions');
        await act(async () => {
          const element = document.activeElement;
          if (!(element instanceof HTMLElement)) throw Error('Fixture requires an active public element');
          const accepted = fireEvent.keyDown(element, { key });
          // fireEvent does not emulate browser keyboard default activation.
          // Use the public form API when the event did not prevent submission.
          if (key === 'Enter' && accepted) element.closest('form')?.requestSubmit();
          fireEvent.keyUp(element, { key });
        });
      },
    };
  },
};

type Callbacks = { onSuccess?: () => void; onError?: (error: Error) => void; onSettled?: () => void };
const owned = vi.hoisted(() => ({
  mutate: vi.fn(), rates: [] as Array<{ id: string; workspaceId: string; userId: string; rate: number; currency: string; effectiveFrom: string }>,
  pending: false, outcome: 'success' as 'success' | 'error' | 'pending',
  calls: [] as Array<{ workspaceId: string; variables: { userId: string; data: unknown }; callbacks: Callbacks }>,
  identity: { departures: 0, settled: true }, listeners: new Set<() => void>(),
}));
vi.mock('@/features/workspaces/api', () => ({ useWorkspaceMembers: () => ({ data: { data: [
  { id: 'member-mira', role: 'MEMBER', user: { id: 'user-mira', displayName: 'Mira', avatarUrl: null } },
  { id: 'member-jonas', role: 'MEMBER', user: { id: 'user-jonas', displayName: 'Jonas', avatarUrl: null } },
] } }) }));
vi.mock('@/features/time/api', () => ({
  useUserRates: () => ({ data: owned.rates }),
  useSetUserRate: (workspaceId: string) => ({ mutate: (variables: { userId: string; data: unknown }, callbacks: Callbacks) => owned.mutate(workspaceId, variables, callbacks), isPending: owned.pending }),
}));
vi.mock('@/lib/identity', () => ({ identityGeneration: () => owned.identity.departures, getIdentitySnapshot: () => owned.identity, subscribeIdentity: (callback: () => void) => { owned.listeners.add(callback); return () => owned.listeners.delete(callback); } }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-04T12:00:00Z') });
  owned.pending = false; owned.outcome = 'success'; owned.calls = []; owned.identity = { departures: 0, settled: true };
  owned.rates = [{ id: 'rate-now', workspaceId: 'workspace-one', userId: 'user-mira', rate: 10, currency: 'USD', effectiveFrom: '2026-11-03' }, { id: 'rate-future', workspaceId: 'workspace-one', userId: 'user-mira', rate: 99, currency: 'EUR', effectiveFrom: '2099-01-01' }];
  owned.mutate.mockReset(); owned.mutate.mockImplementation((workspaceId, variables, callbacks: Callbacks) => {
    owned.calls.push({ workspaceId, variables: structuredClone(variables), callbacks });
    if (owned.outcome === 'success') { callbacks?.onSuccess?.(); callbacks?.onSettled?.(); }
    if (owned.outcome === 'error') { callbacks?.onError?.(Error('owned save failure')); callbacks?.onSettled?.(); }
  });
});
afterEach(async () => { await act(async () => { cleanup(); await new Promise<void>(resolve => setTimeout(resolve, 0)); }); vi.useRealTimers(); vi.restoreAllMocks(); });
async function openMira(boundary = false) {
  const user = userEvent.setup(); const child = <RateManagementDialog workspaceId="workspace-one" />;
  const view = render(boundary ? <IdentityBoundary>{child}</IdentityBoundary> : child);
  await user.click(screen.getByRole('button', { name: 'Manage Rates' }));
  await user.click(screen.getByRole('button', { name: /\/hr$/ }));
  return { user, view };
}
function form(name = 'Mira') { return screen.getByRole('form', { name: new RegExp(name) }); }
function inputs(name = 'Mira') { const scope = within(form(name)); return { amount: scope.getByRole('spinbutton') as HTMLInputElement, currency: scope.getByRole('textbox', { name: /currency/i }) as HTMLInputElement, save: scope.getByRole('button', { name: /^Sav/ }), cancel: scope.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement }; }
it('currency-only lowercase edit saves the same numeric rate with explicit uppercase currency', async () => {
  const { user } = await openMira(); const { amount, currency, save } = inputs(); expect(amount.value).toBe('10'); await user.clear(currency); await user.type(currency, 'gbp'); await user.click(save);
  expect(owned.calls.map(x => ({ workspaceId: x.workspaceId, ...x.variables }))).toEqual([{ workspaceId: 'workspace-one', userId: 'user-mira', data: { rate: 10, currency: 'GBP' } }]);
});
it('moving between amount and currency never saves on blur; one explicit submit sends both', async () => {
  const { user } = await openMira(); const { amount, currency, save } = inputs(); await user.clear(amount); await user.type(amount, '11.25'); await user.click(currency); expect(owned.calls).toHaveLength(0); await user.clear(currency); await user.type(currency, 'ZZZ'); await user.click(save);
  expect(owned.calls).toHaveLength(1); expect(owned.calls[0].variables).toEqual({ userId: 'user-mira', data: { rate: 11.25, currency: 'ZZZ' } });
});
it('unchanged normalized currency and amount closes without mutation', async () => { const { user } = await openMira(); const { currency, save } = inputs(); await user.clear(currency); await user.type(currency, 'usd'); await user.click(save); expect(owned.calls).toHaveLength(0); expect(screen.queryByRole('form')).toBeNull(); });
for (const value of ['', 'EURO', 'US1', ' usd ']) it('invalid currency remains visible with no mutation: '+JSON.stringify(value), async () => {
  const { user } = await openMira(); const { currency, save } = inputs(); await user.clear(currency); if (value) await user.type(currency, value); await user.click(save); expect(owned.calls).toHaveLength(0); expect(currency.value).toBe(value); expect(screen.getByRole('alert').textContent).toMatch(/currency|three|3/i);
});
for (const value of ['', '-1', '1000000001', '1e309']) it('invalid amount is refused without closing the draft: '+JSON.stringify(value), async () => {
  const { user } = await openMira(); const { amount, save } = inputs(); fireEvent.change(amount, { target: { value } }); await user.click(save); expect(owned.calls).toHaveLength(0); expect(screen.getByRole('alert').textContent).toMatch(/rate|number/i); expect(screen.getByRole('form')).toBeTruthy();
});
it('cancel discards staged values and reopen uses the current stored values', async () => { const { user } = await openMira(); const { currency, cancel } = inputs(); await user.clear(currency); await user.type(currency, 'GBP'); await user.click(cancel); expect(owned.calls).toHaveLength(0); await user.click(screen.getByRole('button', { name: /\/hr$/ })); expect(inputs().currency.value).toBe('USD'); expect(inputs().amount.value).toBe('10'); });
it('Escape cancels the row without a write', async () => { const { user } = await openMira(); await user.clear(inputs().currency); await user.type(inputs().currency, 'GBP'); await user.keyboard('{Escape}'); expect(owned.calls).toHaveLength(0); expect(screen.queryByRole('form')).toBeNull(); });
it('closing and reopening the dialog discards an unsaved currency', async () => { const { user } = await openMira(); await user.clear(inputs().currency); await user.type(inputs().currency, 'GBP'); await user.click(screen.getByRole('button', { name: 'Close' })); expect(owned.calls).toHaveLength(0); await user.click(screen.getByRole('button', { name: 'Manage Rates' })); await user.click(screen.getByRole('button', { name: /\/hr$/ })); expect(inputs().currency.value).toBe('USD'); });
it('Enter submits once and a second pending submit cannot duplicate the write', async () => {
  owned.outcome = 'pending'; const { user, view } = await openMira(); await user.clear(inputs().currency); await user.type(inputs().currency, 'GBP'); await user.keyboard('{Enter}'); fireEvent.submit(form()); expect(owned.calls).toHaveLength(1);
  owned.pending = true; view.rerender(<RateManagementDialog workspaceId="workspace-one" />); expect(inputs().amount.disabled).toBe(true); expect(inputs().currency.disabled).toBe(true); expect(within(form()).getByRole('button', { name: /sav/i }).hasAttribute('disabled')).toBe(true); expect(inputs().cancel.disabled).toBe(true);
  await act(async () => { owned.calls[0].callbacks.onSuccess?.(); owned.calls[0].callbacks.onSettled?.(); });
});
it('save failure preserves both draft fields and allows an explicit retry', async () => {
  owned.outcome = 'error'; const { user } = await openMira(); await user.clear(inputs().amount); await user.type(inputs().amount, '12.5'); await user.clear(inputs().currency); await user.type(inputs().currency, 'GBP'); await user.click(inputs().save);
  expect(screen.getByRole('alert').textContent).toMatch(/save|rate|try/i); expect(inputs().amount.value).toBe('12.5'); expect(inputs().currency.value).toBe('GBP'); expect(owned.calls).toHaveLength(1);
  owned.outcome = 'success'; await user.click(inputs().save); expect(owned.calls).toHaveLength(2); expect(owned.calls[1].variables).toEqual(owned.calls[0].variables); expect(screen.queryByRole('form')).toBeNull();
});
it('currency-only update preserves an existing rate with more than two decimal places', async () => { owned.rates[0].rate = 3.333; const { user } = await openMira(); expect(inputs().amount.value).toBe('3.333'); await user.clear(inputs().currency); await user.type(inputs().currency, 'KWD'); await user.click(inputs().save); expect(owned.calls[0].variables).toEqual({ userId: 'user-mira', data: { rate: 3.333, currency: 'KWD' } }); });
it('separate member forms preserve their own targets and drafts', async () => { const { user } = await openMira(); await user.clear(inputs().currency); await user.type(inputs().currency, 'GBP'); await user.click(screen.getByRole('button', { name: /^Set rate/ })); await user.type(inputs('Jonas').amount, '20'); await user.click(inputs('Mira').save); expect(owned.calls.map(x => x.variables)).toEqual([{ userId: 'user-mira', data: { rate: 10, currency: 'GBP' } }]); expect(inputs('Jonas').amount.value).toBe('20'); });
it('workspace changes discard stale drafts even if a membership key is reused by a boundary adapter', async () => { const { user, view } = await openMira(); await user.clear(inputs().currency); await user.type(inputs().currency, 'GBP'); owned.rates = [{ ...owned.rates[0], workspaceId: 'workspace-two', rate: 20, currency: 'EUR' }]; view.rerender(<RateManagementDialog workspaceId="workspace-two" />); expect(screen.queryByRole('form')).toBeNull(); expect(owned.calls).toHaveLength(0); await user.click(screen.getByRole('button', { name: /\/hr$/ })); expect(inputs().currency.value).toBe('EUR'); });
it('the existing identity boundary drops open staged edits without a mutation', async () => { const { user } = await openMira(true); await user.clear(inputs().currency); await user.type(inputs().currency, 'GBP'); await act(async () => { owned.identity = { departures: 1, settled: true }; for (const listener of [...owned.listeners]) listener(); }); expect(owned.calls).toHaveLength(0); expect(screen.queryByRole('dialog')).toBeNull(); });

it('amount-only save omits unchanged currency after a stored-query refetch', async () => {
  const { user, view } = await openMira();
  await user.clear(inputs().amount); await user.type(inputs().amount, '12.5');
  owned.rates = [{ ...owned.rates[0], rate: 99, currency: 'GBP' }, owned.rates[1]];
  view.rerender(<RateManagementDialog workspaceId="workspace-one" />);
  expect(inputs().amount.value).toBe('12.5'); expect(inputs().currency.value).toBe('USD');
  await user.click(inputs().save);
  expect(owned.calls.map(x => x.variables)).toEqual([{ userId: 'user-mira', data: { rate: 12.5 } }]);
});
it('a currency-only draft remains based on its captured opening rate after a query refetch', async () => {
  const { user, view } = await openMira();
  await user.clear(inputs().currency); await user.type(inputs().currency, 'KWD');
  owned.rates = [{ ...owned.rates[0], rate: 99, currency: 'GBP' }, owned.rates[1]];
  view.rerender(<RateManagementDialog workspaceId="workspace-one" />);
  expect(inputs().amount.value).toBe('10'); expect(inputs().currency.value).toBe('KWD');
  await user.click(inputs().save);
  expect(owned.calls.map(x => x.variables)).toEqual([{ userId: 'user-mira', data: { rate: 10, currency: 'KWD' } }]);
});
