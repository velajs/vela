/**
 * The schedule panel: `schedule.jobs` (cron/interval badge, the expression or ms
 * period, and the server-synthesized last/next run) plus `schedule.triggers`.
 * A run-now button renders only when `writes.opsEditable` is open.
 */
import type { ReactNode } from 'react';
import type { ScheduleJobRow } from '@velajs/studio-protocol';
import { useStudioCapabilities } from '../data/capabilities';
import { useAdminMutation, useAdminQuery } from '../data/query';
import { Panel, QueryView, Badge } from './shared';
import { formatTimestamp } from './format';

function jobSchedule(job: ScheduleJobRow): string {
  if (job.kind === 'cron') return job.expression ?? '—';
  return job.ms !== undefined ? `every ${job.ms} ms` : '—';
}

function JobsTable({ rows, canRun }: { rows: ScheduleJobRow[]; canRun: boolean }): ReactNode {
  const runNow = useAdminMutation('schedule.runNow', { invalidates: ['schedule.jobs'] });
  return (
    <table className="vela-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Kind</th>
          <th>Schedule</th>
          <th>Last run</th>
          <th>Next run</th>
          {canRun ? <th>Actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((job) => (
          <tr key={job.name}>
            <td className="vela-mono">{job.name}</td>
            <td>
              <Badge tone={job.kind === 'cron' ? 'accent' : 'neutral'}>{job.kind}</Badge>
            </td>
            <td className="vela-mono">{jobSchedule(job)}</td>
            <td className="vela-mono">{formatTimestamp(job.lastRun)}</td>
            <td className="vela-mono">{formatTimestamp(job.nextRun)}</td>
            {canRun ? (
              <td>
                <button
                  type="button"
                  className="vela-btn"
                  disabled={runNow.isPending}
                  onClick={() => runNow.mutate({ id: job.name })}
                >
                  Run now
                </button>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SchedulePanel(): ReactNode {
  const { capabilities } = useStudioCapabilities();
  const canRun = capabilities.writes.opsEditable;
  const jobs = useAdminQuery('schedule.jobs', {});
  const triggers = useAdminQuery('schedule.triggers', {});

  return (
    <Panel title="Schedule" description="Scheduled jobs and declared cron triggers.">
      <section className="vela-card">
        <h2 className="vela-card__title">Jobs</h2>
        <QueryView
          result={jobs}
          isEmpty={(rows) => rows.length === 0}
          emptyLabel="No scheduled jobs."
        >
          {(rows) => <JobsTable rows={rows} canRun={canRun} />}
        </QueryView>
      </section>
      <section className="vela-card">
        <h2 className="vela-card__title">Triggers</h2>
        <QueryView
          result={triggers}
          isEmpty={(rows) => rows.length === 0}
          emptyLabel="No cron triggers."
        >
          {(rows) => (
            <table className="vela-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Cron</th>
                  <th>Next run</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((trigger) => (
                  <tr key={trigger.name}>
                    <td className="vela-mono">{trigger.name}</td>
                    <td className="vela-mono">{trigger.cron}</td>
                    <td className="vela-mono">{formatTimestamp(trigger.nextRun)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryView>
      </section>
    </Panel>
  );
}
