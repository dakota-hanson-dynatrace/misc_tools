import { useDql } from '@dynatrace-sdk/react-hooks';
import { configChunks } from '../queries';
import { reassemble, type ChunkRow } from '../utils/records';

/**
 * Fetch one stored config and reassemble it, verifying integrity.
 *
 * `content` truncates SILENTLY at 512 KiB in Grail, so a config that arrives
 * short looks completely normal. Everything here funnels through reassemble(),
 * which checks chunk count and total byte length - and callers MUST honour
 * `problem` rather than rendering `content` regardless. Showing a truncated
 * config as though it were real is the worst outcome this app can produce:
 * it would make a diff look like a change that never happened.
 */
export function useConfig(captureId: string | undefined) {
  const { data, error, isLoading } = useDql(
    captureId ? { query: configChunks(captureId) } : { query: 'fetch logs | limit 0' }
  );

  if (!captureId) return { content: '', problem: undefined, isLoading: false, error: undefined };

  const raw = (data?.records ?? []) as Array<Record<string, unknown>>;
  if (isLoading || error) {
    return { content: '', problem: undefined, isLoading, error };
  }

  const rows: ChunkRow[] = raw.map((r) => ({
    content: typeof r.content === 'string' ? r.content : '',
    'ncm.chunk.index': Number(r['ncm.chunk.index'] ?? 0),
    'ncm.chunk.total': Number(r['ncm.chunk.total'] ?? 1),
    'ncm.content.bytes': Number(r['ncm.content.bytes'] ?? 0),
  }));

  const result = reassemble(rows);
  return {
    content: result.content,
    problem: result.ok ? undefined : result.problem,
    isLoading: false,
    error: undefined,
  };
}
