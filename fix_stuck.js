const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const res = await prisma.source_videos.updateMany({
    where: { status: 'processing' },
    data: { status: 'new' }
  });
  console.log("Reset", res.count, "videos to 'new'");
}
main().catch(console.error).finally(() => prisma.$disconnect());
