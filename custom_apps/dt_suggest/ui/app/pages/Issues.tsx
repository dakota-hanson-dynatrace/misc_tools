import React, { useMemo, useState } from "react";
import { useAppFunction, useAppState, useSetAppState } from "@dynatrace-sdk/react-hooks";
import { sendIntent } from "@dynatrace-sdk/navigation";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { TitleBar } from "@dynatrace/strato-components-preview/layouts";
import { Chip, MessageContainer } from "@dynatrace/strato-components-preview/content";
import { Switch } from "@dynatrace/strato-components-preview/forms";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components-preview/tables";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { EMPTY_FINDINGS, setDismissed, type Findings, type Issue } from "../../../lib/pipeline";

const STATE_KEY = "findings";

const STATUS_CHIP: Record<Issue["status"], { label: string; color: "critical" | "warning" | "neutral" }> = {
  new: { label: "New", color: "critical" },
  recurring: { label: "Recurring", color: "warning" },
  dismissed: { label: "Dismissed", color: "neutral" },
};

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      style={{
        background: Colors.Background.Container.Neutral.Default,
        border: `1px solid ${Colors.Border.Neutral.Default}`,
        borderRadius: 8,
        padding: "12px 16px",
        flex: "1 1 180px",
      }}
    >
      <Text textStyle="small">{label}</Text>
      <Heading level={3}>{value}</Heading>
      {hint && <Text textStyle="small">{hint}</Text>}
    </div>
  );
}

function Detail({ issue }: { issue: Issue }) {
  return (
    <Flex flexDirection="column" gap={12} padding={16}>
      <Section title="Likely cause" body={issue.cause} />
      <Section title="Suggested fix" body={issue.fix} />
      <Section title="Impact" body={issue.impact} />
      <div>
        <Text textStyle="small">Endpoints</Text>
        <Flex gap={4} flexWrap="wrap" style={{ marginTop: 4 }}>
          {issue.endpoints.map((endpoint) => (
            <Chip key={endpoint}>{endpoint || "(none)"}</Chip>
          ))}
        </Flex>
      </div>
      <div>
        <Text textStyle="small">Evidence</Text>
        <Flex gap={8} flexWrap="wrap" alignItems="center" style={{ marginTop: 4 }}>
          {issue.exampleTraceIds.length === 0 && <Text textStyle="small">No sampled traces retained</Text>}
          {issue.exampleTraceIds.map((traceId) => (
            <Button
              key={traceId}
              variant="default"
              onClick={() =>
                void sendIntent(
                  { "trace.id": traceId },
                  { recommendedAppId: "dynatrace.distributedtracing", recommendedIntentId: "view-trace" },
                )
              }
            >
              {traceId.slice(0, 12)}…
            </Button>
          ))}
        </Flex>
      </div>
      <Text textStyle="small">
        First seen {new Date(issue.firstSeen).toLocaleString()} · key {issue.key}
      </Text>
    </Flex>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  if (!body) return null;
  return (
    <div>
      <Text textStyle="small">{title}</Text>
      <Paragraph>{body}</Paragraph>
    </div>
  );
}

export const Issues = () => {
  const [showDismissed, setShowDismissed] = useState(false);

  const { data: state, isLoading: stateLoading, refetch: reloadState } = useAppState({ key: STATE_KEY });
  const { execute: saveState } = useSetAppState();
  const {
    refetch: runAnalysis,
    isLoading: analyzing,
    error: analyzeError,
  } = useAppFunction({ name: "analyze" }, { autoFetch: false, autoFetchOnUpdate: false });

  const findings: Findings = useMemo(() => {
    if (!state?.value) return EMPTY_FINDINGS;
    try {
      return { ...EMPTY_FINDINGS, ...(JSON.parse(state.value) as Findings) };
    } catch {
      return EMPTY_FINDINGS;
    }
  }, [state?.value]);

  const visible = findings.issues.filter((i) => showDismissed || i.status !== "dismissed");
  const open = findings.issues.filter((i) => i.status !== "dismissed");

  async function persist(next: Findings) {
    await saveState({ key: STATE_KEY, body: { value: JSON.stringify(next) } });
    await reloadState();
  }

  async function analyze() {
    await runAnalysis();
    await reloadState();
  }

  const columns: DataTableColumnDef<Issue>[] = [
    {
      id: "rank",
      header: "#",
      accessor: "rank",
      width: 48,
    },
    {
      id: "title",
      header: "Issue",
      accessor: "title",
      width: "2fr",
    },
    {
      id: "status",
      header: "Status",
      accessor: "status",
      width: 120,
      cell: ({ rowData }) => <Chip color={STATUS_CHIP[rowData.status].color}>{STATUS_CHIP[rowData.status].label}</Chip>,
    },
    {
      id: "occurrences",
      header: "Occurrences",
      accessor: "occurrences",
      width: 130,
      columnType: "number",
    },
    {
      id: "services",
      header: "Services",
      accessor: (row) => row.services.join(", "),
      width: "1fr",
    },
    {
      id: "actions",
      header: " ",
      accessor: "key",
      width: 120,
      cell: ({ rowData }) => (
        <Button
          variant="default"
          onClick={() => void persist(setDismissed(findings, rowData.key, rowData.status !== "dismissed"))}
        >
          {rowData.status === "dismissed" ? "Restore" : "Dismiss"}
        </Button>
      ),
    },
  ];

  return (
    <Flex flexDirection="column" gap={16} padding={16}>
      <TitleBar>
        <TitleBar.Title>Chronic failure patterns</TitleBar.Title>
        <TitleBar.Subtitle>
          Recurring trace exceptions that never trigger a Davis problem, because steady-state breakage is the
          baseline.
        </TitleBar.Subtitle>
        <TitleBar.Action>
          <Flex gap={12} alignItems="center">
            <Switch value={showDismissed} onChange={setShowDismissed}>
              Show dismissed
            </Switch>
            <Button variant="accent" color="primary" onClick={() => void analyze()} disabled={analyzing}>
              {analyzing ? <ProgressCircle size="small" /> : "Analyze now"}
            </Button>
          </Flex>
        </TitleBar.Action>
      </TitleBar>

      {analyzeError && (
        <MessageContainer variant="critical">
          <MessageContainer.Title>Analysis failed</MessageContainer.Title>
          <MessageContainer.Description>{analyzeError.message}</MessageContainer.Description>
        </MessageContainer>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <Tile label="Open issues" value={String(open.length)} />
        <Tile label="New this run" value={String(open.filter((i) => i.status === "new").length)} />
        <Tile
          label="Occurrences"
          value={open.reduce((sum, i) => sum + i.occurrences, 0).toLocaleString()}
          hint={findings.lookbackHours ? `last ${findings.lookbackHours}h` : undefined}
        />
        <Tile
          label="Last analyzed"
          value={findings.lastRun ? new Date(findings.lastRun).toLocaleTimeString() : "never"}
          hint={findings.lastRun ? new Date(findings.lastRun).toLocaleDateString() : "run the analysis to start"}
        />
      </div>

      <DataTable<Issue> data={visible} columns={columns} loading={stateLoading} sortable fullWidth>
        <DataTable.ExpandableRow<Issue>>{({ row }) => <Detail issue={row} />}</DataTable.ExpandableRow>
        <DataTable.EmptyState>
          {findings.lastRun
            ? "No chronic exception patterns found in the last run."
            : 'No analysis has run yet. Select "Analyze now", or wait for the scheduled workflow.'}
        </DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
