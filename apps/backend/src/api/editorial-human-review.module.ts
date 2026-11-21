import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthMiddleware } from '@postmill-ai/backend/services/auth/auth.middleware';
import { CsrfMiddleware } from '@postmill-ai/backend/services/auth/csrf.middleware';
import { OrgRbacGuard } from '@postmill-ai/backend/services/auth/rbac/org-rbac.guard';
import {
  EditorialHumanReviewService, EDITORIAL_HUMAN_REVIEW_CONFIG,
} from '@postmill-ai/backend/services/editorial/editorial-human-review.service';
import { EditorialHumanReviewController } from './routes/editorial-human-review.controller';
import { EditorialReleaseController } from './routes/editorial-release.controller';
import { EditorialReleaseService, EDITORIAL_RELEASE_CONFIG } from '@postmill-ai/backend/services/editorial/editorial-release.service';
import { editorialReleaseConfig, editorialSessionConfig } from './editorial-session-runtime';

// This is the future human-session controller registry. Keep SessionAuth/CSRF
// bound to the same controller list; no equivalent public-API registration.
export const authenticatedController = [EditorialHumanReviewController, EditorialReleaseController];

// Registered by AppModule ONLY on a full, exact test-org/target opt-in.
// Machine receiver is never registered here; release remains independently off.
@Module({
  controllers: [...authenticatedController],
  providers: [
    EditorialHumanReviewService,
    EditorialReleaseService,
    OrgRbacGuard,
    { provide: EDITORIAL_HUMAN_REVIEW_CONFIG, useFactory: () => editorialSessionConfig(process.env) },
    { provide: EDITORIAL_RELEASE_CONFIG, useFactory: () => editorialReleaseConfig(process.env) },
  ],
})
export class EditorialHumanReviewModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(...authenticatedController);
    consumer.apply(CsrfMiddleware).forRoutes(...authenticatedController);
  }
}
