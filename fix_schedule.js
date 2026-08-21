const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  await prisma.schedules.update({
    where: { id: '6298cf74-fd99-43df-b4f3-e2649f94b461' },
    data: {
      status: 'posted',
      posted_at: new Date(),
      post_ref: '2328760787862889',
      error: null,
    },
  });
  console.log("Updated schedule status to posted!");
}
main().catch(console.error).finally(() => prisma.$disconnect());
