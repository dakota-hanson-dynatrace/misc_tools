import React from 'react';
import { functions } from '@dynatrace-sdk/app-utils';

interface StepResult {
  status: 'ok' | 'created' | 'would_create' | 'updated' | 'would_update' | 'failed';
}
interface SetupResponse {
  ok: boolean;
  steps: StepResult[];
}

/**
 * Whole-app "is Initial Setup done" signal, shared by the nav highlight and
 * the incomplete-setup banner. Always a dry run - this hook must never
 * mutate anything just by being rendered.
 *
 * `complete` is `null` while unknown (first load, or a request in flight) so
 * callers can distinguish "don't know yet" from "known incomplete" and avoid
 * flashing a banner before the real state is in.
 */
export function useSetupStatus() {
  const [complete, setComplete] = React.useState<boolean | null>(null);

  const check = React.useCallback(() => {
    functions
      .call('ncmSetup', { data: { dryRun: true } })
      .then((res) => res.json())
      .then((r: SetupResponse) => setComplete(r.ok && r.steps.every((s) => s.status === 'ok')))
      .catch(() => setComplete(null));
  }, []);

  React.useEffect(() => {
    check();
  }, [check]);

  return { complete, recheck: check };
}
