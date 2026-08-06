import { useEffect, useMemo } from 'react';
import { useDql } from '@dynatrace-sdk/react-hooks';

export interface HostInfo {
  entityName: string;
  entityId: string;
}

const QUERY = 'fetch dt.entity.host | fieldsAdd ipAddress, entity.detected_name | limit 1000';

export function useHostCorrelation(): { hostMap: Map<string, HostInfo>; isLoading: boolean; error: Error | null } {
  const { data, isLoading, error, refetch } = useDql({ query: QUERY });

  useEffect(() => {
    const id = setInterval(() => void refetch(), 60_000);
    return () => clearInterval(id);
  }, []); // refetch is stable from the SDK

  const hostMap = useMemo(() => {
    const map = new Map<string, HostInfo>();
    if (!data?.records) return map;

    for (const record of data.records) {
      const entityId = record['id'] as string | undefined;
      const entityName =
        (record['entity.detected_name'] as string | undefined) ??
        (record['entity.name'] as string | undefined) ??
        '';
      const ips = record['ipAddress'] as string[] | undefined;

      if (entityId && ips) {
        for (const ip of ips) {
          map.set(ip, { entityName, entityId });
        }
      }
    }

    return map;
  }, [data]);

  return { hostMap, isLoading, error: error ?? null };
}
