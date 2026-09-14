'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { verifyChainAction, type ChainCheckResult } from './actions';

/**
 * Runs a full chain recomputation on demand.
 *
 * Deliberately not run on page load: verification reads and re-hashes every
 * entry, which is cheap for a carrier and pointless to repeat on every visit.
 */
export function VerifyChainButton() {
  const [result, setResult] = useState<ChainCheckResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      setResult(await verifyChainAction());
    } catch {
      setResult({ ok: false, message: 'The check could not be run. Try again.' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <Button variant="secondary" size="sm" onClick={run} loading={running}>
        <ShieldCheck aria-hidden />
        Verify the chain
      </Button>

      <AnimatePresence>
        {result && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed ${
              result.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'
            }`}
          >
            {result.ok ? (
              <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden />
            ) : (
              <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            )}
            {result.message}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
