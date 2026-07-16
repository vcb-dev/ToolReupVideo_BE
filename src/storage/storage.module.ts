import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { IngestInternalController } from './ingest.controller';
import { ProcessedInternalController } from './processed.controller';

@Module({
  controllers: [StorageController, IngestInternalController, ProcessedInternalController],
  providers: [StorageService],
})
export class StorageModule {}
