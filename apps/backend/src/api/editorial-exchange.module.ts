import { Module } from '@nestjs/common';
import { EditorialExchangeController, EDITORIAL_EXCHANGE_CONFIG } from './routes/editorial-exchange.controller';
import { EditorialExchangeService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-exchange.service';
import { editorialMachineConfig } from './editorial-machine-runtime';

// Imported by AppModule only for a complete, explicitly enabled test-channel
// configuration. With any missing or invalid scope the module is not mounted.
// This does not enable review transport, final release, or any publishing.
@Module({
  controllers: [EditorialExchangeController],
  providers: [
    EditorialExchangeService,
    { provide: EDITORIAL_EXCHANGE_CONFIG, useFactory: () => editorialMachineConfig(process.env) },
  ],
})
export class EditorialExchangeModule {}
