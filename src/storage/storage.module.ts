import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { IngestInternalController } from './ingest.controller';

@Module({
  controllers: [StorageController, IngestInternalController],
  providers: [StorageService],
})
export class StorageModule {}
