import React from 'react';
import { functions } from '@dynatrace-sdk/app-utils';
import { Select } from '@dynatrace/strato-components/forms';

// Picker over existing Credential Vault entries, backed by ncmCredentials'
// listEntries action. Used anywhere a device needs to reference an existing
// per-device credential: Manage's device list and Coverage's Auto add.

interface VaultEntrySummary {
  id: string;
  name: string;
}
interface ListEntriesResponse {
  ok: boolean;
  message?: string;
  entries?: VaultEntrySummary[];
}

export const VaultEntryPicker = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) => {
  const [entries, setEntries] = React.useState<VaultEntrySummary[] | null>(null);

  React.useEffect(() => {
    functions
      .call('ncmCredentials', { data: { action: 'listEntries' } })
      .then((res) => res.json())
      .then((r: ListEntriesResponse) => setEntries(r.ok ? (r.entries ?? []) : []))
      .catch(() => setEntries([]));
  }, []);

  // A device can already point at an id that no longer shows up in the list
  // (entry deleted, wrong scope/type, created outside this app's convention).
  // Never let the picker silently drop that reference - render it as a
  // synthetic option instead of blanking the select out.
  const options = React.useMemo(() => {
    const list = entries ?? [];
    if (value && !list.some((e) => e.id === value)) {
      return [{ id: value, name: `${value} (not in list)` }, ...list];
    }
    return list;
  }, [entries, value]);

  return (
    <Select value={value || null} onChange={(v) => onChange(v ?? '')}>
      <Select.Content>
        {options.map((e) => (
          <Select.Option key={e.id} value={e.id}>
            {e.name}
          </Select.Option>
        ))}
      </Select.Content>
    </Select>
  );
};
