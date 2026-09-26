export async function migrateStore() {}
export async function getJobById() { return null }
export async function getJobByIdempotency() { return null }
export async function createJob(input, jobId) { return { job_id: jobId, ...input, status: 'QUEUED' } }
export async function claimJob(jobId) { return { job_id: jobId } }
export async function updateJob() { return null }
export async function closeStore() {}