import pg from "pg"
const { Pool }=pg
const databaseUrl=process.env.ADAPTER_DATABASE_URL
if(!databaseUrl)throw new Error("ADAPTER_DATABASE_URL is required")
const sslMode=process.env.ADAPTER_DATABASE_SSL
const rejectUnauthorized=process.env.ADAPTER_DATABASE_SSL_REJECT_UNAUTHORIZED==="true"
const pool=new Pool({connectionString:databaseUrl,max:Number(process.env.ADAPTER_DB_POOL_SIZE||10),ssl:sslMode==="false"?false:{rejectUnauthorized,...(process.env.ADAPTER_DATABASE_SSL_CA?{ca:process.env.ADAPTER_DATABASE_SSL_CA}:{})}})
export async function migrateStore(){
 await pool.query("CREATE TABLE IF NOT EXISTS adapter_jobs(job_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,tenant_id TEXT NOT NULL,tenant_slug TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,step TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,input JSONB NOT NULL,resource JSONB,result JSONB,error_code TEXT,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),started_at TIMESTAMPTZ,completed_at TIMESTAMPTZ); CREATE INDEX IF NOT EXISTS adapter_jobs_tenant_idx ON adapter_jobs(tenant_id,created_at DESC); CREATE INDEX IF NOT EXISTS adapter_jobs_status_idx ON adapter_jobs(status,updated_at)")
}
export async function recoverInterruptedJobs(){
  await pool.query("UPDATE adapter_jobs SET status='FAILED_RETRYABLE',step='FAILED',error_code='ADAPTER_RESTARTED',error_message='Adapter restarted before this provisioning execution completed.',completed_at=NOW(),updated_at=NOW() WHERE status IN ('QUEUED','RUNNING','RETRY_WAIT')")
}
export async function getJobById(id){const r=await pool.query("SELECT * FROM adapter_jobs WHERE job_id=$1",[id]);return r.rows[0]||null}
export async function getJobByIdempotency(key){const r=await pool.query("SELECT * FROM adapter_jobs WHERE idempotency_key=$1",[key]);return r.rows[0]||null}
export async function createJob(input,jobId){const {secret:_secret,...safeInput}=input;const r=await pool.query("INSERT INTO adapter_jobs(job_id,idempotency_key,tenant_id,tenant_slug,provider,status,step,input,attempt) VALUES($1,$2,$3,$4,$5,'QUEUED','QUEUED',$6,0) ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=NOW() RETURNING *",[jobId,input.idempotencyKey,input.tenantId,input.tenantSlug,input.provider,JSON.stringify(safeInput)]);return r.rows[0]}
export async function claimJob(jobId){const r=await pool.query("UPDATE adapter_jobs SET status='RUNNING',step='CREATING',attempt=attempt+1,started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE job_id=$1 AND status IN ('QUEUED','RETRY_WAIT','FAILED_RETRYABLE') RETURNING *",[jobId]);return r.rows[0]||null}
export async function updateJob(jobId,patch){const map={status:"status",step:"step",resource:"resource",result:"result",errorCode:"error_code",errorMessage:"error_message",startedAt:"started_at",completedAt:"completed_at"};const parts=[],values=[];let i=1;for(const[k,v]of Object.entries(patch)){if(!map[k])continue;parts.push(map[k]+"=$"+i++);values.push(v&&typeof v==="object"&&!(v instanceof Date)?JSON.stringify(v):v)}if(!parts.length)return getJobById(jobId);parts.push("updated_at=NOW()");values.push(jobId);const r=await pool.query("UPDATE adapter_jobs SET "+parts.join(",")+" WHERE job_id=$"+i+" RETURNING *",values);return r.rows[0]||null}
export async function deleteJob(jobId){const r=await pool.query("DELETE FROM adapter_jobs WHERE job_id=$1 AND status IN ('FAILED_RETRYABLE','FAILED_FATAL') RETURNING job_id",[jobId]);return Boolean(r.rows[0])}
export async function closeStore(){await pool.end()}