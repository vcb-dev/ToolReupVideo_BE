import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return {
      ok: true,
      service: 'toolreup-video-be',
      ts: new Date().toISOString(),
    };
  }
}
