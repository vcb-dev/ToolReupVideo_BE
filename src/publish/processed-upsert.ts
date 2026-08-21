import { PrismaService } from '../prisma/prisma.service';

/** Dữ liệu ghi cho 1 thành phẩm (khớp cột processed_videos). */
export type ProcessedInput = {
  owner_id: string;
  source_video_id: string;
  final_path?: string | null;
  final_drive_id?: string | null;
  target_lang?: string | null;
  voice_id?: string | null;
  has_subtitle?: boolean;
  ai_caption?: string | null;
};

/**
 * Ghi 1 thành phẩm vào kho — KHÔNG BAO GIỜ đẻ ra hai dòng cho cùng một video.
 *
 * Khoá tự nhiên là (source_video_id, file đầu ra). Tên file đầu ra tất định
 * ('<platform_video_id>_vi.mp4') nên sản xuất lại chính video đó sẽ trúng dòng
 * cũ -> CẬP NHẬT dòng đó. Có unique index cùng khoá ở DB (migration 0024) làm
 * hàng rào thật: hai tiến trình BE ghi cùng lúc thì một bên nhận P2002 và
 * chuyển sang cập nhật, thay vì cả hai cùng chèn (đúng lỗi đo được 2026-08-21:
 * 2 dòng y hệt nhau, created_at trùng tới từng mili giây).
 */
export async function upsertProcessed(
  prisma: PrismaService,
  input: ProcessedInput,
): Promise<any> {
  const key = input.final_drive_id ?? input.final_path ?? '';
  const data = {
    owner_id: input.owner_id,
    source_video_id: input.source_video_id,
    final_path: input.final_path ?? null,
    final_drive_id: input.final_drive_id ?? null,
    target_lang: input.target_lang || 'vi',
    voice_id: input.voice_id ?? null,
    has_subtitle: !!input.has_subtitle,
    ai_caption: input.ai_caption ?? null,
    status: 'done' as const,
    produced_at: new Date(),
  };

  const existing = await findByKey(prisma, input.source_video_id, key);
  if (existing) {
    return prisma.processed_videos.update({
      where: { id: existing.id },
      data: keepCaption(data, existing),
    });
  }
  try {
    return await prisma.processed_videos.create({ data });
  } catch (e: any) {
    // Tiến trình khác vừa chèn xong giữa lúc mình kiểm tra -> lấy dòng của họ.
    if (e?.code !== 'P2002') throw e;
    const other = await findByKey(prisma, input.source_video_id, key);
    if (!other) throw e;
    return prisma.processed_videos.update({
      where: { id: other.id },
      data: keepCaption(data, other),
    });
  }
}

/** Lượt ghi không kèm caption thì GIỮ caption cũ, đừng xoá công AI đã viết. */
function keepCaption(data: any, existing: any) {
  return data.ai_caption?.trim() ? data : { ...data, ai_caption: existing.ai_caption };
}

/** Tìm theo khoá tự nhiên; khớp cả hai cột file để giống hệt unique index. */
function findByKey(prisma: PrismaService, sourceId: string, key: string) {
  return prisma.processed_videos.findFirst({
    where: {
      source_video_id: sourceId,
      OR: key
        ? [{ final_drive_id: key }, { final_drive_id: null, final_path: key }]
        : [{ final_drive_id: null, final_path: null }],
    },
    orderBy: { created_at: 'asc' },
  });
}
