import { inArray } from 'drizzle-orm';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { can } from '@/lib/auth/capabilities';
import { loads as loadsTable, OPEN_LOAD_STATUSES } from '@/lib/db/schema';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { ExpenseCapture } from '@/components/app/expense-capture';
import { ExpenseList } from '@/components/app/expense-list';
import { driverForUser, visibleTo } from '@/lib/expenses/record';
import { reviewState } from '@/lib/expenses/categories';

export const metadata = { title: 'Expenses' };

export default async function ExpensesPage() {
  const { session, db } = await requireSessionOrRedirect();

  const canApprove = can(session.role, 'expense.approve');
  const canRecord = can(session.role, 'expense.write');

  const [rows, openLoads, drivers, allLoads, driver] = await Promise.all([
    visibleTo(db, { userId: session.userId, seesEveryone: canApprove }),
    db.select('loads', inArray(loadsTable.status, OPEN_LOAD_STATUSES)),
    db.select('drivers'),
    db.select('loads'),
    driverForUser(db, session.userId),
  ]);

  const loadNumbers = new Map(allLoads.map((load) => [load.id, load.number]));
  const driverNames = new Map(drivers.map((row) => [row.id, row.displayName]));

  return (
    <>
      <PageHeader
        title="Expenses"
        description={
          canApprove
            ? 'What drivers have paid for out of pocket, and what comes back to them.'
            : 'What you have paid for out of pocket on the road.'
        }
      />

      <PageBody className="space-y-6">
        {canRecord && (
          <ExpenseCapture
            loads={openLoads.map((load) => ({ id: load.id, number: load.number }))}
          />
        )}

        {/*
          * Shown to anyone recording without a driver record, approver or not.
          * A settlement finds expenses by driver, so one recorded against
          * nobody is a figure that will sit here forever — and an owner who
          * also drives is exactly the person likely to hit it.
          */}
        {canRecord && !driver && (
          <p className="rounded-lg bg-warn-soft px-4 py-3 text-xs leading-relaxed text-warn">
            Your account is not linked to a driver record, so anything you record here is kept but
            will never reach a settlement.{' '}
            {canApprove
              ? 'Add yourself on the drivers screen and link this account to it.'
              : 'Ask an owner to add you on the drivers screen.'}
          </p>
        )}

        <ExpenseList
          canApprove={canApprove}
          showDriver={canApprove}
          expenses={rows.map((expense) => ({
            id: expense.id,
            category: expense.category,
            amountCents: expense.amountCents,
            incurredAt: expense.incurredAt.toISOString(),
            vendor: expense.vendor,
            notes: expense.notes,
            loadNumber: expense.loadId ? (loadNumbers.get(expense.loadId) ?? null) : null,
            driverName: expense.driverId ? (driverNames.get(expense.driverId) ?? null) : null,
            hasReceipt: expense.receiptStorageKey !== null,
            review: reviewState(expense),
            reimbursedAt: expense.reimbursedAt?.toISOString() ?? null,
          }))}
        />
      </PageBody>
    </>
  );
}
