const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const prisma = new PrismaClient();

async function main() {
  const schedule = await prisma.schedules.findFirst({
    where: { status: 'failed' },
    orderBy: { created_at: 'desc' }
  });
  
  if (!schedule) {
    console.log("No failed schedule found");
    return;
  }
  
  console.log("Found failed schedule:", schedule.id);
  
  let driveId = null;
  let localPath = null;
  
  if (schedule.processed_video_id) {
    const pv = await prisma.processed_videos.findUnique({ where: { id: schedule.processed_video_id }});
    driveId = pv.final_drive_id;
    localPath = pv.final_path;
  }
  
  const page = await prisma.pages.findUnique({ where: { id: schedule.page_id }});
  let target = { platform: page.platform, provider: page.provider };
  if (page.provider === 'facebook_graph') {
    const cred = await prisma.page_credentials.findUnique({ where: { page_id: page.id }});
    target.page_id = cred.external_id;
    target.page_token = cred.access_token;
  }
  
  const payload = {
    final_drive_id: driveId,
    final_path: localPath,
    post_target: target,
    title: schedule.caption || '',
    description: schedule.caption || ''
  };
  
  console.log("Payload to AI:", JSON.stringify(payload, null, 2).substring(0, 500) + '...');
  
  try {
    const res = await axios.post('http://127.0.0.1:5002/api/post', payload);
    console.log("Response:", res.data);
  } catch (err) {
    console.error("Error from AI:", err.response ? err.response.data : err.message);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
