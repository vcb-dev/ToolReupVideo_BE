import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const KEY = 'delete_pin';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Mã PIN khoá thao tác XOÁ cho nhân viên. Admin bỏ qua. Lưu DB (hash sha256)
 * qua Prisma (bỏ qua RLS). Chưa đặt PIN = chưa khoá (xoá bình thường).
 */
@Injectable()
export class DeletePinService {
  constructor(private readonly prisma: PrismaService) {}

  async isSet(): Promise<boolean> {
    if (!this.prisma.enabled) return false;
    const row = await this.prisma.app_config.findUnique({ where: { key: KEY } });
    return !!row?.value;
  }

  async setPin(pin: string): Promise<void> {
    const value = sha256(String(pin));
    await this.prisma.app_config.upsert({
      where: { key: KEY },
      update: { value, updated_at: new Date() },
      create: { key: KEY, value },
    });
  }

  /** Nhân viên cần nhập PIN không (PIN đã đặt và user không phải admin). */
  async requiredFor(user: any): Promise<boolean> {
    if (user?.is_admin) return false;
    return this.isSet();
  }

  /** Ném 403 nếu nhân viên xoá mà thiếu/sai PIN. Admin & chưa đặt PIN -> cho qua. */
  async assertDeleteAllowed(user: any, pinHeader?: string): Promise<void> {
    if (user?.is_admin) return;
    if (!this.prisma.enabled) return;
    const row = await this.prisma.app_config.findUnique({ where: { key: KEY } });
    const stored = row?.value;
    if (!stored) return; // chưa đặt PIN -> chưa khoá
    if (!pinHeader || sha256(String(pinHeader)) !== stored) {
      throw new ForbiddenException('Cần đúng mã PIN để xoá.');
    }
  }
}
