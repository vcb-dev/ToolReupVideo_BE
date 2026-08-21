const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const pvs = await prisma.processed_videos.findMany({ take: 1 });
  console.log(pvs);
}
main().catch(console.error).finally(() => prisma.$disconnect());
