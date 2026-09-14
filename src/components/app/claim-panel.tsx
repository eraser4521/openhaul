'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { relativeTime, money } from '@/lib/utils/format';
import { ClaimForm, type ClaimableVehicle } from '@/components/app/claim-form';

/**
 * Claims on a load, and the way in to filing one.
 *
 * Lives on the load rather than behind a global "new claim" button because a
 * claim is always about a shipment, and starting from the load means the
 * vehicle, the inspections and the paperwork are already attached.
 */

export interface LoadClaim {
  id: string;
  number: string;
  status: string;
  claimantName: string;
  demandAmountCents: number | null;
  filedAt: Date;
}

export interface ClaimPanelProps {
  loadId: string;
  loadNumber: string;
  vehicles: ClaimableVehicle[];
  claims: LoadClaim[];
  today: string;
  deliveredOn: string | null;
  canFile: boolean;
}

const TONE: Record<string, 'neutral' | 'brand' | 'ok' | 'warn' | 'info'> = {
  filed: 'warn',
  acknowledged: 'info',
  investigating: 'info',
  offered: 'brand',
  paid: 'ok',
  declined: 'neutral',
  withdrawn: 'neutral',
};

export function ClaimPanel({
  loadId,
  loadNumber,
  vehicles,
  claims,
  today,
  deliveredOn,
  canFile,
}: ClaimPanelProps) {
  const [filing, setFiling] = useState(false);

  if (filing) {
    return (
      <ClaimForm
        loadId={loadId}
        loadNumber={loadNumber}
        vehicles={vehicles}
        today={today}
        deliveredOn={deliveredOn}
        onCancel={() => setFiling(false)}
      />
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ShieldAlert className="size-4 text-ink-muted" aria-hidden />
          Claims
        </h2>
        {canFile && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setFiling(true)}>
            File a claim
          </Button>
        )}
      </div>

      {claims.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">
          No claims on this load. Filing one puts the records on legal hold so retention cannot age
          them out while it is open.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {claims.map((claim) => (
            <li key={claim.id}>
              <Link
                href={`/claims/${claim.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-raised"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-ink">{claim.number}</span>
                    <Badge tone={TONE[claim.status] ?? 'neutral'} size="sm">
                      {claim.status.replace(/_/g, ' ')}
                    </Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {claim.claimantName} · received {relativeTime(claim.filedAt)}
                  </p>
                </div>
                <span className="text-sm text-ink tabular-nums">
                  {claim.demandAmountCents !== null ? money(claim.demandAmountCents) : '—'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
