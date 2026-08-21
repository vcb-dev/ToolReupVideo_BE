const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const sv = await prisma.source_videos.findUnique({ where: { id: 'fc5f7d12-df0c-4cca-b360-892a84953a70' }});
  console.log(sv.platform_video_id);
}
main().catch(console.error).finally(() => prisma.$disconnect());
