import { inngest } from '@postmill-ai/nestjs-libraries/inngest/inngest.client';
import { EditorialDeliveryActivity } from '@postmill-ai/nestjs-libraries/inngest/activities/editorial-delivery.activity';
import { InngestRunService } from '@postmill-ai/nestjs-libraries/inngest/inngest-run.service';
import { trackRun } from './track-run';

// The function is registered in every image but is a no-op without the
// exact server-side org/target gate and mounted read-only HMAC key files.
export const createEditorialDeliverySweep = (
  activity: EditorialDeliveryActivity, runs: InngestRunService,
) => inngest.createFunction(
  {
    id: 'editorial-test-delivery-sweep',
    concurrency: 1,
    triggers: [{ cron: 'TZ=UTC */5 * * * *' }],
  },
  async ({ step }) =>
    trackRun(step, runs, 'editorial-test-delivery-sweep', () =>
      step.run('deliver-only-test-pending', () => activity.sweep())
    )
);
