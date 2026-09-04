import React from 'react';
import { Flex, Surface } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Code } from '@dynatrace/strato-components/typography';

/**
 * Renders a query failure instead of swallowing it.
 *
 * A swallowed error looks identical to "no data": an empty table with
 * loading:false. That is precisely the MISSING_BUCKET_PERMISSIONS failure mode
 * documented in AGENTS.md, where a query succeeds but silently returns zero
 * records - so every view that runs a query must surface this.
 */
export const QueryError = ({ what, error }: { what: string; error: unknown }) => {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  return (
    <Surface padding={16}>
      <Flex flexDirection="column" gap={8}>
        <Heading level={3}>Could not load {what}</Heading>
        <Paragraph>
          <Code>{message}</Code>
        </Paragraph>
        <Paragraph>
          If this reports missing permissions, check that the app manifest grants both
          <Code> storage:logs:read</Code> and <Code>storage:buckets:read</Code> - a
          bucket-partitioned table returns zero records without the second one.
        </Paragraph>
      </Flex>
    </Surface>
  );
};
