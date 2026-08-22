const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const prisma = new PrismaClient();
async function main() {
  const sv = await prisma.source_videos.findUnique({ where: { id: 'fc5f7d12-df0c-4cca-b360-892a84953a70' }});
  const item = {
    source_id: sv.id,
    video_id: sv.platform_video_id,
    drive_id: sv.drive_id,
    desc: sv.descr
  };
  const payload = {
    owner_id: sv.owner_id,
    job_owner: "test-run2",
    items: [item],
    platforms: [],
    upload: true,
    config: { process: { sub_only: false } }
  };
  console.log("Triggering AI...");
  const res = await axios.post('http://127.0.0.1:5002/api/produce_batch', payload);
  console.log("Post res:", res.data);
  for (let i = 0; i < 5; i++) {
    const st = await axios.get('http://127.0.0.1:5002/api/state');
    console.log("State active:", st.data.job.active, "end_time:", st.data.job.end_time);
    await new Promise(r => setTimeout(r, 200));
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
