const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const svs = await prisma.source_videos.findMany({
    orderBy: { updated_at: 'desc' },
    take: 5,
    include: { processed: true }
  });
  console.log(JSON.stringify(svs.map(s => ({id: s.id, status: s.status, updated_at: s.updated_at, processed_count: s.processed.length})), null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
