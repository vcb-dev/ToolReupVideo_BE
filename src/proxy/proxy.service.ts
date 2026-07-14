import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly aiUrl = process.env.AI_SERVICE_URL || 'http://127.0.0.1:5002';

  async getState() {
    try {
      const response = await axios.get(`${this.aiUrl}/api/state`);
      return response.data;
    } catch (error) {
      this.logger.error(`Error fetching state from AI Service: ${error.message}`);
      return {
        job: { running: false, kind: null, current: null, done: false, error: 'Không thể kết nối dịch vụ AI' },
        log: [`Lỗi: ${error.message}`],
        videos: [],
        default_platforms: ['facebook'],
        config_ok: false,
        config_error: `Dịch vụ AI (Python) chưa chạy hoặc lỗi: ${error.message}`,
      };
    }
  }

  async ingest(user: string, max: number, platform = 'douyin') {
    try {
      const response = await axios.post(`${this.aiUrl}/api/ingest`, {
        user,
        max,
        platform,
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Error calling ingest on AI Service: ${error.message}`);
      return {
        ok: false,
        error: error.response?.data?.error || `Không thể kết nối dịch vụ AI: ${error.message}`,
      };
    }
  }

  async select(aweme_id: string, selected: boolean) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/select`, { aweme_id, selected });
      return response.data;
    } catch (error) {
      this.logger.error(`Error calling select on AI Service: ${error.message}`);
      return {
        ok: false,
        error: error.response?.data?.error || `Không thể kết nối dịch vụ AI: ${error.message}`,
      };
    }
  }

  async process(platforms: string[], upload: boolean) {
    try {
      const response = await axios.post(`${this.aiUrl}/api/process`, { platforms, upload });
      return response.data;
    } catch (error) {
      this.logger.error(`Error calling process on AI Service: ${error.message}`);
      return {
        ok: false,
        error: error.response?.data?.error || `Không thể kết nối dịch vụ AI: ${error.message}`,
      };
    }
  }
}
