import { inngest } from '@postmill-ai/nestjs-libraries/inngest/inngest.client';
import { EditorialDeliveryActivity, editorialTestDeliveryScope } from '@postmill-ai/nestjs-libraries/inngest/activities/editorial-delivery.activity';
import { InngestRunService } from '@postmill-ai/nestjs-libraries/inngest/inngest-run.service';
import { trackRun } from './track-run';

// The function is registered only on an exact test-only opt-in at bootstrap.
// A second guard at execution time prevents any default-off run-ledger writes.
export const createEditorialDeliverySweep = (
  activity: EditorialDeliveryActivity, runs: InngestRunService,
) => inngest.createFunction(
  {
    id: 'editorial-test-delivery-sweep',
    concurrency: 1,
    triggers: [{ cron: 'TZ=UTC */5 * * * *' }],
  },
  async ({ step }) => {
    if (!editorialTestDeliveryScope(process.env)) {
      return { status: 'disabled' as const };
    }
    return trackRun(step, runs, 'editorial-test-delivery-sweep', () =>
      step.run('deliver-only-test-pending', () => activity.sweep())
    );
  }
);
