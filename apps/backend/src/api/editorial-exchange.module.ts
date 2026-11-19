import { Module } from '@nestjs/common';
import { EditorialExchangeController, EDITORIAL_EXCHANGE_CONFIG } from './routes/editorial-exchange.controller';
import { EditorialExchangeService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-exchange.service';

// Inactive by construction: no imports in AppModule/ApiModule, nor credential
// source. Runtime registration, target mapping, secret lifecycle and proxy /
// telemetry qualification require a separately reviewed activation.
@Module({
  controllers: [EditorialExchangeController],
  providers: [
    EditorialExchangeService,
    { provide: EDITORIAL_EXCHANGE_CONFIG, useValue: null },
  ],
})
export class EditorialExchangeModule {}
