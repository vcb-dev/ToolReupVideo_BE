/**
 * Giờ Việt Nam cho tab "Tự động".
 *
 * VN = Asia/Ho_Chi_Minh = UTC+7 CỐ ĐỊNH, không có DST -> quy đổi bằng offset
 * hằng số là chính xác tuyệt đối, không cần thư viện timezone. Server chạy ở
 * múi giờ nào cũng ra cùng kết quả (Date của JS luôn là mốc UTC bên trong).
 */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Các phần lịch VN của một mốc thời gian. weekday: 1=Thứ 2 ... 7=Chủ nhật. */
export type VnParts = {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

/** Tách 1 mốc UTC thành ngày/giờ theo lịch VN. */
export function vnParts(at: Date): VnParts {
  // Dịch mốc đi +7h rồi đọc bằng getUTC*: ra đúng số trên đồng hồ ở VN.
  const d = new Date(at.getTime() + VN_OFFSET_MS);
  // getUTCDay: 0=CN..6=T7 -> đổi sang ISO 1=T2..7=CN.
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/**
 * Mốc UTC của "HH:MM giờ VN" trong một ngày VN cho trước.
 * `dayOffset` cộng thêm số ngày (dùng để quét các ngày tới).
 */
export function vnTimeToUtc(
  base: Date,
  hhmm: string,
  dayOffset = 0,
): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;

  const p = vnParts(base);
  // Dựng mốc bằng Date.UTC trên lịch VN rồi trừ offset để về UTC thật.
  const asVnClock = Date.UTC(p.year, p.month - 1, p.day + dayOffset, hour, minute, 0, 0);
  return new Date(asVnClock - VN_OFFSET_MS);
}

/** "HH:MM" hợp lệ? Dùng để chặn giờ rác ngay ở API. */
export function isValidHhmm(s: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}
