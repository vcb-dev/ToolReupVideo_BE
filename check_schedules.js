const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const s = await prisma.schedules.findMany({
    orderBy: { created_at: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(s, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
