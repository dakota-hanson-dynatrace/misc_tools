import { diffLines as jsDiffLines } from 'diff';

export type DiffKind = 'add' | 'del' | 'same';
export interface DiffRow { kind: DiffKind; text: string }

/**
 * Line diff for display. Wraps the `diff` package rather than hand-rolling
 * Myers - this is a solved problem and a wrong implementation would silently
 * misreport config changes.
 *
 * Context is collapsed to CONTEXT lines either side of a change: a router
 * config is thousands of lines and rendering all of it buries the two that
 * actually changed.
 */
const CONTEXT = 3;

export function diffLines(before: string, after: string): DiffRow[] {
  const parts = jsDiffLines(before ?? '', after ?? '');
  const all: DiffRow[] = [];

  for (const part of parts) {
    const kind: DiffKind = part.added ? 'add' : part.removed ? 'del' : 'same';
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const text of lines) all.push({ kind, text });
  }

  // Keep only lines near a change.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((r, i) => {
    if (r.kind === 'same') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(all.length - 1, i + CONTEXT); j++) {
      keep[j] = true;
    }
  });

  if (!keep.some(Boolean)) return [];

  const out: DiffRow[] = [];
  let skipping = false;
  all.forEach((r, i) => {
    if (keep[i]) {
      out.push(r);
      skipping = false;
    } else if (!skipping) {
      out.push({ kind: 'same', text: '...' });
      skipping = true;
    }
  });
  return out;
}


/**
 * Line counts only, for the promotion record.
 *
 * Separate from diffLines() on purpose: that one collapses context for display,
 * so counting its output would undercount. This counts every changed line.
 *
 * The caller is responsible for not handing this pathological input - Myers is
 * O(ND) and two large, wholly-different texts will burn a time budget. See
 * MAX_DIFF_BYTES in ncmPromote.
 */
export function countLineChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of jsDiffLines(before ?? '', after ?? '')) {
    if (!part.added && !part.removed) continue;
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (part.added) added += lines.length;
    else removed += lines.length;
  }
  return { added, removed };
}
